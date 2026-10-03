// Local model benchmark: direct Ollama calls (labelled 'direct'), three workloads, cold run plus N warm runs.
// Usage: BEETLE_BENCH_MODELS=qwen3.5:4b BEETLE_BENCH_RUNS=3 npx tsx scripts/benchmark-local.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  WORLD_DRAFT_JSON_SCHEMA, WorldDraftSchema, PATCH_DRAFT_JSON_SCHEMA, PatchDraftSchema,
  type ValidationIssue,
} from '@beetle/contracts';
import { summarize } from '@beetle/observability';
import { createOllamaClient, parseModelJson, type ChatMessage, type OllamaClient } from '../packages/agent/src/ollama.ts';
import { worldDraftSystemPrompt, patchDraftSystemPrompt, briefUserPrompt, editUserPrompt, validatorRepairPrompt, schemaRepairPrompt, zodSummary } from '../packages/agent/src/prompts.ts';
import { fixtureSpec, fixtureSummary } from '../packages/agent/test-support/fixture-world.ts';

const MODE = 'direct' as const;
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const models = (process.env.BEETLE_BENCH_MODELS ?? 'qwen3.5:4b').split(',').map((s) => s.trim()).filter(Boolean);
const runs = Math.max(1, Number(process.env.BEETLE_BENCH_RUNS ?? 3) || 3);
const MAX_RETRIES = 2;
const outDir = resolve(process.cwd(), 'data', 'benchmarks');

type Workload = {
  name: 'world_draft' | 'edit_patch' | 'validator_repair';
  messages: ChatMessage[];
  format: Record<string, unknown>;
  numPredict: number;
  temperature: number;
  /** Returns null when valid, else the reason. */
  check: (value: unknown) => string | null;
};

type RunRecord = {
  model: string; workload: Workload['name']; cold: boolean; run: number;
  msTotal: number; promptTokens: number; outputTokens: number; loadMs: number;
  msToValid: number | null; retries: number; failureReason: string | null; attempts: number;
};

function workloads(): Workload[] {
  const spec = fixtureSpec();
  const summary = fixtureSummary(spec);
  // Repair workload: the temple island has no bridge, the previous patch missed it, and the validator says so.
  const gapped = { ...spec, bridges: spec.bridges.filter((b) => b.id !== 'bridge-temple') };
  const issue: ValidationIssue = {
    code: 'DISCONNECTED_GOAL',
    message: 'gate on island isle-temple is not reachable from spawn-0 or spawn-1 with the gate locked',
    objectIds: ['gate', 'isle-temple'],
    evidence: { gateIslandId: 'isle-temple', gateIslandName: 'Temple', compass: 'north', bridgesTouchingTempleIsland: 0, reachableIslands: ['isle-centre', 'isle-east', 'isle-west', 'isle-south'] },
  };
  const checkPatch = (v: unknown) => { const z = PatchDraftSchema.safeParse(v); return z.success ? null : 'zod: ' + zodSummary(z.error.issues); };
  return [
    {
      name: 'world_draft',
      messages: [{ role: 'system', content: worldDraftSystemPrompt() }, { role: 'user', content: briefUserPrompt('Five garden islands, a temple island to the north holding the gate, water hazard, a few trees and lanterns, one narrow risky shortcut.') }],
      format: WORLD_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>, numPredict: 2048, temperature: 0.4,
      check: (v) => { const z = WorldDraftSchema.safeParse(v); return z.success ? null : 'zod: ' + zodSummary(z.error.issues); },
    },
    {
      name: 'edit_patch',
      messages: [{ role: 'system', content: patchDraftSystemPrompt({ spec, summary }) }, { role: 'user', content: editUserPrompt('Turn the water into lava and add a bridge from the orchard island to the temple island.') }],
      format: PATCH_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>, numPredict: 512, temperature: 0.2,
      check: checkPatch,
    },
    {
      name: 'validator_repair',
      messages: [
        { role: 'system', content: patchDraftSystemPrompt({ spec: gapped, summary: fixtureSummary(gapped) }) },
        { role: 'user', content: editUserPrompt('Add a lantern on the centre island and make sure the temple gate can be reached.') },
        { role: 'assistant', content: JSON.stringify({ summary: 'Added a lantern', ops: [{ op: 'add_decoration', id: 'lantern-2', type: 'lantern', islandId: 'isle-centre', localPosition: { x: -3, z: 3 } }] }) },
        { role: 'user', content: validatorRepairPrompt([issue]) },
      ],
      format: PATCH_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>, numPredict: 512, temperature: 0.2,
      check: (v) => {
        const base = checkPatch(v);
        if (base) return base;
        const ops = (v as { ops: { op: string; from?: string; to?: string }[] }).ops;
        const ok = ops.some((o) => o.op === 'add_bridge' && (o.to === 'isle-temple' || o.from === 'isle-temple'));
        return ok ? null : 'valid patch but no add_bridge to isle-temple';
      },
    },
  ];
}

