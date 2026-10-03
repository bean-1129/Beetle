// The renderer's side of the local model and image worker. Everything here degrades
// gracefully: with no model the idea is read directly, with no image model the procedural
// art stays.
import type { GameSpec } from "../spec/types.ts";
import { designFromIdea, repairDesign, DESIGN_SCHEMA, DESIGN_SYSTEM, designPrompt, type DesignDoc } from "./design.ts";
import { planPatch, safeApply, specOutline, PATCH_SCHEMA, PATCH_SYSTEM, type PatchOutcome } from "./nlpatch.ts";
import { assetPrompt, processGenerated, applyMask, cutoutPlainBackground } from "../assets/pipeline.ts";
import type { Pixels } from "../assets/pixels.ts";
import type { PatchOp } from "../spec/patch.ts";
import { SCRIPT_SYSTEM, SCRIPT_SCHEMA, scriptPrompt, repairPrompt, scriptedSpec } from "./script.ts";
import { autoFix, checkScript } from "../runtime/script.ts";
import { SCRIPT_TEMPLATES, fillTemplate, findTemplate } from "../samples/scripts.ts";

// Beetle's rule: runtime model output never becomes executable JavaScript. While this is
// false the model never writes game code; only the shipped, hand-written templates run.
export const MODEL_SCRIPTS_ENABLED = false;
export const MODEL_SCRIPTS_OFF = "This kind of game is built from the closest genre on this machine; model-written game code is turned off.";

export type Studio2DApi = {
  status: () => Promise<{ online: boolean; models: string[]; image: { ready: boolean; detail?: string } }>;
  stage: (html: string) => Promise<string>;
  warm: () => Promise<{ ok: boolean; model?: string; error?: string }>;
  llm: (p: { id?: string; system: string; prompt: string; schema: object; temperature?: number; maxTokens?: number; timeoutMs?: number; numCtx?: number }) => Promise<{ ok: boolean; json?: unknown; model?: string; ms?: number; error?: string }>;
  cancel: (id: string) => Promise<void>;
  art: (p: { prompt: string; seed?: number }) => Promise<{ ok: boolean; image?: string; mask?: string | null; error?: string }>;
  exportHtml: (p: { html: string; name: string }) => Promise<{ ok?: boolean; path?: string; canceled?: boolean }>;
  exportProject: (p: { files: Record<string, string>; name: string }) => Promise<{ ok?: boolean; path?: string; canceled?: boolean }>;
  openProject: () => Promise<{ text?: string; canceled?: boolean }>;
  library: () => Promise<{ id: string; title: string; genre?: string; savedAt: number; levels: number }[]>;
  save: (p: { id: string; idea?: string; design?: DesignDoc | null; spec: GameSpec }) => Promise<{ id: string }>;
  load: (id: string) => Promise<{ idea?: string; design?: DesignDoc | null; spec: GameSpec }>;
  remove: (id: string) => Promise<boolean>;
  assets: () => Promise<{ id: string; recipe: string; kind: string; data: string; from: string; savedAt: number }[]>;
  saveAsset: (a: { id: string; recipe: string; kind: string; data: string; from: string }) => Promise<{ id: string }>;
};

export const api = (): Studio2DApi | undefined => (globalThis as { studio2d?: Studio2DApi }).studio2d;

// Step 2: the design doc. The model writes it through the schema; the idea itself is the
// fallback and the base every answer is repaired onto.
export async function makeDesign(idea: string): Promise<{ design: DesignDoc; source: "model" | "idea"; model?: string; ms: number; note?: string }> {
  const t0 = performance.now();
  const base = designFromIdea(idea);
  const b = api();
  // Templates and custom scripts do not need a design doc from the model.
  if (!b || base.route !== "genre") return { design: base, source: "idea", ms: 0 };
  const r = await b.llm({ id: "design", system: DESIGN_SYSTEM, prompt: designPrompt(idea), schema: DESIGN_SCHEMA, temperature: 0.5, maxTokens: 1200, timeoutMs: 90000 }).catch((e) => ({ ok: false, error: String(e?.message || e) }) as const);
  if (!r.ok || !r.json) return { design: base, source: "idea", ms: Math.round(performance.now() - t0), note: r.ok ? "The model's answer was unreadable; read the idea directly." : r.error };
  const design = repairDesign(r.json, base);
  // The genre the person named wins over the model's guess.
  if (/\b(platformer|runner|top-down|arena|puzzle|builder|sokoban|shooter|endless)\b/i.test(idea)) design.genre = base.genre;
  return { design, source: "model", model: (r as any).model, ms: Math.round(performance.now() - t0) };
}

