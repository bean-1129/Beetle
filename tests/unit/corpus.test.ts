// Model-output corpus replay. Owner: corpus / validator fuzzing.
// Every stored sample (tests/fixtures/corpus/{draft,patch,probe}/*.json, built by scripts/build-corpus.ts) is pushed
// through the same boundary the server uses: JSON.parse -> zod -> expandDraft / applyPatch -> validateSpec ->
// compileWorld -> runPlayabilityChecks. The pipeline must never throw on model output, and every rejection must carry
// at least one issue with a known code and an objectIds array. An exception here is a real defect in packages/world:
// report it with the sample file and stack; do not patch the world package from this test.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PatchDraftSchema, VALIDATION_CODES, WorldDraftSchema } from '@beetle/contracts';
import { applyPatch, compileWorld, expandDraft, fixtureWorld, runPlayabilityChecks, validateSpec } from '@beetle/world';

type Stored = {
  id: string; kind: 'draft' | 'patch'; promptId: string; temperature: number; rawContent: string;
  outcome: string; parse: { ok: boolean }; zod: { ok: boolean };
  pipeline: { validate?: { ok: boolean }; playability?: { ok: boolean } };
  exception?: { step: string; message: string };
};

const ROOT = resolve(__dirname, '../fixtures/corpus');
const DIRS = ['draft', 'patch', 'probe'] as const;
const codeSet = new Set<string>(VALIDATION_CODES);

function loadSamples(): { file: string; sample: Stored }[] {
  const out: { file: string; sample: Stored }[] = [];
  for (const d of DIRS) {
    const dir = resolve(ROOT, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const file = resolve(dir, f);
      out.push({ file, sample: JSON.parse(readFileSync(file, 'utf8')) as Stored });
    }
  }
  return out;
}

const garden5 = fixtureWorld('garden5');
const samples = loadSamples();
const rel = (file: string) => file.slice(file.indexOf('tests/fixtures'));

/** Runs one sample through the boundary. Returns the stage outcome; throws only if a world function throws. */
function replay(s: Stored): { stage: string; ok: boolean; issues: { code: string; objectIds: string[] }[]; normalizations?: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(s.rawContent); } catch { return { stage: 'parse', ok: false, issues: [{ code: 'INVALID_SCHEMA', objectIds: [] }] }; }
  // zod at the boundary: safeParse must never throw on arbitrary JSON.
  const z = (s.kind === 'draft' ? WorldDraftSchema : PatchDraftSchema).safeParse(parsed);
  // expandDraft / applyPatch re-validate at their own boundary and are fed the raw parsed value, as the server does.
  const stage1 = s.kind === 'draft' ? expandDraft(parsed, { seed: 12345, worldId: 'corpus' }) : applyPatch(garden5, parsed as never);
  // The world boundary normalizes model output first (packages/world/src/normalize.ts: names and compass words to
  // ids, world coordinates and over-radius offsets, clamped widths and radii, separated islands), so it may accept
  // what the raw zod schema rejects. The raw zod verdict is kept only for the report; it is not an oracle here.
  void z;
  if (!stage1.ok) return { stage: s.kind === 'draft' ? 'expandDraft' : 'applyPatch', ok: false, issues: stage1.issues };
  expect(Array.isArray(stage1.normalizations), `${s.id}: ok result without a normalizations array`).toBe(true);
  const v = validateSpec(stage1.spec);
  if (!v.ok) return { stage: 'validateSpec', ok: false, issues: v.issues };
  expect(v.issues).toEqual([]);
  const compiled = compileWorld(stage1.spec);
  const p = runPlayabilityChecks(compiled);
  if (!p.ok) return { stage: 'playability', ok: false, issues: p.checks.filter((c) => !c.ok).map((c) => ({ code: 'PLAYABILITY:' + c.name, objectIds: c.objectIds })), normalizations: stage1.normalizations.length };
  return { stage: 'valid', ok: true, issues: [], normalizations: stage1.normalizations.length };
}

describe('model-output corpus', () => {
  it('has stored samples (run scripts/build-corpus.ts first)', () => {
    expect(samples.length, 'no samples under tests/fixtures/corpus; run: npx tsx scripts/build-corpus.ts').toBeGreaterThan(0);
  });

  it('summary.json counts the draft and patch files actually present', () => {
    const summaryPath = resolve(ROOT, 'summary.json');
    if (!existsSync(summaryPath)) return;
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as { completed: number };
    const present = samples.filter(({ file }) => !file.includes('/probe/')).length;
    expect(summary.completed).toBe(present);
  });

  for (const { file, sample } of samples) {
    it(`${sample.kind} ${sample.id} (${sample.promptId} @${sample.temperature}): pipeline never throws, rejections carry coded issues`, () => {
      let result: ReturnType<typeof replay>;
      try {
        result = replay(sample);
      } catch (e) {
        const err = e as Error;
        // Deliberately loud: the file name and the stack are the report for the world reviewer.
        throw new Error(`world pipeline threw on ${rel(file)}: ${err.message}\n${err.stack}`);
      }
      if (result.ok) {
        expect(result.stage).toBe('valid');
        return;
      }
      expect(result.issues.length, `${rel(file)}: rejected at ${result.stage} without any issue`).toBeGreaterThan(0);
      for (const issue of result.issues) {
        if (result.stage !== 'playability') expect(codeSet.has(issue.code), `${rel(file)}: unknown code ${issue.code}`).toBe(true);
        expect(Array.isArray(issue.objectIds), `${rel(file)}: issue ${issue.code} has no objectIds array`).toBe(true);
      }
      // Validator-stage rejections (past the schema boundary) must name the objects involved so the agent can repair.
      if (result.stage === 'validateSpec' || result.stage === 'playability') {
        expect(result.issues.some((i) => i.objectIds.length > 0), `${rel(file)}: ${result.stage} rejection names no object ids`).toBe(true);
      }
    });
  }

  it('no sample that validated when stored is rejected now (validator or normaliser regression guard)', () => {
    // packages/world evolves (normalize.ts grows, the validator tightens), so stored verdicts can drift. Drift towards
    // "valid" is logged; drift towards "rejected" fails, because it is either a regression or a deliberate tightening
    // that needs the corpus summary rebuilt: CORPUS_RESUME=1 CORPUS_BUDGET_SEC=0 CORPUS_PROBE=0 npx tsx scripts/build-corpus.ts
    const regressions: string[] = [];
    const improvements: string[] = [];
    for (const { file, sample } of samples) {
      if (sample.outcome === 'http_error' || sample.exception) continue;
      let r: ReturnType<typeof replay>;
      try { r = replay(sample); } catch { continue; } // reported by the per-sample test above
      const storedValid = sample.outcome === 'valid';
      // Deliberate tightening after the corpus was stored: BRIDGE_DUPLICATE (an alternative route may not duplicate an existing bridge).
      const onlyTightening = !r.ok && r.issues.length > 0 && r.issues.every((i) => i.code === 'BRIDGE_DUPLICATE');
      if (storedValid && !r.ok && !onlyTightening) regressions.push(`${rel(file)}: stored valid, replay rejected at ${r.stage} (${r.issues.map((i) => i.code).join(', ')})`);
      if (!storedValid && r.ok) improvements.push(`${rel(file)}: stored ${sample.outcome}, replay valid`);
    }
    if (improvements.length) console.info(`corpus: ${improvements.length} stored rejections now validate (normaliser or validator changed); rebuild the summary.\n${improvements.join('\n')}`);
    expect(regressions).toEqual([]);
  });
});
