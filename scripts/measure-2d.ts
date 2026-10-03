// Measures Beetle 2D's prompt-to-playable path on this machine: the same steps the 2D studio
// runs (read the idea, ask the local model for a design doc or a script, build the levels,
// validate the spec), with a Node shim for the studio2d bridge that calls Ollama directly.
//   PATH=.tools/node/bin:$PATH node_modules/.bin/tsx scripts/measure-2d.ts
// Writes data/studio2d-runs/run-<ms>.json. The GPU may be shared with other work.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designFromIdea, DESIGN_SYSTEM, DESIGN_SCHEMA, designPrompt } from "../apps/web/src/studio2d/gen/design.ts";
import { makeDesign, templateSpec, writeScriptGame } from "../apps/web/src/studio2d/gen/ai.ts";
import { specFromDesign } from "../apps/web/src/studio2d/gen/build.ts";
import { validateSpec } from "../apps/web/src/studio2d/spec/validate.ts";
import type { GameSpec } from "../apps/web/src/studio2d/spec/types.ts";
import type { DesignDoc } from "../apps/web/src/studio2d/gen/design.ts";

const OLLAMA = "http://127.0.0.1:11434";
const MODEL = process.env.STUDIO2D_MODEL || "qwen3.5:4b";
const DEFAULT_NUM_CTX = 8192; // same default as the server's studio2d route
const DEADLINE = Number(process.env.MEASURE_DEADLINE_MS || 0); // epoch ms; 0 = none

const PROMPTS = [
  "a platformer where a fox collects acorns across floating cliffs",
  "a top-down dungeon crawler with keys and doors",
  "a tower defense where bees protect a hive",
  "a sliding block puzzle in a candy factory",
  "a game like Red Ball 5",
  "a stickman fight game",
];

type Call = { id: string; ok: boolean; ms: number; model?: string; error?: string; promptTokens?: number; outTokens?: number; loadMs?: number };
let calls: Call[] = [];

function parseJson(text: string): unknown {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("not JSON");
  }
}

async function llm(p: { id: string; system: string; prompt: string; schema?: object; temperature?: number; maxTokens?: number; timeoutMs?: number; numCtx?: number }) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), p.timeoutMs ?? 240000);
  const rec: Call = { id: p.id, ok: false, ms: 0 };
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        format: p.schema ?? "json",
        messages: [
          { role: "system", content: p.system },
          { role: "user", content: p.prompt },
        ],
        options: { temperature: p.temperature, num_predict: p.maxTokens, num_ctx: p.numCtx || DEFAULT_NUM_CTX },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      rec.error = `model endpoint returned ${res.status}`;
      return { ok: false, error: rec.error };
    }
    const body = (await res.json()) as { message?: { content?: string }; model?: string; prompt_eval_count?: number; eval_count?: number; load_duration?: number };
    rec.model = body.model;
    rec.promptTokens = body.prompt_eval_count;
    rec.outTokens = body.eval_count;
    rec.loadMs = body.load_duration ? Math.round(body.load_duration / 1e6) : undefined;
    let json: unknown;
    try {
      json = parseJson(body.message?.content ?? "");
    } catch {
      rec.error = "model reply was not valid JSON";
      return { ok: false, error: rec.error };
    }
    rec.ok = true;
    return { ok: true, json, model: body.model ?? MODEL, ms: Date.now() - started };
  } catch (e) {
    rec.error = String((e as Error)?.message || e).slice(0, 200);
    return { ok: false, error: rec.error };
  } finally {
    clearTimeout(timer);
    rec.ms = Date.now() - started;
    calls.push(rec);
  }
}

(globalThis as any).studio2d = {
  llm,
  status: async () => {
    const r = await fetch(`${OLLAMA}/api/tags`).then((x) => x.json()).catch(() => ({ models: [] }));
    return { online: true, models: (r.models ?? []).map((m: any) => m.name), image: { ready: false, detail: "not used in this measurement" } };
  },
  warm: async () => ({ ok: true, model: MODEL }),
  cancel: async () => {},
};

// The UI checks scripted games in a sandboxed game page (an iframe); Node has none, so the
// check here is the spec validator (the static script check runs inside writeScriptGame).
const nodeCheck = async (spec: GameSpec) => {
  const v = validateSpec(spec);
  return v.ok ? { ok: true } : { ok: false, error: v.errors.slice(0, 3).join("; ") };
};

