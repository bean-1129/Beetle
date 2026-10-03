// Build the model-output corpus: call Ollama directly with the current agent prompts, store every raw sample together
// with its parse, zod and world-pipeline outcome, and write tests/fixtures/corpus/summary.json.
//
//   export PATH=/home/dell/Beetle/.tools/node/bin:$PATH
//   npx tsx scripts/build-corpus.ts            # BEETLE_MODEL (default qwen3.5:4b), OLLAMA_BASE_URL
//   CORPUS_BUDGET_SEC=1080 CORPUS_CONCURRENCY=4 CORPUS_SAMPLES=3 CORPUS_TEMPS=0.4,0.8 npx tsx scripts/build-corpus.ts
//
// Never starts the Beetle server. Never edits packages/*. Every exception thrown by the world pipeline is recorded on
// the sample (field `exception`) and listed in summary.json so the world reviewer can see it; nothing is patched here.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PATCH_DRAFT_JSON_SCHEMA, PatchDraftSchema, WORLD_DRAFT_JSON_SCHEMA, WorldDraftSchema, type ValidationIssue,
} from '@beetle/contracts';
import {
  applyPatch, buildSessionSummary, compileWorld, expandDraft, fixtureWorld, runPlayabilityChecks, validateSpec,
} from '@beetle/world';
import { worldDraftSystemPrompt, patchDraftSystemPrompt, briefUserPrompt, editUserPrompt } from '../packages/agent/src/prompts.ts';

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.BEETLE_MODEL ?? 'qwen3.5:4b';
const CONCURRENCY = Math.max(1, Number(process.env.CORPUS_CONCURRENCY ?? 4));
const SAMPLES = Math.max(1, Number(process.env.CORPUS_SAMPLES ?? 3));
const TEMPS = (process.env.CORPUS_TEMPS ?? '0.4,0.8').split(',').map(Number);
const BUDGET_SEC = Number(process.env.CORPUS_BUDGET_SEC ?? 1200);
const REQUEST_TIMEOUT_MS = Number(process.env.CORPUS_REQUEST_TIMEOUT_MS ?? 240_000);
const PROBE = process.env.CORPUS_PROBE !== '0';
// CORPUS_RESUME=1 keeps stored samples that are not http_error and only re-runs the missing or failed ones.
const RESUME = process.env.CORPUS_RESUME === '1';
const RETRY_MAX = Math.max(0, Number(process.env.CORPUS_RETRY_MAX ?? 8));
const RETRY_DELAY_MS = Number(process.env.CORPUS_RETRY_DELAY_MS ?? 5000);
const PROBE_N = Math.max(1, Number(process.env.CORPUS_PROBE_N ?? CONCURRENCY));
const OUT = resolve(process.cwd(), 'tests/fixtures/corpus');
const NUM_CTX = 8192;
const NUM_PREDICT = { draft: 2048, patch: 1536 } as const;

type Kind = 'draft' | 'patch';