// Step 9: a change in words. Known requests are patched directly; the rest go to the model.
export async function changeInWords(spec: GameSpec, text: string): Promise<PatchOutcome & { via: "rules" | "model" }> {
  const plan = planPatch(spec, text);
  if (plan) return { ...safeApply(spec, plan.ops, plan.summary), via: "rules" };
  const b = api();
  if (!b) return { ok: false, reason: "I did not understand that change, and the local model is not available.", via: "rules" };
  const r = await b.llm({ id: "patch", system: PATCH_SYSTEM, prompt: `Spec:\n${specOutline(spec)}\n\nChange requested: ${text}`, schema: PATCH_SCHEMA, temperature: 0.2, maxTokens: 900, timeoutMs: 60000 });
  const j = r.json as { summary?: string; ops?: PatchOp[] } | undefined;
  if (!r.ok || !j || !Array.isArray(j.ops) || !j.ops.length) return { ok: false, reason: r.error || "The model did not suggest a change I can apply.", via: "model" };
  return { ...safeApply(spec, j.ops, j.summary || "Updated"), via: "model" };
}

export async function decode(url: string): Promise<Pixels> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}
export function encode(p: Pixels): string {
  const c = document.createElement("canvas");
  c.width = p.w;
  c.height = p.h;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  return c.toDataURL("image/png");
}

// Opt-in generated art for the main characters and items. Each finished asset replaces its
// procedural placeholder as soon as it passes its checks.
export async function generateArt(spec: GameSpec, ids: string[], onAsset: (id: string, next: GameSpec, ok: boolean, note?: string) => void, signal?: { cancelled: boolean }): Promise<GameSpec> {
  const b = api();
  if (!b) throw new Error("Generated art needs the local image model on this machine.");
  let cur = spec;
  for (const id of ids) {
    if (signal?.cancelled) break;
    const ref = cur.assets[id];
    if (!ref || ref.kind !== "sprite") continue;
    const prompt = assetPrompt(cur, ref);
    const r = await b.art({ prompt, seed: ref.seed });
    if (!r.ok || !r.image) {
      onAsset(id, cur, false, r.error);
      if (/install/i.test(r.error || "")) throw new Error(r.error);
      continue;
    }
    const img = await decode(r.image);
    const cut = r.mask ? applyMask(img, await decode(r.mask)) : cutoutPlainBackground(img);
    const done = processGenerated(cut, cur, id, 16);
    if (!done.set) {
      onAsset(id, cur, false, done.problems.join(", "));
      continue;
    }
    const data = encode(done.set.frames.idle![0]);
    cur = { ...cur, assets: { ...cur.assets, [id]: { ...ref, source: "generated", data, prompt } } };
    onAsset(id, cur, true);
    void b.saveAsset({ id: `${cur.meta.title}-${id}-${ref.seed}`.replace(/[^\w-]/g, "-").slice(0, 80), recipe: ref.recipe, kind: ref.kind, data, from: cur.meta.title }).catch(() => {});
  }
  return cur;
}


// ---------- scripted games ----------

const CREATURE = /\b(cat|dog|fox|zombie|alien|robot|ghost|bat|bird|bee|frog|slime|monster|goblin|dragon|penguin|bunny|rabbit|mouse|duck|fish|spider|bug|ninja|pirate|knight|wizard|chicken|pig|cow|shark|dinosaur|dino|ufo)s?\b/g;

// Ready templates: instant, no model wait. The idea's creatures and items fill the looks.
export function templateSpec(idea: string, d: DesignDoc): GameSpec {
  const t = SCRIPT_TEMPLATES.find((x) => x.id === d.template)!;
  const low = idea.toLowerCase();
  let words = [...low.matchAll(CREATURE)].map((m) => m[1]);
  // "the aliens are cats", "enemies become ghosts", "with zombies": the named creature is the enemy.
  const named = /\b(?:are|as|become|becomes|replaced by|into|with|of)\s+(?:the\s+|a\s+|an\s+)?([a-z]+?)s?\b/.exec(low)?.[1];
  if (named && words.includes(named)) words = [named, ...words.filter((w) => w !== named && !["alien", "ufo"].includes(w))];
  const pickup = /\b(apple|coin|star|gem|egg|fruit|cookie|candy|donut|carrot|banana|seed|acorn|fish|heart)s?\b/.exec(idea.toLowerCase())?.[1];
  const code = fillTemplate(t.code, { enemy: words[0], hero: words[1] && t.code.includes("{{enemy}}") ? words[1] : undefined, pickup });
  return scriptedSpec({ title: d.title || t.title, pitch: t.pitch, howToPlay: t.howToPlay, code, idea, palette: d.art.palette });
}