type Row = {
  prompt: string; route: string; genre: string; template?: string; title?: string; designSource?: string;
  valid: boolean; validatorIssues: string[]; repairFixes: number; modelMs: number; modelCalls: number; totalMs: number;
  retries: number; buildMs?: number; levels?: number; botPassed?: string; levelAttempts?: number; calls: Call[]; notes: string[];
};

async function runOne(idea: string): Promise<Row> {
  calls = [];
  const notes: string[] = [];
  const t0 = performance.now();
  const quick = designFromIdea(idea);
  let d: DesignDoc = quick;
  let spec: GameSpec | null = null;
  let retries = 0;
  let designSource = "idea";
  let build: ReturnType<typeof specFromDesign> | null = null;
  let route = quick.route ?? "genre";
  if (route === "genre") {
    // onDesign: makeDesign, then onBuild with the approved design (worker: specFromDesign).
    const r = await makeDesign(idea);
    d = r.design;
    designSource = r.source;
    if (r.note) notes.push(`design fallback: ${r.note}`);
    if (d.route === "script") notes.push("model said the idea fits no genre (fits=false)");
  }
  if (d.route === "template") {
    spec = templateSpec(idea, d);
    notes.push(`ready template ${d.template}, no model call`);
  } else if (d.route === "script") {
    const r = await writeScriptGame(idea, d, nodeCheck, () => {});
    retries = Math.max(0, r.attempts - 1);
    if ("spec" in r) spec = r.spec;
    else {
      notes.push(`script failed after ${r.attempts} tries: ${r.error.slice(0, 100)}; fell back to built-in genre`);
      d = { ...d, route: "genre" };
    }
  }
  if (!spec) {
    build = specFromDesign(d, { seed: 12345 });
    spec = build.spec;
  }
  const v = validateSpec(spec);
  const totalMs = Math.round(performance.now() - t0);
  const modelMs = calls.reduce((s, c) => s + c.ms, 0);
  const row: Row = {
    prompt: idea,
    route: d.route ?? route,
    genre: spec.meta?.genre ?? d.genre,
    template: d.template,
    title: spec.meta?.title,
    designSource,
    valid: v.ok,
    validatorIssues: v.errors,
    repairFixes: build?.fixes.length ?? 0,
    modelMs,
    modelCalls: calls.length,
    totalMs,
    retries,
    calls,
    notes,
  };
  if (build) {
    row.buildMs = build.ms;
    row.levels = build.spec.levels.length;
    row.botPassed = `${build.reports.filter((x) => x.passed).length}/${build.reports.length}`;
    row.levelAttempts = build.reports.reduce((s, x) => s + x.attempts, 0);
    if (build.fixes.length) notes.push(`repairSpec fixes: ${build.fixes.slice(0, 3).join("; ")}`);
  }
  if (calls.some((c) => !c.ok)) notes.push(`model call errors: ${calls.filter((c) => !c.ok).map((c) => c.error).join("; ")}`);
  return row;
}

async function main() {
  const startedAt = new Date().toISOString();
  const gpu = process.env.GPU_NOTE || "";
  // Warm-up: one real design call, excluded from the numbers.
  calls = [];
  await llm({ id: "warmup", system: DESIGN_SYSTEM, prompt: designPrompt("a warm-up game about a cat jumping on rooftops"), schema: DESIGN_SCHEMA, temperature: 0.5, maxTokens: 1200, timeoutMs: 90000 });
  const warm = calls[0];
  console.log(`warm-up: ok=${warm.ok} ${warm.ms} ms (load ${warm.loadMs ?? "?"} ms)`);
  const rows: Row[] = [];
  const skipped: string[] = [];
  for (const p of PROMPTS) {
    if (DEADLINE && Date.now() > DEADLINE) {
      skipped.push(p);
      continue;
    }
    const r = await runOne(p);
    rows.push(r);
    console.log(JSON.stringify({ prompt: r.prompt, route: r.route, genre: r.genre, valid: r.valid, modelMs: r.modelMs, totalMs: r.totalMs, retries: r.retries, notes: r.notes }));
  }
  const out = { startedAt, finishedAt: new Date().toISOString(), model: MODEL, numCtx: DEFAULT_NUM_CTX, node: process.version, gpuNote: gpu, warmup: warm, rows, skipped };
  const dir = join(process.cwd(), "data", "studio2d-runs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