// ---- prompts (own design; the edits target the garden5 fixture by its display names, which is what a director does) ----
const BRIEFS: { id: string; text: string; note: string }[] = [
  { id: 'b01', note: 'diamond, four islands, two routes', text: 'Four islands arranged in a diamond with water below. Both spawns on the west island, the gate on the east island, one relic each on the north, south and west islands. Bridge every island to its two ring neighbours so there are two ways round. Title it "Diamond Pond".' },
  { id: 'b02', note: 'six-island chain, lava, decorations at edges', text: 'A chain of six small islands running from the south-west corner to the north-east corner, each linked to the next by one bridge, lava below. Spawns on the first island, the gate on the last, relics on the second, fourth and fifth islands. A few rocks and bushes at the edges, never on the bridges. Title "Ember Causeway".' },
  { id: 'b03', note: 'hub and four compass islands', text: 'Five islands: a big hearth island in the middle and four smaller islands at the compass points about 25 metres out. The temple with the gate is to the north. One relic on each of the east, west and south islands. Water below, a couple of trees and lanterns.' },
  { id: 'b04', note: 'eight-island ring, upper island count', text: 'Eight islands in a ring around an empty centre, radius about 30 metres from the origin, each bridged to its two neighbours. Lava below. The gate on the northernmost island, relics on three islands spread evenly around the ring, both spawns on the southernmost island. A lantern on every island.' },
  { id: 'b05', note: 'west-to-east row of four', text: 'Four islands in a straight row from west to east, 24 metres apart. Spawns on the first island, the gate on the last. Relics: one on the first island, one on the second, one on the third. Water. Title "Causeway".' },
  { id: 'b06', note: 'hub with three spokes plus a tiny gate island', text: 'A hub island of radius 12 at the centre with three spoke islands 30 metres out to the north-west, north-east and south, each holding one relic. A fourth tiny island of radius 5 hangs off the east side of the north-east island and holds the gate. Water below, a shrine on the hub.' },
  { id: 'b07', note: 'tight small islands, loops, many decorations', text: 'A compact map of six small islands (radius 5 each) packed tightly together so every bridge is short, and every island has two bridges so the whole map is a loop. Lava below. Twenty bushes and rocks scattered around, but keep the bridge mouths clear. Spawns on one island, the gate on the island opposite, relics on three others.' },
  { id: 'b08', note: 'far corners, long bridges', text: 'Spread four islands to the far corners of the map near (45, 45), (-45, 45), (-45, -45) and (45, -45) with long bridges from each corner to a central hub island. Water. Spawns on the hub, the gate on the north-east corner, relics on the other three corners.' },
  { id: 'b09', note: 'two rows, pillars at bridge mouths', text: 'A two-tier layout: a north row of three islands and a south row of three islands, bridges along each row and between the rows. Both spawns on the south-west island, the gate on the north-east island, relics on the south-east, north-west and north-middle islands. Water. Put a pillar beside every bridge mouth. Title "Twin Rows".' },
  { id: 'b10', note: 'minimal world', text: 'Minimal world: exactly four islands, no decorations at all, one bridge between each island and the next in a line, water, title "Bare Bones". Spawns on the first island, gate on the last, relics on the middle two islands and one more on the first.' },
  { id: 'b11', note: 'spiral of seven, shrines everywhere', text: 'Title "Ember Spiral": seven islands spiralling outward from the centre island, each bridged to the previous one, lava below, a shrine on every island, the gate on the last island of the spiral, relics on the third, fifth and sixth islands, spawns on the centre island.' },
  { id: 'b12', note: 'world coordinates given explicitly (localPosition trap)', text: 'Put the hearth island at world position (0, 0) with radius 10 and the temple island at world position (0, 30) with radius 8, and bridge them. Add an orchard island at (26, 0) and a quarry island at (-26, 0), each bridged to the hearth. Place the spawns at world positions (-2, -2) and (2, -2), the gate at (0, 24) on the temple, and relics at (26, 2), (-26, 2) and (0, -4). Water. Title "Measured Garden".' },
];

const EDITS: { id: string; text: string; note: string }[] = [
  { id: 'e01', note: 'pass expected: add bridge east to south, retitle', text: 'Add a second route: a 3 metre wide bridge from the Orchard Island in the east straight to the Lantern Island in the south, and retitle the world "Orchard Loop".' },
  { id: 'e02', note: 'UNREACHABLE_RELIC unless another bridge is added', text: 'Remove the narrow western bridge, but keep the Moon Relic collectable.' },
  { id: 'e03', note: 'GATE_HIDES_RELIC expected', text: 'Move the Sun Relic onto the Temple Island, right beside the shrine.' },
  { id: 'e04', note: '8 ops, truncation risk', text: 'Plant a ring of six bushes around the edge of the Hearth Island, well clear of the four bridge mouths, and add one lantern next to each spawn.' },
  { id: 'e05', note: 'pass expected: set_hazard and set_title', text: 'Make the fall deadly: the hazard beneath the islands becomes lava. Rename the world "Ember Garden" to match.' },
  { id: 'e06', note: 'BRIDGE_CROSSES_ISLAND expected', text: 'Add a straight bridge from the Orchard Island in the east directly across to the Mossy Island in the west.' },
  { id: 'e07', note: 'remove_decoration rock-1 then add_decoration shrine', text: 'Remove the rock on the Orchard Island and put a shrine in its place.' },
  { id: 'e08', note: 'move_relic and move_decoration', text: 'Move the Star Relic to the Mossy Island, next to the pillar, and nudge the pillar one metre north.' },
  { id: 'e09', note: 'BRIDGE_LENGTH or BRIDGE_CROSSES_ISLAND expected', text: 'Add a direct bridge from the Lantern Island in the south all the way to the Temple Island in the north.' },
  { id: 'e10', note: '12 decorations near the rim (OBJECT_NOT_ON_SURFACE and truncation risk)', text: 'Decorate the Temple Island with twelve trees spaced evenly around its rim.' },
  { id: 'e11', note: 'UNREACHABLE_RELIC x3 expected', text: 'Remove every bridge except the one that leads to the temple.' },
  { id: 'e12', note: 'mixed 6-op patch, lanterns at bridge mouths', text: 'Swap the hazard to lava, retitle the world "Lava Garden", and add a lantern just inside each of the four bridge mouths on the Hearth Island.' },
];

// ---- garden5 baseline and the agent prompts (imported read-only from packages/agent) ----
const garden5 = fixtureWorld('garden5');
const compiledGarden5 = compileWorld(garden5);
const garden5Summary = buildSessionSummary(compiledGarden5, {
  worldVersion: garden5.worldVersion, elapsedMs: 0, players: [], collectedRelicIds: [], gateUnlocked: false, won: false, score: 0,
});
const SYSTEM: Record<Kind, string> = {
  draft: worldDraftSystemPrompt(),
  patch: patchDraftSystemPrompt({ spec: garden5, summary: garden5Summary }),
};

