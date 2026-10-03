// Step 9 of generation: live iteration. "Make the boss slower", "add a double jump", "more
// rain" become small validated spec patches. Common requests are understood directly;
// anything else goes to the local model, which answers with patch operations. Every patch
// is checked: the spec must validate, and physics changes must keep every level beatable.
import type { GameSpec, Weather } from "../spec/types.ts";
import { applyPatch, setParamOps, type PatchOp } from "../spec/patch.ts";
import { BEHAVIORS, clampParam } from "../spec/behaviors.ts";
import { PALETTES } from "../spec/defaults.ts";
import { reachableSide } from "../world/levels.ts";

export type PatchPlan = { ops: PatchOp[]; summary: string };
export type PatchOutcome = { ok: true; spec: GameSpec; summary: string; ops: PatchOp[] } | { ok: false; reason: string };

const MORE = /\b(more|higher|bigger|faster|stronger|longer|further|farther|increase|raise|extra|up)\b/;
const LESS = /\b(less|lower|smaller|slower|weaker|shorter|decrease|reduce|fewer|down)\b/;

function param(spec: GameSpec, entityId: string, behavior: string, name: string): number | undefined {
  const e = entityId === spec.player.id ? spec.player : spec.entities.find((x) => x.id === entityId);
  const b = e?.behaviors.find((x) => x.type === behavior);
  if (!b) return undefined;
  const def = BEHAVIORS[b.type].params[name];
  const v = b.params?.[name];
  return typeof v === "number" ? v : def?.kind === "number" ? def.default : undefined;
}
function scaleParam(spec: GameSpec, entityId: string, behavior: string, name: string, k: number): PatchOp[] {
  const cur = param(spec, entityId, behavior, name);
  if (cur === undefined) return [];
  const def = BEHAVIORS[behavior as keyof typeof BEHAVIORS].params[name];
  const next = Math.round((clampParam(def, cur * k) as number) * 100) / 100;
  return next === cur ? [] : setParamOps(spec, entityId, behavior, name, next) ?? [];
}

// Which entities a request is about: the player, the boss, enemies, or a named creature.
function subjects(spec: GameSpec, t: string): string[] {
  const hero = spec.player.name?.toLowerCase() ?? "";
  if (/\b(boss|giant)\b/.test(t)) return spec.entities.filter((e) => e.tags?.includes("boss")).map((e) => e.id);
  if (/\b(enem(y|ies)|monsters?|baddies|bad guys|foes?)\b/.test(t)) return spec.entities.filter((e) => e.kind === "enemy").map((e) => e.id);
  const named = spec.entities.filter((e) => e.name && e.kind === "enemy" && new RegExp(`\\b${e.name.split(" ").pop()}s?\\b`).test(t));
  if (named.length) return named.map((e) => e.id);
  if (/\b(me|i|player|hero|character)\b/.test(t) || (hero && t.includes(hero))) return [spec.player.id];
  return [];
}

export function planPatch(original: GameSpec, text: string): PatchPlan | null {
  // Plan against a copy where every behavior has a params object, so several edits to one
  // behavior never overwrite each other; the missing objects are created first.
  const spec = structuredClone(original);
  for (const e of [spec.player, ...spec.entities]) for (const b of e.behaviors) b.params ??= {};
  const plan = planOn(spec, text);
  if (!plan) return null;
  const prefix: PatchOp[] = [];
  const seen = new Set<string>();
  for (const op of plan.ops) {
    const m = /^(\/player|\/entities\/(\d+))\/behaviors\/(\d+)\/params\//.exec(op.path);
    if (!m) continue;
    const ent = m[2] === undefined ? original.player : original.entities[Number(m[2])];
    const base = `${m[1]}/behaviors/${m[3]}/params`;
    if (!ent?.behaviors[Number(m[3])]?.params && !seen.has(base)) {
      seen.add(base);
      prefix.push({ op: "add", path: base, value: {} });
    }
  }
  return { ops: [...prefix, ...plan.ops], summary: plan.summary };
}