// Ask the model to write (or repair) a game. Returns code after the automatic fixes.
async function askForScript(prompt: string, temperature: number): Promise<{ title: string; pitch: string; howToPlay: string; code: string; model?: string } | { error: string }> {
  const b = api();
  if (!b) return { error: "Writing new kinds of games needs the local model on this machine." };
  const r = await b.llm({ id: "script", system: SCRIPT_SYSTEM, prompt, schema: SCRIPT_SCHEMA, temperature, maxTokens: 2600, timeoutMs: 240000, numCtx: 4096 });
  const j = r.json as { title?: string; pitch?: string; howToPlay?: string; code?: string } | undefined;
  if (!r.ok || !j || typeof j.code !== "string") return { error: r.error || "The model did not return a game." };
  return { title: j.title || "My game", pitch: j.pitch || "", howToPlay: j.howToPlay || "", code: autoFix(j.code).code, model: r.model };
}

export type SandboxCheck = (spec: GameSpec) => Promise<{ ok: boolean; error?: string }>;

// Write a game from scratch, check it in the sandbox, and let the model repair what fails.
export async function writeScriptGame(idea: string, d: DesignDoc | null, check: SandboxCheck, onStep: (step: string, detail?: string) => void, tries = 3): Promise<{ spec: GameSpec; attempts: number } | { error: string; attempts: number }> {
  if (!MODEL_SCRIPTS_ENABLED) {
    // Only a shipped template may run; otherwise the caller builds the closest genre.
    const t = findTemplate(idea);
    if (t && d) return { spec: templateSpec(idea, { ...d, template: t.id }), attempts: 0 };
    return { error: MODEL_SCRIPTS_OFF, attempts: 0 };
  }
  onStep("writing");
  let out = await askForScript(scriptPrompt(idea, d ?? undefined), 0.35);
  let lastError = "";
  for (let attempt = 1; attempt <= tries; attempt++) {
    if ("error" in out) return { error: out.error, attempts: attempt };
    const problems = checkScript(out.code);
    let err = problems.join("; ");
    let spec: GameSpec | null = null;
    if (!err) {
      spec = scriptedSpec({ ...out, idea, palette: d?.art.palette });
      onStep("checking", `try ${attempt}`);
      const r = await check(spec);
      err = r.ok ? "" : r.error || "the game did not start";
    }
    if (!err && spec) return { spec, attempts: attempt };
    lastError = err;
    if (attempt === tries) break;
    onStep("repairing", err);
    const code = out.code;
    out = await askForScript(repairPrompt(idea, code, err), 0.5);
  }
  return { error: lastError, attempts: tries };
}

// Change a scripted game in words: the model edits the code, and the result is checked.
export async function changeScriptInWords(spec: GameSpec, text: string, check: SandboxCheck): Promise<{ ok: true; spec: GameSpec; summary: string } | { ok: false; reason: string }> {
  if (!MODEL_SCRIPTS_ENABLED) return { ok: false, reason: "This game is built from a ready template, so it cannot be changed in words on this machine; model-written game code is turned off." };
  const code = spec.script?.code ?? "";
  const out = await askForScript(`Change this game: ${text}\nKeep everything else the same and return the whole game.\n\nCode:\n${code.slice(0, 14000)}`, 0.3);
  if ("error" in out) return { ok: false, reason: out.error };
  const problems = checkScript(out.code);
  if (problems.length) return { ok: false, reason: `The change broke the game: ${problems[0]}` };
  const next: GameSpec = { ...spec, script: { ...spec.script!, code: out.code } };
  const r = await check(next);
  if (!r.ok) return { ok: false, reason: `The change broke the game: ${r.error}` };
  return { ok: true, spec: next, summary: text.slice(0, 80) };
}