// ---- Ollama ----
type ChatStats = {
  status: number; wallMs: number; totalDurationMs: number | null; loadMs: number | null; promptEvalMs: number | null; evalMs: number | null;
  promptTokens: number | null; outputTokens: number | null; doneReason: string | null; queueWaitMs: number | null; error?: string;
};
async function chat(kind: Kind, user: string, temperature: number): Promise<{ content: string; stats: ChatStats }> {
  const body = {
    model: MODEL, stream: false, think: false,
    format: kind === 'draft' ? WORLD_DRAFT_JSON_SCHEMA : PATCH_DRAFT_JSON_SCHEMA,
    messages: [{ role: 'system', content: SYSTEM[kind] }, { role: 'user', content: kind === 'draft' ? briefUserPrompt(user) : editUserPrompt(user) }],
    options: { temperature, num_ctx: NUM_CTX, num_predict: NUM_PREDICT[kind] },
    keep_alive: '30m',
  };
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const wallMs = Math.round(performance.now() - t0);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    const ns = (v: unknown) => (typeof v === 'number' ? Math.round(v / 1e6) : null);
    const stats: ChatStats = {
      status: res.status, wallMs,
      totalDurationMs: ns(json?.total_duration), loadMs: ns(json?.load_duration), promptEvalMs: ns(json?.prompt_eval_duration), evalMs: ns(json?.eval_duration),
      promptTokens: typeof json?.prompt_eval_count === 'number' ? json.prompt_eval_count : null,
      outputTokens: typeof json?.eval_count === 'number' ? json.eval_count : null,
      doneReason: typeof json?.done_reason === 'string' ? json.done_reason : null,
      queueWaitMs: null,
    };
    // Ollama's total_duration starts when the request is received and includes time spent queued behind other
    // requests (its own num_parallel limit, and other clients on the same daemon). Compute is load + prompt eval + eval.
    if (stats.totalDurationMs !== null) stats.queueWaitMs = Math.max(0, stats.totalDurationMs - (stats.loadMs ?? 0) - (stats.promptEvalMs ?? 0) - (stats.evalMs ?? 0));
    if (res.status !== 200 || !json) stats.error = `http ${res.status}: ${text.slice(0, 300)}`;
    return { content: String(json?.message?.content ?? ''), stats };
  } catch (e) {
    return { content: '', stats: { status: 0, wallMs: Math.round(performance.now() - t0), totalDurationMs: null, loadMs: null, promptEvalMs: null, evalMs: null, promptTokens: null, outputTokens: null, doneReason: null, queueWaitMs: null, error: String((e as Error)?.message ?? e) } };
  }
}

// ---- pipeline (every step guarded; an exception is a defect and is recorded, never hidden) ----
type IssueRec = { code: string; message: string; objectIds: string[]; evidence?: Record<string, unknown> };
type ZodRec = { path: string; message: string; code: string };
type Exception = { step: string; message: string; stack: string };
/** Mirror of packages/world normalize.ts Normalization: a mechanical correction the world boundary applied before the schema. */
type Normalization = { path: string; from: unknown; to: unknown; reason: string };
type Sample = {
  id: string; kind: Kind; promptId: string; promptNote: string; prompt: string; temperature: number; sampleIndex: number; phase: string;
  model: string; request: { numCtx: number; numPredict: number; format: string; systemPromptChars: number };
  timing: ChatStats & { inFlightAtStart: number; startedAtMs: number; retries: number };
  rawContent: string; rawChars: number;
  parse: { ok: boolean; error?: string };
  zod: { ok: boolean; issues: ZodRec[] };
  pipeline: {
    expand?: { ok: boolean; issues: IssueRec[]; normalizations?: Normalization[] };
    apply?: { ok: boolean; issues: IssueRec[]; changedIds?: string[]; opNames?: string[]; normalizations?: Normalization[] };
    validate?: { ok: boolean; issues: IssueRec[] };
    playability?: { ok: boolean; failedChecks: { name: string; detail: string; objectIds: string[] }[] };
  };
  outcome: 'valid' | 'http_error' | 'invalid_parse' | 'invalid_schema' | 'invalid_expand' | 'invalid_apply' | 'invalid_validator' | 'invalid_playability' | 'exception';
  failureModes: string[];
  exception?: Exception;
};

const toIssueRec = (i: ValidationIssue): IssueRec => ({ code: i.code, message: i.message, objectIds: i.objectIds ?? [], ...(i.evidence ? { evidence: i.evidence } : {}) });