function planOn(spec: GameSpec, text: string): PatchPlan | null {
  const title = /\b(?:call it|name it|rename(?: it| the game)?(?: to)?|title(?: it)?(?: to)?)\s+["“]?([^"”.!]{2,60})["”]?/i.exec(text);
  // The new title is a name, not a request: keep its words out of everything else.
  const t = ` ${(title ? text.replace(title[0], " ") : text).toLowerCase().trim()} `;
  const ops: PatchOp[] = [];
  const said: string[] = [];
  const hero = spec.player.id;
  const ctrl = spec.player.behaviors.find((b) => b.type === "platformer-controller" || b.type === "top-down-controller")?.type;

  // Jumps.
  if (/double[- ]?jump/.test(t) && ctrl === "platformer-controller") {
    const off = /\b(no|remove|without|disable|turn off)\b/.test(t);
    ops.push(...(setParamOps(spec, hero, "platformer-controller", "doubleJump", !off) ?? []));
    said.push(off ? "Double jump removed" : "Double jump added");
  } else if (/\bjump/.test(t) && ctrl === "platformer-controller" && (MORE.test(t) || LESS.test(t))) {
    const k = MORE.test(t) ? 1.25 : 0.8;
    ops.push(...scaleParam(spec, hero, "platformer-controller", "jumpHeight", k));
    said.push(k > 1 ? "Higher jump" : "Lower jump");
  }
  // Speeds.
  if (/\b(faster|slower|speed|quicker|quick|slow)\b/.test(t) && !/jump/.test(t)) {
    const k = /\b(faster|quicker|speed up|more speed)\b/.test(t) ? 1.3 : /\b(slower|slow down|less speed)\b/.test(t) ? 0.7 : 1;
    const who = subjects(spec, t);
    const targets = who.length ? who : [hero];
    if (k !== 1)
      for (const id of targets) {
        if (id === hero) {
          if (ctrl) ops.push(...scaleParam(spec, hero, ctrl, "speed", k));
          if (spec.player.behaviors.some((b) => b.type === "auto-run")) ops.push(...scaleParam(spec, hero, "auto-run", "speed", k), ...scaleParam(spec, hero, "auto-run", "max", k));
        } else for (const b of ["patrol", "chase", "flee", "march"]) ops.push(...scaleParam(spec, id, b, "speed", k));
      }
    if (k !== 1) said.push(`${targets.includes(hero) && targets.length === 1 ? "You are" : "They are"} ${k > 1 ? "faster" : "slower"}`);
  }
  // Weather.
  const kinds: [Weather, RegExp][] = [["rain", /\brain/], ["snow", /\bsnow/], ["leaves", /\bleaves|leaf/], ["embers", /\bembers?|sparks/], ["bubbles", /\bbubbles?/]];
  const w = kinds.find(([, re]) => re.test(t));
  if (w || /\b(weather|clear skies|clear sky|sunny)\b/.test(t)) {
    const off = /\b(no|stop|remove|without|clear|sunny|less)\b/.test(t) && !/\bmore\b/.test(t);
    spec.levels.forEach((l, i) => {
      if (/\b(no|stop|remove|without|clear|sunny)\b/.test(t)) {
        ops.push({ op: "add", path: `/levels/${i}/weather`, value: "none" });
        return;
      }
      const kind = w?.[0] ?? l.weather ?? "rain";
      const amount = l.weather === kind ? l.weatherAmount ?? 0.5 : 0.3;
      const next = off ? Math.max(0.1, amount - 0.3) : Math.min(1, amount + (l.weather === kind ? 0.3 : 0.3));
      ops.push({ op: "add", path: `/levels/${i}/weather`, value: kind }, { op: "add", path: `/levels/${i}/weatherAmount`, value: Math.round(next * 100) / 100 });
    });
    said.push(/\b(no|stop|remove|without|clear|sunny)\b/.test(t) ? "Clear skies" : off ? `Less ${w?.[0] ?? "weather"}` : `More ${w?.[0] ?? "weather"}`);
  }
  // Lives.
  const livesIdx = spec.rules.findIndex((r) => r.type === "lives");
  const livesN = /\b(\d+)\s+lives\b/.exec(t);
  if (/\blives?\b/.test(t) && !/\bno lives\b/.test(t)) {
    const cur = livesIdx >= 0 ? (spec.rules[livesIdx] as { count: number }).count : 1;
    const next = livesN ? Number(livesN[1]) : MORE.test(t) ? cur + 2 : LESS.test(t) ? Math.max(1, cur - 1) : cur;
    const count = Math.max(1, Math.min(99, next));
    if (livesIdx >= 0) ops.push({ op: "replace", path: `/rules/${livesIdx}/count`, value: count });
    else ops.push({ op: "add", path: "/rules/-", value: { type: "lives", count } });
    said.push(`${count} lives`);
  }
  // Easier / harder.
  if (/\b(easier|too hard|simpler)\b/.test(t) || /\b(harder|too easy|more challenging)\b/.test(t)) {
    const easier = /\b(easier|too hard|simpler)\b/.test(t);
    for (const e of spec.entities.filter((x) => x.kind === "enemy")) for (const b of ["patrol", "chase", "march"]) ops.push(...scaleParam(spec, e.id, b, "speed", easier ? 0.8 : 1.2));
    spec.levels.forEach((l, i) => {
      if (l.economy) ops.push({ op: "replace", path: `/levels/${i}/economy`, value: { start: Math.round(l.economy.start * (easier ? 1.3 : 0.85)), perSecond: Math.round(l.economy.perSecond * (easier ? 1.3 : 0.85) * 100) / 100 } });
    });
    if (ctrl === "platformer-controller") ops.push(...scaleParam(spec, hero, "platformer-controller", "jumpHeight", easier ? 1.1 : 0.95));
    if (livesIdx >= 0 && easier) ops.push({ op: "replace", path: `/rules/${livesIdx}/count`, value: Math.min(99, (spec.rules[livesIdx] as { count: number }).count + 1) });
    said.push(easier ? "A little easier" : "A little harder");
  }
  // Lane defense: income and enemy toughness.
  if (spec.levels.some((l) => l.economy) && /\b(sun|money|gold|coins?|income|currency|energy)\b/.test(t) && (MORE.test(t) || LESS.test(t))) {
    const k = LESS.test(t) ? 0.7 : 1.5;
    spec.levels.forEach((l, i) => {
      if (l.economy) ops.push({ op: "replace", path: `/levels/${i}/economy`, value: { start: Math.round(l.economy.start * k), perSecond: Math.round(l.economy.perSecond * k * 100) / 100 } });
    });
    for (const e of spec.entities.filter((x) => x.behaviors.some((b) => b.type === "producer"))) ops.push(...scaleParam(spec, e.id, "producer", "amount", k));
    said.push(k > 1 ? "More income" : "Less income");
  }
  if (/\b(tough|tougher|stronger|weaker|harder to kill|easier to kill|more health|less health)\b/.test(t)) {
    const k = /\b(weaker|easier to kill|less health)\b/.test(t) ? 0.7 : 1.5;
    const who = subjects(spec, t);
    const targets = who.length ? who : spec.entities.filter((e) => e.kind === "enemy").map((e) => e.id);
    for (const id of targets) ops.push(...scaleParam(spec, id, "health", "hp", k));
    said.push(k > 1 ? "Tougher enemies" : "Weaker enemies");
  }
  // Remove the boss.
  if (/\b(remove|no|delete|without)\b.*\bboss\b/.test(t)) {
    const bosses = new Set(spec.entities.filter((e) => e.tags?.includes("boss")).map((e) => e.id));
    spec.levels.forEach((l, i) => {
      const keep = l.placements.filter((p) => !bosses.has(p.def));
      if (keep.length !== l.placements.length) ops.push({ op: "replace", path: `/levels/${i}/placements`, value: keep });
    });
    said.push("Boss removed");
  }
  // Springs.
  if (/\b(springs?|bounce|bouncier|trampolines?)\b/.test(t) && (MORE.test(t) || LESS.test(t) || /bouncier/.test(t))) {
    const k = LESS.test(t) ? 0.8 : 1.25;
    for (const e of spec.entities.filter((x) => x.behaviors.some((b) => b.type === "bouncy"))) ops.push(...scaleParam(spec, e.id, "bouncy", "power", k));
    said.push(k > 1 ? "Bouncier springs" : "Softer springs");
  }
  // Gravity.
  if (/\b(gravity|floaty|moon)\b/.test(t)) {
    const k = /\b(less|lower|floaty|moon|weaker)\b/.test(t) ? 0.75 : 1.2;
    spec.levels.forEach((l, i) => {
      const g = l.gravity ?? ({ platformer: 60, runner: 70, builder: 40, "top-down": 0, arena: 0, puzzle: 0, defense: 0 } as Record<string, number>)[spec.meta.genre];
      if (g > 0) ops.push({ op: "add", path: `/levels/${i}/gravity`, value: Math.round(Math.max(20, Math.min(120, g * k))) });
    });
    said.push(k < 1 ? "Floatier gravity" : "Heavier gravity");
  }
  // Title.
  if (title) {
    ops.push({ op: "replace", path: "/meta/title", value: title[1].trim() });
    const ti = spec.ui.menus.findIndex((m) => m.id === "title");
    if (ti >= 0) ops.push({ op: "replace", path: `/ui/menus/${ti}/title`, value: title[1].trim() });
    said.push(`Renamed to ${title[1].trim()}`);
  }
  // Colours and art style.
  const pal = Object.keys(PALETTES).find((p) => new RegExp(`\\b${p}\\b`).test(t) && /\b(colou?rs?|palette|theme|look|feel)\b/.test(t));
  const mood = /\b(darker|spooky|night ?time|at night)\b/.test(t) ? "night" : /\b(sweeter|pinker|candy)\b/.test(t) ? "candy" : null;
  if (pal || mood) {
    ops.push({ op: "replace", path: "/meta/palette", value: PALETTES[(pal ?? mood)!] });
    said.push(`${pal ?? mood} colours`);
  }
  const style = /\bpixel( art)?\b/.test(t) ? "pixel" : /\b(flat|vector)\b/.test(t) ? "flat" : /\bpaint(ed|erly)?\b/.test(t) ? "painted" : null;
  if (style && /\b(style|art|look|make it)\b/.test(t)) {
    ops.push({ op: "replace", path: "/meta/artStyle", value: style });
    said.push(`${style} art`);
  }
  // Timer.
  if (/\b(timer|time limit|clock)\b/.test(t)) {
    const off = /\b(no|remove|without|stop)\b/.test(t);
    const rules = spec.rules.filter((r) => r.type !== "timer" && !(r.type === "lose" && r.when === "time-up"));
    const secs = Number(/\b(\d+)[\s-]*(s|secs?|seconds?|minutes?|mins?)\b/.exec(t)?.[1] ?? 0) * (/\bmin/.test(t) ? 60 : 1) || 120;
    ops.push({ op: "replace", path: "/rules", value: off ? rules : [...rules, { type: "timer", seconds: Math.min(3600, secs), countDown: true }, { type: "lose", when: "time-up" }] });
    said.push(off ? "No timer" : `A ${secs} second timer`);
  }
  // Size.
  if (/\b(bigger|larger|smaller|tinier|tiny|huge)\b/.test(t) && /\b(me|player|hero|character)\b/.test(t)) {
    const k = /\b(bigger|larger|huge)\b/.test(t) ? 1.2 : 0.85;
    const [w, h] = spec.player.size;
    ops.push({ op: "replace", path: "/player/size", value: [Math.min(1.4, Math.max(0.4, Math.round(w * k * 100) / 100)), Math.min(1.8, Math.max(0.4, Math.round(h * k * 100) / 100))] });
    said.push(k > 1 ? "Bigger hero" : "Smaller hero");
  }
  if (!ops.length) return null;
  return { ops, summary: said.join(" · ") };
}

