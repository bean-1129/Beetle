// Probe the local Ollama model: structured world draft + a real tool call. Writes data/logs/probe-<model>.json.
import { writeFile, mkdir } from 'node:fs/promises';
import { WORLD_DRAFT_JSON_SCHEMA, WorldDraftSchema, PATCH_DRAFT_JSON_SCHEMA, PatchDraftSchema } from '@beetle/contracts';

const base = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.env.BEETLE_MODEL ?? 'qwen3.5:4b';
const runs = Number(process.env.PROBE_RUNS ?? 1);

const SYSTEM = `You compose small floating-garden worlds for a two-player cooperative treasure hunt.
Coordinates: X east, Z north, metres, origin at centre, keep everything within ±50.
Islands are circles (radius 4 to 14) that must not overlap (gap >= 1 m). Bridges connect two islands by id; width 1.6 to 4.
Exactly 2 spawns, 3 relics, 1 gate. Spawns, relics, gate and decorations sit on islands; localPosition is an offset from the island centre and must stay inside the radius minus 1.
All relics and the gate must be reachable from both spawns by walking over bridges. Provide a safer wide route and an optional narrow risky route.
Ids are lowercase slugs. Output only JSON matching the schema.`;

async function chat(body: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, ...body }) });
  const json = await res.json();
  return { ms: Math.round(performance.now() - t0), status: res.status, json };
}

const results: Record<string, unknown>[] = [];
for (let i = 0; i < runs; i++) {
  const r1 = await chat({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Brief: five garden islands, one temple island to the north with the gate, water hazard, a few trees and lanterns.' }],
    format: WORLD_DRAFT_JSON_SCHEMA, think: false, options: { temperature: 0.4, num_ctx: 8192, num_predict: 2048 },
  });
  let parsed: unknown = null, zodOk = false, zodErr: string | undefined;
  try { parsed = JSON.parse(r1.json?.message?.content ?? ''); const z = WorldDraftSchema.safeParse(parsed); zodOk = z.success; if (!z.success) zodErr = z.error.issues.slice(0, 3).map((x) => x.path.join('.') + ': ' + x.message).join('; '); } catch (e) { zodErr = 'json parse: ' + String(e); }
  results.push({ probe: 'world_draft', run: i, ms: r1.ms, status: r1.status, promptTokens: r1.json?.prompt_eval_count, outputTokens: r1.json?.eval_count, loadMs: Math.round((r1.json?.load_duration ?? 0) / 1e6), evalMs: Math.round((r1.json?.eval_duration ?? 0) / 1e6), zodOk, zodErr, islands: (parsed as any)?.islands?.length, bridges: (parsed as any)?.bridges?.length, done: r1.json?.done_reason });
  console.log(JSON.stringify(results[results.length - 1]));

  const r2 = await chat({
    messages: [{ role: 'system', content: 'You edit a world through tools. Call read_world_state first.' }, { role: 'user', content: 'Turn the water into lava and add a bridge to the northern island.' }],
    tools: [
      { type: 'function', function: { name: 'read_world_state', description: 'Read the current world structure and session summary.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'propose_patch', description: 'Stage a bounded world change.', parameters: { type: 'object', required: ['summary', 'ops'], properties: { summary: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } } } } },
    ],
    think: false, options: { temperature: 0.2, num_ctx: 8192 },
  });
  const calls = r2.json?.message?.tool_calls ?? [];
  results.push({ probe: 'tool_call', run: i, ms: r2.ms, status: r2.status, toolCalls: calls.map((c: any) => c.function?.name), firstArgs: calls[0]?.function?.arguments, content: String(r2.json?.message?.content ?? '').slice(0, 200), promptTokens: r2.json?.prompt_eval_count, outputTokens: r2.json?.eval_count });
  console.log(JSON.stringify(results[results.length - 1]));

  const r3 = await chat({
    messages: [{ role: 'system', content: 'You produce a bounded edit patch for a world. Islands: isle-a (centre), isle-north (north), isle-east. Bridges: b1 isle-a->isle-east. Ops allowed: add_bridge{id,from,to,width?}, remove_bridge{id}, set_hazard{kind}, add_decoration, move_decoration, remove_decoration, move_relic, set_title. Output only JSON.' }, { role: 'user', content: 'Turn the water into lava and add a bridge to the northern island.' }],
    format: PATCH_DRAFT_JSON_SCHEMA, think: false, options: { temperature: 0.2, num_ctx: 8192, num_predict: 512 },
  });
  let p3: unknown = null, ok3 = false, err3: string | undefined;
  try { p3 = JSON.parse(r3.json?.message?.content ?? ''); const z = PatchDraftSchema.safeParse(p3); ok3 = z.success; if (!z.success) err3 = z.error.issues.slice(0, 3).map((x) => x.path.join('.') + ': ' + x.message).join('; '); } catch (e) { err3 = 'json parse: ' + String(e); }
  results.push({ probe: 'patch_draft', run: i, ms: r3.ms, status: r3.status, zodOk: ok3, zodErr: err3, ops: (p3 as any)?.ops, promptTokens: r3.json?.prompt_eval_count, outputTokens: r3.json?.eval_count });
  console.log(JSON.stringify(results[results.length - 1]));
}
await mkdir('data/logs', { recursive: true });
await writeFile(`data/logs/probe-${model.replace(/[^a-z0-9.]/gi, '_')}.json`, JSON.stringify({ model, at: new Date().toISOString(), results }, null, 2));