function runPipeline(kind: Kind, parsed: unknown, sample: Sample): void {
  const guard = <T>(step: string, fn: () => T): T | undefined => {
    try { return fn(); } catch (e) {
      const err = e as Error;
      sample.exception = { step, message: String(err?.message ?? err), stack: String(err?.stack ?? '') };
      sample.outcome = 'exception';
      return undefined;
    }
  };
  let spec: unknown = null;
  if (kind === 'draft') {
    const r = guard('expandDraft', () => expandDraft(parsed, { seed: 12345, worldId: 'corpus' }));
    if (!r) return;
    sample.pipeline.expand = { ok: r.ok, issues: r.ok ? [] : r.issues.map(toIssueRec), ...(r.ok ? { normalizations: (r as { normalizations?: Normalization[] }).normalizations ?? [] } : {}) };
    if (!r.ok) { sample.outcome = 'invalid_expand'; return; }
    spec = r.spec;
  } else {
    const r = guard('applyPatch', () => applyPatch(garden5, parsed as any));
    if (!r) return;
    const opNames = Array.isArray((parsed as any)?.ops) ? (parsed as any).ops.map((o: any) => String(o?.op)) : undefined;
    sample.pipeline.apply = { ok: r.ok, issues: r.ok ? [] : r.issues.map(toIssueRec), ...(r.ok ? { changedIds: r.changedIds, normalizations: (r as { normalizations?: Normalization[] }).normalizations ?? [] } : {}), opNames };
    if (!r.ok) { sample.outcome = 'invalid_apply'; return; }
    spec = r.spec;
  }
  const v = guard('validateSpec', () => validateSpec(spec));
  if (!v) return;
  sample.pipeline.validate = { ok: v.ok, issues: v.issues.map(toIssueRec) };
  if (!v.ok) { sample.outcome = 'invalid_validator'; return; }
  const compiled = guard('compileWorld', () => compileWorld(spec as any));
  if (!compiled) return;
  const p = guard('runPlayabilityChecks', () => runPlayabilityChecks(compiled));
  if (!p) return;
  sample.pipeline.playability = { ok: p.ok, failedChecks: p.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail, objectIds: c.objectIds })) };
  sample.outcome = p.ok ? 'valid' : 'invalid_playability';
}

/** Outcome from the recorded stages. The raw zod verdict is kept separately: the world boundary normalises first. */
function deriveOutcome(s: Sample): Sample['outcome'] {
  if (s.exception) return 'exception';
  if (s.timing.error) return 'http_error';
  if (!s.parse.ok) return 'invalid_parse';
  const stage1 = s.pipeline.expand ?? s.pipeline.apply;
  if (!stage1) return 'invalid_parse';
  if (!stage1.ok) return stage1.issues.length > 0 && stage1.issues.every((i) => i.code === 'INVALID_SCHEMA') ? 'invalid_schema' : (s.kind === 'draft' ? 'invalid_expand' : 'invalid_apply');
  if (s.pipeline.validate && !s.pipeline.validate.ok) return 'invalid_validator';
  if (s.pipeline.playability) return s.pipeline.playability.ok ? 'valid' : 'invalid_playability';
  return 'invalid_validator';
}

/** Re-runs parse, zod and the world pipeline on a stored sample's raw content; model timings are kept as recorded. */
function revalidate(sample: Sample): void {
  sample.pipeline = {};
  sample.exception = undefined;
  let parsed: unknown = null;
  try { parsed = JSON.parse(sample.rawContent); sample.parse = { ok: true }; } catch (e) { sample.parse = { ok: false, error: String((e as Error)?.message ?? e) }; }
  if (sample.parse.ok) {
    const z = (sample.kind === 'draft' ? WorldDraftSchema : PatchDraftSchema).safeParse(parsed);
    sample.zod = { ok: z.success, issues: z.success ? [] : z.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })) };
    runPipeline(sample.kind, parsed, sample);
  } else {
    sample.zod = { ok: false, issues: [] };
  }
  sample.outcome = deriveOutcome(sample);
  sample.failureModes = classify(sample);
}