// Apply a patch only if the result validates and every side-view level stays reachable
// with the new physics.
export function safeApply(spec: GameSpec, ops: PatchOp[], summary = "Updated"): PatchOutcome {
  let next: GameSpec;
  try {
    next = applyPatch(spec, ops);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const side = next.meta.genre === "platformer" || next.meta.genre === "runner";
  const physics = JSON.stringify(spec.player.behaviors) !== JSON.stringify(next.player.behaviors) || spec.levels.some((l, i) => l.gravity !== next.levels[i]?.gravity);
  if (side && physics)
    for (let i = 0; i < next.levels.length; i++) {
      const l = next.levels[i];
      const after = reachableSide(next, l);
      // Only a change that breaks a level that worked before is refused.
      if (!after.ok && reachableSide(spec, spec.levels[i]).ok) return { ok: false, reason: `That would make “${l.name}” impossible to finish (${after.missing[0]}).` };
    }
  return { ok: true, spec: next, summary, ops };
}

// A compact description of the spec for the model: where things live and what can change.
export function specOutline(spec: GameSpec): string {
  const ent = (e: GameSpec["player"], path: string) =>
    `${path} id=${e.id} kind=${e.kind ?? ""} name=${e.name ?? ""} size=${JSON.stringify(e.size)} behaviors=${e.behaviors.map((b, i) => `${i}:${b.type}${b.params ? JSON.stringify(b.params) : ""}`).join(" ")}`;
  return [
    `meta: ${JSON.stringify(spec.meta)}`,
    ent(spec.player, "/player"),
    ...spec.entities.map((e, i) => ent(e, `/entities/${i}`)),
    `rules: ${JSON.stringify(spec.rules)}`,
    ...spec.levels.map((l, i) => `/levels/${i} id=${l.id} name=${l.name} weather=${l.weather ?? "none"} weatherAmount=${l.weatherAmount ?? 0} music=${l.music ?? ""} gravity=${l.gravity ?? "default"} tint=${l.tint ?? ""}`),
    `music cues: ${spec.audio.music.map((m) => `${m.id}(${m.mood})`).join(", ")}`,
  ].join("\n");
}

export const PATCH_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    ops: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: { op: { type: "string", enum: ["replace", "add", "remove"] }, path: { type: "string" }, value: {} },
        required: ["op", "path"],
      },
    },
  },
  required: ["summary", "ops"],
};

export const PATCH_SYSTEM = `You edit a 2D game's JSON spec with JSON Pointer patch operations (RFC 6902 subset: replace, add, remove).
Only change what the person asked. Behavior params must stay within these ranges:
${Object.entries(BEHAVIORS)
  .map(([k, v]) => `${k}: ${Object.entries(v.params).map(([p, d]) => (d.kind === "number" ? `${p} ${d.min}-${d.max}` : d.kind === "enum" ? `${p} ${d.values.join("|")}` : `${p} ${d.kind}`)).join(", ")}`)
  .join("\n")}
Level fields: weather none|rain|snow|leaves|embers|bubbles, weatherAmount 0-1, tint #rrggbb, gravity 0-200.
To set a behavior param use a path like /player/behaviors/0/params/jumpHeight (add creates it).
Reply only with JSON: {"summary": "...", "ops": [...]}.`;