async function runOnce(ollama: OllamaClient, model: string, w: Workload, cold: boolean, run: number): Promise<RunRecord> {
  const rec: RunRecord = { model, workload: w.name, cold, run, msTotal: 0, promptTokens: 0, outputTokens: 0, loadMs: 0, msToValid: null, retries: 0, failureReason: null, attempts: 0 };
  const messages = [...w.messages];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    rec.attempts = attempt + 1;
    let res;
    try {
      res = await ollama.chat({ model, messages, format: w.format, numPredict: w.numPredict, temperature: w.temperature, think: false, timeoutMs: 180_000 });
    } catch (err) {
      rec.failureReason = (err as Error).message;
      return rec;
    }
    rec.msTotal += res.wallMs;
    rec.promptTokens += res.promptTokens;
    rec.outputTokens += res.outputTokens;
    if (attempt === 0) rec.loadMs = res.loadMs;
    const parsed = parseModelJson(res.content);
    const reason = parsed.ok ? w.check(parsed.value) : parsed.error;
    if (!reason) { rec.msToValid = rec.msTotal; rec.failureReason = null; return rec; }
    rec.failureReason = reason;
    if (attempt < MAX_RETRIES) {
      rec.retries++;
      messages.push({ role: 'assistant', content: res.content.slice(0, 6000) });
      messages.push({ role: 'user', content: schemaRepairPrompt(reason) });
    }
  }
  return rec;
}

function fmt(n: number) { return Math.round(n).toString(); }

async function main() {
  await mkdir(outDir, { recursive: true });
  const all: RunRecord[] = [];
  const tables: string[] = [];
  for (const model of models) {
    const ollama = createOllamaClient({ baseUrl, model, defaultTimeoutMs: 180_000 });
    const health = await ollama.health(3000);
    if (!health.reachable || !health.present) {
      console.error(`[${MODE}] model ${model} is not available at ${baseUrl} (reachable=${health.reachable}, present=${health.present}); skipping, no fallback`);
      continue;
    }
    const ws = workloads();
    console.log(`[${MODE}] benchmarking ${model} at ${baseUrl}: 1 cold run + ${runs} warm runs x ${ws.length} workloads`);
    const records: RunRecord[] = [];
    const cold = await runOnce(ollama, model, ws[0], true, 0);
    records.push(cold);
    console.log(`[${MODE}] cold ${cold.workload}: ${cold.msTotal} ms (load ${cold.loadMs} ms) valid=${cold.msToValid !== null} retries=${cold.retries}${cold.failureReason ? ' reason=' + cold.failureReason : ''}`);
    for (const w of ws) {
      for (let i = 1; i <= runs; i++) {
        const r = await runOnce(ollama, model, w, false, i);
        records.push(r);
        console.log(`[${MODE}] warm ${w.name} #${i}: ${r.msTotal} ms, tokens ${r.promptTokens}/${r.outputTokens}, valid=${r.msToValid !== null} retries=${r.retries}${r.failureReason ? ' reason=' + r.failureReason : ''}`);
      }
    }
    all.push(...records);
    const lines: string[] = [];
    lines.push(`\n### ${model} (mode: ${MODE}, ${baseUrl}, cold run then ${runs} warm runs per workload)\n`);
    lines.push('| workload | runs | valid | ms total min/p50/max | ms to valid min/p50/max | prompt tok p50 | output tok p50 | load ms (cold) | retries total | failures |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const w of ws) {
      const warm = records.filter((r) => r.workload === w.name && !r.cold);
      const total = summarize(warm.map((r) => r.msTotal));
      const valid = warm.filter((r) => r.msToValid !== null);
      const toValid = summarize(valid.map((r) => r.msToValid as number));
      const pt = summarize(warm.map((r) => r.promptTokens));
      const ot = summarize(warm.map((r) => r.outputTokens));
      const retries = warm.reduce((a, r) => a + r.retries, 0);
      const failures = warm.filter((r) => r.failureReason && r.msToValid === null).map((r) => r.failureReason).join('; ') || 'none';
      lines.push(`| ${w.name} | ${warm.length} | ${valid.length}/${warm.length} | ${fmt(total.min)}/${fmt(total.p50)}/${fmt(total.max)} | ${valid.length ? `${fmt(toValid.min)}/${fmt(toValid.p50)}/${fmt(toValid.max)}` : 'n/a'} | ${fmt(pt.p50)} | ${fmt(ot.p50)} | ${w.name === 'world_draft' ? cold.loadMs : '-'} | ${retries} | ${failures} |`);
    }
    lines.push(`\nCold run (${cold.workload}): ${cold.msTotal} ms total, load ${cold.loadMs} ms, ${cold.msToValid !== null ? 'valid' : 'invalid: ' + cold.failureReason}, retries ${cold.retries}.`);
    const table = lines.join('\n');
    tables.push(table);
    const file = resolve(outDir, `bench-${model.replace(/[^a-z0-9.]/gi, '_')}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify({ mode: MODE, model, baseUrl, runs, maxRetries: MAX_RETRIES, at: new Date().toISOString(), records, table }, null, 2));
    console.log(`[${MODE}] wrote ${file}`);
  }
  console.log(tables.join('\n'));
  if (all.length === 0) process.exitCode = 1;
}

main().catch((err) => { console.error(`[${MODE}] benchmark failed: ${(err as Error).message}`); process.exitCode = 1; });