/** Failure-mode keys for the summary table. One sample can carry several. */
export function classify(s: Sample): string[] {
  const modes = new Set<string>();
  if (s.timing.doneReason === 'length') modes.add('truncated_output');
  if (!s.parse.ok && s.outcome !== 'http_error') modes.add(s.timing.doneReason === 'length' ? 'truncated_output' : 'malformed_json');
  for (const z of s.zod.issues) {
    const p = z.path;
    if (/center\.(x|z)$/.test(p) && /greater than or equal|less than or equal/.test(z.message)) modes.add('coordinates_out_of_range');
    else if (/localPosition\.(x|z)$/.test(p) && /greater than or equal|less than or equal/.test(z.message)) modes.add('local_position_misuse');
    else if (['invalid_enum_value', 'invalid_literal', 'invalid_union_discriminator', 'invalid_union'].includes(z.code)) modes.add('wrong_enum');
    else if (/\.id$|^id$/.test(p) && z.code === 'invalid_string') modes.add('bad_id_format');
    else if (/^(islands|bridges|decorations|ops)$/.test(p) && (z.code === 'too_big' || z.code === 'too_small')) modes.add('resource_limit');
    else if (/^(spawns|relics)$/.test(p) && (z.code === 'too_big' || z.code === 'too_small')) modes.add('wrong_object_count');
    else if (z.code === 'unrecognized_keys') modes.add('extra_keys');
    else if (z.code === 'invalid_type' && /Required/.test(z.message)) modes.add('missing_field');
    else modes.add('other_schema');
  }
  const all: IssueRec[] = [...(s.pipeline.expand?.issues ?? []), ...(s.pipeline.apply?.issues ?? []), ...(s.pipeline.validate?.issues ?? [])];
  for (const i of all) {
    switch (i.code) {
      case 'INVALID_REFERENCE': modes.add('invented_ids'); break;
      case 'OUT_OF_BOUNDS': modes.add('coordinates_out_of_range'); break;
      case 'OBJECT_NOT_ON_SURFACE': modes.add('local_position_misuse'); break;
      case 'ISLAND_OVERLAP': modes.add('overlapping_islands'); break;
      case 'UNREACHABLE_RELIC': modes.add('unreachable_relic'); break;
      case 'DISCONNECTED_GOAL': modes.add('missing_bridge_to_gate'); break;
      case 'UNREACHABLE_SPAWN': modes.add('unreachable_spawn'); break;
      case 'GATE_HIDES_RELIC': modes.add('gate_hides_relic'); break;
      case 'DUPLICATE_ID': modes.add('duplicate_ids'); break;
      case 'BRIDGE_LENGTH': case 'BRIDGE_ENDPOINT_GAP': case 'BRIDGE_CROSSES_ISLAND': case 'BRIDGE_TOO_NARROW': modes.add('bridge_geometry'); break;
      case 'UNKNOWN_OPERATION': case 'UNSUPPORTED_OPERATION': modes.add('unknown_operation'); break;
      case 'RESOURCE_LIMIT': modes.add('resource_limit'); break;
      case 'INVALID_SCHEMA': break; // already covered by the zod rows above
      default: modes.add('other_validator_' + i.code.toLowerCase());
    }
  }
  // Corrections the world boundary applied silently (packages/world normalize.ts): count them as the raw failure they repaired.
  for (const n of [...(s.pipeline.expand?.normalizations ?? []), ...(s.pipeline.apply?.normalizations ?? [])]) {
    const r = `${n.path} ${n.reason}`.toLowerCase();
    if (/islandid|\bfrom\b|\bto\b|reference|resolved|name|compass|\.id$/.test(r) && typeof n.from === 'string') modes.add('invented_ids_normalized');
    else if (/localposition|offset|radius/.test(r)) modes.add('local_position_normalized');
    else if (/center|bounds|halfextent/.test(r)) modes.add('coordinates_normalized');
    else modes.add('other_normalized');
  }
  if (s.outcome === 'invalid_playability') modes.add('playability_failed');
  if (s.outcome === 'http_error') modes.add('http_error');
  if (s.exception) modes.add('pipeline_exception');
  return [...modes].sort();
}

// ---- jobs ----
type Job = { id: string; kind: Kind; promptId: string; promptNote: string; prompt: string; temperature: number; sampleIndex: number; phase: string; dir: string };
let inFlight = 0;
const T_START = performance.now();

async function runJob(job: Job): Promise<Sample> {
  const startedAtMs = Math.round(performance.now() - T_START);
  const inFlightAtStart = inFlight;
  inFlight++;
  let { content, stats } = await chat(job.kind, job.prompt, job.temperature);
  let retries = 0;
  // status 0 = fetch failed or timeout, 5xx = daemon restarting: wait and retry instead of recording a dead sample.
  while ((stats.status === 0 || stats.status >= 500) && retries < RETRY_MAX && performance.now() - T_START < BUDGET_SEC * 1000) {
    retries++;
    console.log(`      ${job.id}: transport error (${stats.error}); retry ${retries}/${RETRY_MAX} in ${RETRY_DELAY_MS} ms`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    ({ content, stats } = await chat(job.kind, job.prompt, job.temperature));
  }
  inFlight--;
  const sample: Sample = {
    id: job.id, kind: job.kind, promptId: job.promptId, promptNote: job.promptNote, prompt: job.prompt, temperature: job.temperature, sampleIndex: job.sampleIndex, phase: job.phase,
    model: MODEL, request: { numCtx: NUM_CTX, numPredict: NUM_PREDICT[job.kind], format: job.kind === 'draft' ? 'WORLD_DRAFT_JSON_SCHEMA' : 'PATCH_DRAFT_JSON_SCHEMA', systemPromptChars: SYSTEM[job.kind].length },
    timing: { ...stats, inFlightAtStart, startedAtMs, retries },
    rawContent: content, rawChars: content.length,
    parse: { ok: false }, zod: { ok: false, issues: [] }, pipeline: {}, outcome: 'invalid_parse', failureModes: [],
  };
  if (stats.error) {
    sample.outcome = 'http_error';
  } else {
    let parsed: unknown = null;
    try { parsed = JSON.parse(content); sample.parse = { ok: true }; } catch (e) { sample.parse = { ok: false, error: String((e as Error)?.message ?? e) }; }
    if (sample.parse.ok) {
      const schema = job.kind === 'draft' ? WorldDraftSchema : PatchDraftSchema;
      const z = schema.safeParse(parsed);
      sample.zod = { ok: z.success, issues: z.success ? [] : z.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })) };
      sample.outcome = z.success ? 'valid' : 'invalid_schema';
      // The pipeline runs on the parsed object even when zod failed: expandDraft/applyPatch normalise and validate at
      // their own boundary, so a raw-zod failure can still end valid (counted as validRawZodFailed in the summary).
      runPipeline(job.kind, parsed, sample);
    }
  }
  sample.outcome = deriveOutcome(sample);
  sample.failureModes = classify(sample);
  await writeFile(resolve(job.dir, `${job.id}.json`), JSON.stringify(sample, null, 2) + '\n');
  const tag = sample.outcome.padEnd(18);
  console.log(`${String(Math.round((performance.now() - T_START) / 1000)).padStart(5)}s ${job.id.padEnd(18)} ${tag} ${String(stats.wallMs).padStart(6)}ms out=${String(stats.outputTokens ?? '-').padStart(4)} inflight=${inFlightAtStart} ${sample.failureModes.join(',')}${sample.exception ? ' EXCEPTION ' + sample.exception.step : ''}`);
  return sample;
}

async function runPool(jobs: Job[], n: number, shouldStop: () => boolean): Promise<Sample[]> {
  let next = 0;
  const out: Sample[] = [];
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length && !shouldStop()) {
      const job = jobs[next++];
      out.push(await runJob(job));
    }
  }));
  return out;
}

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((1000 * a) / b) / 10);
const quantile = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

function stats(samples: Sample[]) {
  const n = samples.length;
  const walls = samples.map((s) => s.timing.wallMs);
  const outTok = samples.map((s) => s.timing.outputTokens ?? 0);
  const evalMs = samples.map((s) => s.timing.evalMs ?? 0);
  const modes: Record<string, number> = {};
  for (const s of samples) for (const m of s.failureModes) modes[m] = (modes[m] ?? 0) + 1;
  const outcomes: Record<string, number> = {};
  for (const s of samples) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
  const parseOk = samples.filter((s) => s.parse.ok).length;
  const zodOk = samples.filter((s) => s.zod.ok).length;
  const stageOk = samples.filter((s) => (s.pipeline.expand ?? s.pipeline.apply)?.ok).length;
  const validatorOk = samples.filter((s) => s.pipeline.validate?.ok).length;
  const valid = samples.filter((s) => s.outcome === 'valid').length;
  const normCount = (s: Sample) => (s.pipeline.expand?.normalizations?.length ?? 0) + (s.pipeline.apply?.normalizations?.length ?? 0);
  const normalizedSamples = samples.filter((s) => normCount(s) > 0).length;
  // The normaliser only rewrites what the schema or the validator would otherwise reject, so a valid sample that
  // carries at least one normalization became valid only because of it. validRawZodFailed is the strict subset where
  // even the raw zod schema had rejected the model output.
  const validOnlyByNormalization = samples.filter((s) => s.outcome === 'valid' && normCount(s) > 0).length;
  const validRawZodFailed = samples.filter((s) => s.outcome === 'valid' && !s.zod.ok).length;
  const validWithoutNormalization = valid - validOnlyByNormalization;
  const normalizationReasons: Record<string, number> = {};
  for (const s of samples) for (const nrm of [...(s.pipeline.expand?.normalizations ?? []), ...(s.pipeline.apply?.normalizations ?? [])]) normalizationReasons[nrm.reason] = (normalizationReasons[nrm.reason] ?? 0) + 1;
  return {
    samples: n, parseOk, zodOk, expandOrApplyOk: stageOk, validatorOk, valid,
    normalization: { samplesNormalized: normalizedSamples, validOnlyByNormalization, validRawZodFailed, validWithoutNormalization, totalNormalizations: samples.reduce((a, s) => a + normCount(s), 0), reasons: normalizationReasons },
    rates: { parse: pct(parseOk, n), zod: pct(zodOk, n), expandOrApply: pct(stageOk, n), validator: pct(validatorOk, n), valid: pct(valid, n), validWithoutNormalization: pct(validWithoutNormalization, n) },
    outcomes, failureModes: modes,
    timing: {
      wallMs: { min: Math.min(...walls), p50: quantile(walls, 0.5), p90: quantile(walls, 0.9), max: Math.max(...walls), mean: Math.round(walls.reduce((a, b) => a + b, 0) / Math.max(1, n)) },
      outputTokens: { min: Math.min(...outTok), p50: quantile(outTok, 0.5), max: Math.max(...outTok), total: outTok.reduce((a, b) => a + b, 0) },
      promptTokens: { p50: quantile(samples.map((s) => s.timing.promptTokens ?? 0), 0.5) },
      modelTokensPerSec: Math.round((10 * outTok.reduce((a, b) => a + b, 0)) / Math.max(1, evalMs.reduce((a, b) => a + b, 0) / 1000)) / 10,
      truncated: samples.filter((s) => s.timing.doneReason === 'length').length,
      queueWaitMs: { p50: quantile(samples.map((s) => s.timing.queueWaitMs ?? 0), 0.5), max: Math.max(0, ...samples.map((s) => s.timing.queueWaitMs ?? 0)), total: samples.reduce((a, s) => a + (s.timing.queueWaitMs ?? 0), 0) },
      computeMs: { total: samples.reduce((a, s) => a + (s.timing.evalMs ?? 0) + (s.timing.promptEvalMs ?? 0) + (s.timing.loadMs ?? 0), 0) },
    },
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`corpus: model=${MODEL} base=${BASE} concurrency=${CONCURRENCY} samples=${SAMPLES} temps=${TEMPS.join(',')} budget=${BUDGET_SEC}s out=${OUT}`);
  const kept: Sample[] = [];
  let storedProbe: Record<string, unknown> | null = null;
  for (const d of ['draft', 'patch', 'probe']) {
    const dir = resolve(OUT, d);
    await mkdir(dir, { recursive: true });
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      if (RESUME) {
        const prev = JSON.parse(await readFile(resolve(dir, f), 'utf8')) as Sample;
        if (prev.outcome !== 'http_error' && d !== 'probe') {
          // Re-validate the stored raw output against the current packages/world (no model call), so the stored
          // verdicts, summary.json and tests/unit/corpus.test.ts agree even after normalize.ts or the validator changed.
          revalidate(prev);
          await writeFile(resolve(dir, f), JSON.stringify(prev, null, 2) + '\n');
          kept.push(prev);
          continue;
        }
        if (d === 'probe' && prev.outcome !== 'http_error') continue; // probe samples stay on disk; their numbers come from summary.json
      }
      await rm(resolve(dir, f));
    }
  }
  if (RESUME) {
    try { storedProbe = (JSON.parse(await readFile(resolve(OUT, 'summary.json'), 'utf8')) as { concurrencyProbe: Record<string, unknown> | null }).concurrencyProbe; } catch { storedProbe = null; }
    console.log(`resume: keeping ${kept.length} stored samples, stored probe ${storedProbe ? 'reused' : 'absent'}`);
  }
  const deadline = () => performance.now() - T_START > BUDGET_SEC * 1000;

  // Concurrency probe: the same patch request N times sequentially, then N times at once. Ollama queues requests it
  // cannot run in parallel (OLLAMA_NUM_PARALLEL), so this measures what 4 concurrent callers actually buy.
  let concurrencyProbe: Record<string, unknown> | null = storedProbe;
  if (PROBE && !concurrencyProbe) {
    const mk = (phase: string, i: number): Job => ({ id: `${phase}-${i}`, kind: 'patch', promptId: 'e05', promptNote: EDITS[4].note, prompt: EDITS[4].text, temperature: 0.4, sampleIndex: i, phase, dir: resolve(OUT, 'probe') });
    const seqJobs = Array.from({ length: PROBE_N }, (_, i) => mk('probe-seq', i));
    const parJobs = Array.from({ length: PROBE_N }, (_, i) => mk('probe-par', i));
    const t1 = performance.now();
    const seq = await runPool(seqJobs, 1, () => false);
    const seqWall = Math.round(performance.now() - t1);
    const t2 = performance.now();
    const par = await runPool(parJobs, PROBE_N, () => false);
    const parWall = Math.round(performance.now() - t2);
    const tok = (xs: Sample[]) => xs.reduce((a, s) => a + (s.timing.outputTokens ?? 0), 0);
    concurrencyProbe = {
      requestsPerPhase: PROBE_N,
      sequential: { wallMs: seqWall, outputTokens: tok(seq), tokensPerSecWall: Math.round((10 * tok(seq)) / (seqWall / 1000)) / 10, perRequestWallMs: seq.map((s) => s.timing.wallMs), perRequestEvalMs: seq.map((s) => s.timing.evalMs) },
      concurrent: { wallMs: parWall, outputTokens: tok(par), tokensPerSecWall: Math.round((10 * tok(par)) / (parWall / 1000)) / 10, perRequestWallMs: par.map((s) => s.timing.wallMs), perRequestEvalMs: par.map((s) => s.timing.evalMs) },
      speedup: Math.round((100 * seqWall) / Math.max(1, parWall)) / 100,
      note: 'speedup near 1.0 means Ollama serialised the requests (num_parallel 1): concurrency only hides client latency; above 1.5 means real batching.',
    };
    console.log('concurrency probe:', JSON.stringify(concurrencyProbe));
  }

  // Interleaved job order so a budget cut leaves a balanced corpus: sample index, then prompt index, alternating kinds, both temperatures.
  const jobs: Job[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    for (let p = 0; p < Math.max(BRIEFS.length, EDITS.length); p++) {
      for (const temperature of TEMPS) {
        const tt = `t${String(temperature).replace('.', '')}`;
        if (p < EDITS.length) jobs.push({ id: `${EDITS[p].id}-${tt}-s${s}`, kind: 'patch', promptId: EDITS[p].id, promptNote: EDITS[p].note, prompt: EDITS[p].text, temperature, sampleIndex: s, phase: 'main', dir: resolve(OUT, 'patch') });
        if (p < BRIEFS.length) jobs.push({ id: `${BRIEFS[p].id}-${tt}-s${s}`, kind: 'draft', promptId: BRIEFS[p].id, promptNote: BRIEFS[p].note, prompt: BRIEFS[p].text, temperature, sampleIndex: s, phase: 'main', dir: resolve(OUT, 'draft') });
      }
    }
  }
  const keptIds = new Set(kept.map((k) => k.id));
  const todo = jobs.filter((j) => !keptIds.has(j.id));
  console.log(`planned ${jobs.length} samples (${jobs.filter((j) => j.kind === 'draft').length} drafts, ${jobs.filter((j) => j.kind === 'patch').length} patches)`);
  const tMain = performance.now();
  const fresh = await runPool(todo, CONCURRENCY, deadline);
  const mainWallMs = Math.round(performance.now() - tMain);
  const skipped = todo.length - fresh.length;
  const samples = [...kept, ...fresh];

  const by = (f: (s: Sample) => boolean) => samples.filter(f);
  const groups: Record<string, ReturnType<typeof stats>> = {};
  for (const kind of ['draft', 'patch'] as Kind[]) {
    groups[kind] = stats(by((s) => s.kind === kind));
    for (const t of TEMPS) groups[`${kind}@${t}`] = stats(by((s) => s.kind === kind && s.temperature === t));
  }
  for (const t of TEMPS) groups[`all@${t}`] = stats(by((s) => s.temperature === t));
  groups.all = stats(samples);
  const perPrompt: Record<string, { kind: Kind; note: string; samples: number; valid: number; outcomes: Record<string, number>; failureModes: Record<string, number> }> = {};
  for (const s of samples) {
    const g = perPrompt[s.promptId] ?? (perPrompt[s.promptId] = { kind: s.kind, note: s.promptNote, samples: 0, valid: 0, outcomes: {}, failureModes: {} });
    g.samples++; if (s.outcome === 'valid') g.valid++;
    g.outcomes[s.outcome] = (g.outcomes[s.outcome] ?? 0) + 1;
    for (const m of s.failureModes) g.failureModes[m] = (g.failureModes[m] ?? 0) + 1;
  }
  const exceptions = samples.filter((s) => s.exception).map((s) => ({ file: `tests/fixtures/corpus/${s.kind}/${s.id}.json`, step: s.exception!.step, message: s.exception!.message, stack: s.exception!.stack.split('\n').slice(0, 6).join('\n') }));
  const totalOut = samples.reduce((a, s) => a + (s.timing.outputTokens ?? 0), 0);
  const summary = {
    model: MODEL, startedAt, finishedAt: new Date().toISOString(),
    config: { concurrency: CONCURRENCY, samplesPerCell: SAMPLES, temperatures: TEMPS, budgetSec: BUDGET_SEC, numCtx: NUM_CTX, numPredict: NUM_PREDICT, requestTimeoutMs: REQUEST_TIMEOUT_MS, systemPromptChars: { draft: SYSTEM.draft.length, patch: SYSTEM.patch.length } },
    planned: jobs.length, completed: samples.length, freshThisRun: fresh.length, keptFromEarlierRun: kept.length, skippedForBudget: skipped,
    throughput: (() => { const freshOut = fresh.reduce((a, s) => a + (s.timing.outputTokens ?? 0), 0); return { mainLoopWallMs: mainWallMs, samplesThisRun: fresh.length, outputTokensThisRun: freshOut, outputTokensPerSecWall: Math.round((10 * freshOut) / Math.max(1, mainWallMs / 1000)) / 10, samplesPerMinute: Math.round((600 * fresh.length) / Math.max(1, mainWallMs / 1000)) / 10, outputTokensAllSamples: totalOut }; })(),
    concurrencyProbe,
    groups, perPrompt, exceptions,
    prompts: { briefs: BRIEFS, edits: EDITS },
  };
  await writeFile(resolve(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`done: ${fresh.length} fresh + ${kept.length} kept = ${samples.length}/${jobs.length} samples in ${Math.round(mainWallMs / 1000)}s, valid ${groups.all.valid}/${groups.all.samples} (${groups.all.rates.valid}%), exceptions ${exceptions.length}`);
  for (const e of exceptions) console.log('EXCEPTION', e.file, e.step, e.message);
}

main().catch((e) => { console.error(e); process.exit(1); });
