// Strict validation and best-effort repair of a Game Spec. Repair either returns a spec that
// validates, or throws a SpecError that lists exactly what could not be fixed.
import { ACTIONS, ART_STYLES, GENRES, MOODS, SFX_PRESETS, TILE_CHARS, WEATHERS } from "./types.ts";
import type { AssetRef, Behavior, EntityDef, GameSpec, Genre, LevelDef, Rule } from "./types.ts";
import { BEHAVIORS, clampParam } from "./behaviors.ts";
import { checkScript } from "../runtime/script.ts";
import { defaultControls, defaultHud, defaultMenus, defaultRules, PALETTES } from "./defaults.ts";

export class SpecError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`Game Spec is invalid: ${errors.slice(0, 6).join("; ")}${errors.length > 6 ? ` (+${errors.length - 6} more)` : ""}`);
    this.errors = errors;
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const RULE_WHEN = ["reach-goal", "collect-all", "defeat-all", "survive", "score-at-least", "no-lives", "time-up", "health-zero", "base-reached"];
const HUD = ["score", "lives", "health", "timer", "collected", "level", "distance", "parts", "currency", "wave"];
const MENUS = ["title", "pause", "win", "lose", "level"];
const KINDS = ["player", "enemy", "pickup", "platform", "hazard", "npc", "prop", "goal", "part", "unit"];
const ASSET_KINDS = ["sprite", "tileset", "background", "ui", "sfx", "music"];
const ASSET_SOURCES = ["procedural", "generated", "placeholder", "user"];
export const MAX_LEVEL_W = 1200;
export const MAX_LEVEL_H = 200;

function checkEntity(e: any, where: string, assets: Record<string, AssetRef>, errs: string[]) {
  if (!isObj(e)) return errs.push(`${where} is not an object`);
  if (typeof e.id !== "string" || !ID.test(e.id)) errs.push(`${where}.id must be a short identifier`);
  if (e.kind !== undefined && !KINDS.includes(e.kind)) errs.push(`${where}.kind "${e.kind}" is unknown`);
  if (typeof e.sprite !== "string" || !assets?.[e.sprite]) errs.push(`${where}.sprite "${e.sprite}" is not an asset`);
  if (!Array.isArray(e.size) || e.size.length !== 2 || !e.size.every((s: any) => typeof s === "number" && s > 0 && s <= 16))
    errs.push(`${where}.size must be two numbers between 0 and 16 tiles`);
  if (e.body !== undefined) {
    if (!isObj(e.body)) errs.push(`${where}.body must be an object`);
    else {
      if (!["static", "dynamic", "kinematic"].includes(e.body.type)) errs.push(`${where}.body.type is invalid`);
      if (!["box", "circle", "capsule"].includes(e.body.shape)) errs.push(`${where}.body.shape is invalid`);
      for (const k of ["friction", "bounce"])
        if (e.body[k] !== undefined && !(typeof e.body[k] === "number" && e.body[k] >= 0 && e.body[k] <= 1.5))
          errs.push(`${where}.body.${k} must be between 0 and 1.5`);
    }
  }
  if (!Array.isArray(e.behaviors)) errs.push(`${where}.behaviors must be a list`);
  else
    e.behaviors.forEach((bh: any, i: number) => {
      const lib = BEHAVIORS[bh?.type as keyof typeof BEHAVIORS];
      if (!lib) return errs.push(`${where}.behaviors[${i}] "${bh?.type}" is not in the behavior library`);
      if (bh.params !== undefined && !isObj(bh.params)) return errs.push(`${where}.behaviors[${i}].params must be an object`);
      for (const [k, v] of Object.entries(bh.params || {})) {
        const d = lib.params[k];
        if (!d) errs.push(`${where}.behaviors[${i}] (${bh.type}) has unknown parameter "${k}"`);
        else if (clampParam(d, v) !== v) errs.push(`${where}.behaviors[${i}] (${bh.type}).${k} = ${JSON.stringify(v)} is outside its safe range`);
      }
    });
  if (e.stats !== undefined && (!isObj(e.stats) || !Object.values(e.stats).every((v) => typeof v === "number" && Number.isFinite(v))))
    errs.push(`${where}.stats must map names to numbers`);
}

function checkLevel(l: any, i: number, spec: any, errs: string[]) {
  const w = `levels[${i}]`;
  if (!isObj(l)) return errs.push(`${w} is not an object`);
  if (typeof l.id !== "string" || !ID.test(l.id)) errs.push(`${w}.id must be a short identifier`);
  if (typeof l.name !== "string" || !l.name) errs.push(`${w}.name is required`);
  const [cols, rows] = Array.isArray(l.size) ? l.size : [0, 0];
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 4 || rows < 4 || cols > MAX_LEVEL_W || rows > MAX_LEVEL_H)
    return errs.push(`${w}.size must be whole tiles between 4 and ${MAX_LEVEL_W}x${MAX_LEVEL_H}`);
  if (![8, 12, 16, 24, 32, 48, 64].includes(l.tileSize)) errs.push(`${w}.tileSize must be one of 8, 12, 16, 24, 32, 48, 64`);
  if (!spec.assets?.[l.tileset]) errs.push(`${w}.tileset "${l.tileset}" is not an asset`);
  if (!Array.isArray(l.tiles) || l.tiles.length !== rows) errs.push(`${w}.tiles must have ${rows} rows`);
  else
    l.tiles.forEach((row: any, r: number) => {
      if (typeof row !== "string" || row.length !== cols) errs.push(`${w}.tiles[${r}] must have ${cols} characters`);
      else for (const ch of row) if (!TILE_CHARS.has(ch as any)) { errs.push(`${w}.tiles[${r}] has unknown tile "${ch}"`); break; }
    });
  if (!Array.isArray(l.spawn) || l.spawn.length !== 2 || !(l.spawn[0] >= 0 && l.spawn[0] < cols && l.spawn[1] >= 0 && l.spawn[1] < rows))
    errs.push(`${w}.spawn must be inside the level`);
  else if (Array.isArray(l.tiles) && "#WB".includes(l.tiles[Math.floor(l.spawn[1])]?.[Math.floor(l.spawn[0])]))
    errs.push(`${w}.spawn is inside a solid tile`);
  const defs = new Set([spec.player?.id, ...(spec.entities || []).map((e: any) => e?.id)]);
  if (!Array.isArray(l.placements)) errs.push(`${w}.placements must be a list`);
  else
    l.placements.forEach((p: any, j: number) => {
      if (!isObj(p) || !defs.has(p.def)) errs.push(`${w}.placements[${j}] refers to unknown entity "${p?.def}"`);
      else if (!(typeof p.x === "number" && typeof p.y === "number" && p.x >= -1 && p.y >= -1 && p.x <= cols + 1 && p.y <= rows + 1))
        errs.push(`${w}.placements[${j}] is outside the level`);
    });
  if (!Array.isArray(l.background)) errs.push(`${w}.background must be a list`);
  else
    l.background.forEach((b: any, j: number) => {
      if (!isObj(b) || !spec.assets?.[b.asset]) errs.push(`${w}.background[${j}] asset "${b?.asset}" is missing`);
      else if (!(typeof b.speed === "number" && b.speed >= 0 && b.speed <= 1.5)) errs.push(`${w}.background[${j}].speed must be 0 to 1.5`);
    });
  if (l.music !== undefined && !(spec.audio?.music || []).some((m: any) => m?.id === l.music)) errs.push(`${w}.music "${l.music}" is not a music cue`);
  if (l.weather !== undefined && !WEATHERS.includes(l.weather)) errs.push(`${w}.weather "${l.weather}" is unknown`);
  if (l.weatherAmount !== undefined && !(typeof l.weatherAmount === "number" && l.weatherAmount >= 0 && l.weatherAmount <= 1)) errs.push(`${w}.weatherAmount must be 0 to 1`);
  if (l.tint !== undefined && !(typeof l.tint === "string" && HEX.test(l.tint))) errs.push(`${w}.tint must be a color like #a1b2c3`);
  if (l.lanes !== undefined) {
    const g = l.lanes;
    if (!isObj(g) || ![g.x0, g.y0, g.cell, g.cols, g.rows].every((v) => Number.isInteger(v) && v >= 0) || g.cell < 1 || g.cols < 1 || g.rows < 1 || g.x0 + g.cols * g.cell > cols || g.y0 + g.rows * g.cell > rows)
      errs.push(`${w}.lanes must be a grid inside the level`);
  }
  if (l.shop !== undefined) {
    if (!Array.isArray(l.shop) || l.shop.length > 9) errs.push(`${w}.shop must list up to 9 things to buy`);
    else l.shop.forEach((it: any, j: number) => {
      if (!defs.has(it?.def) || !(typeof it.cost === "number" && it.cost >= 0 && it.cost <= 10000) || (it.cooldown !== undefined && !(it.cooldown >= 0 && it.cooldown <= 120))) errs.push(`${w}.shop[${j}] is invalid`);
    });
  }
  if (l.economy !== undefined && !(isObj(l.economy) && l.economy.start >= 0 && l.economy.start <= 100000 && l.economy.perSecond >= 0 && l.economy.perSecond <= 1000)) errs.push(`${w}.economy is invalid`);
  if (l.parts !== undefined) {
    if (!Array.isArray(l.parts)) errs.push(`${w}.parts must be a list`);
    else l.parts.forEach((p: any, j: number) => {
      if (!defs.has(p?.def) || !(Number.isInteger(p.count) && p.count >= 0 && p.count <= 50)) errs.push(`${w}.parts[${j}] is invalid`);
    });
  }
}

function checkRule(r: any, i: number, errs: string[]) {
  const w = `rules[${i}]`;
  if (!isObj(r)) return errs.push(`${w} is not an object`);
  switch (r.type) {
    case "win":
    case "lose":
      if (!RULE_WHEN.includes(r.when)) errs.push(`${w}.when "${r.when}" is unknown`);
      break;
    case "lives":
      if (!(Number.isInteger(r.count) && r.count >= 1 && r.count <= 99)) errs.push(`${w}.count must be 1 to 99`);
      break;
    case "timer":
      if (!(typeof r.seconds === "number" && r.seconds >= 0 && r.seconds <= 3600)) errs.push(`${w}.seconds must be 0 to 3600`);
      break;
    case "score":
      if (!["collect", "defeat", "finish", "distance"].includes(r.event)) errs.push(`${w}.event is unknown`);
      if (!(typeof r.points === "number" && r.points >= 0 && r.points <= 100000)) errs.push(`${w}.points must be 0 to 100000`);
      break;
    default:
      errs.push(`${w}.type "${r.type}" is unknown`);
  }
}

export function validateSpec(spec: any): { ok: boolean; errors: string[] } {
  const errs: string[] = [];
  if (!isObj(spec)) return { ok: false, errors: ["spec must be an object"] };
  if (spec.version !== 1) errs.push("version must be 1");
  const m = spec.meta;
  if (!isObj(m)) errs.push("meta is required");
  else {
    if (typeof m.title !== "string" || !m.title.trim() || m.title.length > 80) errs.push("meta.title must be 1 to 80 characters");
    if (!GENRES.includes(m.genre)) errs.push(`meta.genre "${m.genre}" is not supported`);
    if (typeof m.pitch !== "string") errs.push("meta.pitch must be text");
    if (!ART_STYLES.includes(m.artStyle)) errs.push(`meta.artStyle "${m.artStyle}" is unknown`);
    if (!Array.isArray(m.palette) || m.palette.length < 3 || m.palette.length > 32 || !m.palette.every((c: any) => HEX.test(c)))
      errs.push("meta.palette must be 3 to 32 colors like #a1b2c3");
  }
  if (!isObj(spec.assets)) errs.push("assets is required");
  else
    for (const [id, a] of Object.entries<any>(spec.assets)) {
      if (!ID.test(id)) errs.push(`asset id "${id}" is invalid`);
      if (!isObj(a) || !ASSET_KINDS.includes(a.kind) || !ASSET_SOURCES.includes(a.source) || typeof a.recipe !== "string" || !Number.isInteger(a.seed))
        errs.push(`assets.${id} needs kind, source, recipe and an integer seed`);
      else if (a.data !== undefined && !(typeof a.data === "string" && /^data:image\/(png|webp|jpeg);base64,/.test(a.data)))
        errs.push(`assets.${id}.data must be an image data URL`);
    }
  checkEntity(spec.player, "player", spec.assets, errs);
  if (!Array.isArray(spec.entities)) errs.push("entities must be a list");
  else {
    const seen = new Set([spec.player?.id]);
    spec.entities.forEach((e: any, i: number) => {
      checkEntity(e, `entities[${i}]`, spec.assets, errs);
      if (seen.has(e?.id)) errs.push(`entities[${i}].id "${e?.id}" is used twice`);
      seen.add(e?.id);
    });
  }
  if (!Array.isArray(spec.rules)) errs.push("rules must be a list");
  else {
    spec.rules.forEach((r: any, i: number) => checkRule(r, i, errs));
    if (!spec.rules.some((r: any) => r?.type === "win")) errs.push("rules need at least one win condition");
  }
  if (!isObj(spec.controls)) errs.push("controls are required");
  else for (const a of ACTIONS) if (!Array.isArray(spec.controls[a]) || !spec.controls[a].every((k: any) => typeof k === "string")) errs.push(`controls.${a} must be a list of keys`);
  if (!Array.isArray(spec.levels) || spec.levels.length < 1 || spec.levels.length > 30) errs.push("levels must have 1 to 30 levels");
  else {
    spec.levels.forEach((l: any, i: number) => checkLevel(l, i, spec, errs));
    const ids = spec.levels.map((l: any) => l?.id);
    if (new Set(ids).size !== ids.length) errs.push("level ids must be unique");
  }
  if (!isObj(spec.audio) || !Array.isArray(spec.audio.music) || !isObj(spec.audio.sfx)) errs.push("audio needs music and sfx");
  else {
    spec.audio.music.forEach((c: any, i: number) => {
      if (!isObj(c) || typeof c.id !== "string" || !MOODS.includes(c.mood) || !Number.isInteger(c.seed)) errs.push(`audio.music[${i}] is invalid`);
      else if (c.tempo !== undefined && !(c.tempo >= 50 && c.tempo <= 200)) errs.push(`audio.music[${i}].tempo must be 50 to 200`);
    });
    for (const [k, s] of Object.entries<any>(spec.audio.sfx))
      if (!isObj(s) || !SFX_PRESETS.includes(s.preset) || !Number.isInteger(s.seed)) errs.push(`audio.sfx.${k} is invalid`);
  }
  if (!isObj(spec.ui) || !Array.isArray(spec.ui.hud) || !Array.isArray(spec.ui.menus)) errs.push("ui needs hud and menus");
  else {
    spec.ui.hud.forEach((h: any, i: number) => { if (!HUD.includes(h?.kind)) errs.push(`ui.hud[${i}] kind is unknown`); });
    spec.ui.menus.forEach((mm: any, i: number) => {
      if (!MENUS.includes(mm?.id) || typeof mm.title !== "string" || !Array.isArray(mm.items)) errs.push(`ui.menus[${i}] is invalid`);
    });
  }
  if (spec.script !== undefined) {
    if (!isObj(spec.script)) errs.push("script must be an object with code");
    else for (const e of checkScript(spec.script.code)) errs.push(`script: ${e}`);
  }
  return { ok: errs.length === 0, errors: errs };
}

// ---------- repair ----------

const slug = (s: unknown, fallback: string) => {
  const v = String(s ?? "").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[^a-zA-Z]+/, "").slice(0, 40);
  return v || fallback;
};
const num = (v: unknown, lo: number, hi: number, d: number) => {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};
const intSeed = (v: unknown, fallback: number) => (Number.isInteger(v) ? (v as number) : Math.abs(Math.floor(Number(v))) || fallback);
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function repairBehaviors(list: unknown, fixes: string[], where: string): Behavior[] {
  if (!Array.isArray(list)) return [];
  const out: Behavior[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const bh = typeof raw === "string" ? { type: raw } : raw;
    const lib = BEHAVIORS[bh?.type as keyof typeof BEHAVIORS];
    if (!lib) {
      fixes.push(`${where}: dropped unknown behavior "${bh?.type}"`);
      continue;
    }
    if (seen.has(bh.type) && bh.type !== "shoot") continue;
    seen.add(bh.type);
    const params: Record<string, any> = {};
    for (const [k, v] of Object.entries(isObj(bh.params) ? bh.params : {})) {
      const d = lib.params[k];
      if (!d) continue;
      const c = clampParam(d, v);
      if (c !== v) fixes.push(`${where}: ${bh.type}.${k} ${JSON.stringify(v)} → ${JSON.stringify(c)}`);
      params[k] = c;
    }
    out.push(Object.keys(params).length ? { type: bh.type, params } : { type: bh.type });
  }
  return out;
}

function ensureAsset(spec: any, id: string, kind: AssetRef["kind"], recipe: string) {
  if (!isObj(spec.assets[id])) spec.assets[id] = { kind, source: "placeholder", seed: hashString(id) % 100000, recipe };
}

function repairEntity(e: any, where: string, spec: any, fixes: string[], fallbackId: string): EntityDef {
  const src = isObj(e) ? e : {};
  const id = isId(src.id) ? src.id : slug(src.id ?? src.name, fallbackId);
  const size: [number, number] = Array.isArray(src.size) && src.size.length === 2
    ? [num(src.size[0], 0.25, 16, 1), num(src.size[1], 0.25, 16, 1)]
    : [1, 1];
  const sprite = typeof src.sprite === "string" && ID.test(src.sprite) ? src.sprite : `${id}-sprite`;
  ensureAsset(spec, sprite, "sprite", String(src.name || id));
  const out: EntityDef = { id, sprite, size, behaviors: repairBehaviors(src.behaviors, fixes, where) };
  if (KINDS.includes(src.kind)) out.kind = src.kind;
  if (typeof src.name === "string") out.name = src.name.slice(0, 60);
  if (isObj(src.body)) {
    out.body = {
      type: ["static", "dynamic", "kinematic"].includes(src.body.type) ? src.body.type : "dynamic",
      shape: ["box", "circle", "capsule"].includes(src.body.shape) ? src.body.shape : "box",
    };
    for (const k of ["friction", "bounce"] as const) if (src.body[k] !== undefined) out.body[k] = num(src.body[k], 0, 1.5, 0.2);
    for (const k of ["sensor", "solid", "gravity"] as const) if (typeof src.body[k] === "boolean") out.body[k] = src.body[k];
  }
  if (isObj(src.stats)) {
    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(src.stats)) if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
    out.stats = stats;
  }
  if (Array.isArray(src.tags)) out.tags = src.tags.filter((t: any) => typeof t === "string").slice(0, 8);
  return out;
}

function repairLevel(l: any, i: number, spec: any, genre: Genre, fixes: string[]): LevelDef {
  const src = isObj(l) ? l : {};
  const tileSize = [8, 12, 16, 24, 32, 48, 64].includes(src.tileSize) ? src.tileSize : 16;
  let rows: string[] = Array.isArray(src.tiles) ? src.tiles.map((r: any) => (typeof r === "string" ? r : "")) : [];
  let cols = Math.round(num(src.size?.[0], 4, MAX_LEVEL_W, Math.max(4, ...rows.map((r) => r.length), 40)));
  let h = Math.round(num(src.size?.[1], 4, MAX_LEVEL_H, Math.max(4, rows.length || 16)));
  if (!rows.length) {
    rows = Array.from({ length: h }, (_, r) => (r >= h - 2 ? "#" : ".").repeat(cols));
    fixes.push(`levels[${i}]: had no tiles, added flat ground`);
  }
  rows = rows.slice(0, h);
  while (rows.length < h) rows.push(".".repeat(cols));
  rows = rows.map((r) => [...r.padEnd(cols, ".").slice(0, cols)].map((c) => (TILE_CHARS.has(c as any) ? c : ".")).join(""));
  const solid = (x: number, y: number) => "#WB".includes(rows[y]?.[x] ?? "#");
  let spawn: [number, number] = Array.isArray(src.spawn) ? [num(src.spawn[0], 0, cols - 1, 1), num(src.spawn[1], 0, h - 1, 1)] : [1, 1];
  if (solid(Math.floor(spawn[0]), Math.floor(spawn[1]))) {
    // Nearest free cell, searching outward.
    let best: [number, number] | null = null;
    for (let r = 1; r < Math.max(cols, h) && !best; r++)
      for (let dy = -r; dy <= r && !best; dy++)
        for (let dx = -r; dx <= r && !best; dx++) {
          const x = Math.floor(spawn[0]) + dx, y = Math.floor(spawn[1]) + dy;
          if (x >= 0 && y >= 0 && x < cols && y < h && !solid(x, y)) best = [x, y];
        }
    if (best) {
      fixes.push(`levels[${i}]: moved spawn out of a wall`);
      spawn = best;
    }
  }
  const defs = new Set([spec.player.id, ...spec.entities.map((e: EntityDef) => e.id)]);
  const placements = (Array.isArray(src.placements) ? src.placements : []).filter((p: any) => {
    const ok = isObj(p) && defs.has(p.def) && Number.isFinite(p.x) && Number.isFinite(p.y);
    if (!ok) fixes.push(`levels[${i}]: dropped placement of "${p?.def}"`);
    return ok;
  }).map((p: any) => ({ ...p, x: num(p.x, -1, cols + 1, 0), y: num(p.y, -1, h + 1, 0) }));
  const tileset = typeof src.tileset === "string" && ID.test(src.tileset) ? src.tileset : "tiles";
  ensureAsset(spec, tileset, "tileset", "ground");
  const background = (Array.isArray(src.background) ? src.background : [])
    .filter((b: any) => isObj(b) && typeof b.asset === "string" && ID.test(b.asset))
    .map((b: any) => {
      ensureAsset(spec, b.asset, "background", "hills");
      return { asset: b.asset, speed: num(b.speed, 0, 1.5, 0.3), ...(typeof b.y === "number" ? { y: b.y } : {}) };
    });
  const out: LevelDef = {
    id: isId(src.id) ? src.id : `level-${i + 1}`,
    name: typeof src.name === "string" && src.name ? src.name.slice(0, 60) : `Level ${i + 1}`,
    size: [cols, h],
    tileSize,
    tileset,
    tiles: rows,
    spawn,
    placements,
    background,
  };
  for (const k of ["beat", "story"] as const) if (typeof src[k] === "string") (out as any)[k] = src[k];
  if (typeof src.tint === "string" && HEX.test(src.tint)) out.tint = src.tint;
  if (WEATHERS.includes(src.weather)) out.weather = src.weather;
  if (typeof src.weatherAmount === "number") out.weatherAmount = num(src.weatherAmount, 0, 1, 0.5);
  if (Array.isArray(src.solution))
    out.solution = src.solution.filter((p: any) => isObj(p) && typeof p.def === "string" && [p.x, p.y, p.angle].every(Number.isFinite)).slice(0, 20);
  if (typeof src.music === "string") {
    if (!spec.audio.music.some((m: any) => m.id === src.music))
      spec.audio.music.push({ id: src.music, mood: "adventure", seed: hashString(src.music) % 10000 });
    out.music = src.music;
  }
  if (typeof src.gravity === "number") out.gravity = num(src.gravity, 0, 200, 60);
  if (typeof src.difficulty === "number") out.difficulty = num(src.difficulty, 0, 1, 0.3);
  if (Number.isInteger(src.seed)) out.seed = src.seed;
  if (src.endless === true) out.endless = true;
  if (isObj(src.lanes)) {
    const g = src.lanes;
    const lanes = { x0: Math.round(num(g.x0, 0, cols - 1, 1)), y0: Math.round(num(g.y0, 0, h - 1, 2)), cell: Math.round(num(g.cell, 1, 8, 3)), cols: Math.round(num(g.cols, 1, 20, 9)), rows: Math.round(num(g.rows, 1, 12, 5)) };
    lanes.cols = Math.min(lanes.cols, Math.floor((cols - lanes.x0) / lanes.cell));
    lanes.rows = Math.min(lanes.rows, Math.floor((h - lanes.y0) / lanes.cell));
    if (lanes.cols >= 1 && lanes.rows >= 1) out.lanes = lanes;
  }
  if (Array.isArray(src.shop))
    out.shop = src.shop.filter((it: any) => isObj(it) && defs.has(it.def)).slice(0, 9).map((it: any) => ({ def: it.def, cost: Math.round(num(it.cost, 0, 10000, 50)), ...(it.cooldown !== undefined ? { cooldown: num(it.cooldown, 0, 120, 5) } : {}) }));
  if (isObj(src.economy)) out.economy = { start: num(src.economy.start, 0, 100000, 50), perSecond: num(src.economy.perSecond, 0, 1000, 0) };
  if (Array.isArray(src.parts))
    out.parts = src.parts.filter((p: any) => defs.has(p?.def)).map((p: any) => ({ def: p.def, count: Math.round(num(p.count, 0, 50, 1)) }));
  void genre;
  return out;
}

function repairRule(r: any): Rule | null {
  if (!isObj(r)) return null;
  switch (r.type) {
    case "win":
    case "lose":
      return RULE_WHEN.includes(r.when) ? { type: r.type, when: r.when, ...(typeof r.value === "number" ? { value: r.value } : {}), ...(typeof r.tag === "string" ? { tag: r.tag } : {}) } : null;
    case "lives":
      return { type: "lives", count: Math.round(num(r.count, 1, 99, 3)) };
    case "timer":
      return { type: "timer", seconds: num(r.seconds, 0, 3600, 60), ...(typeof r.countDown === "boolean" ? { countDown: r.countDown } : {}) };
    case "score":
      return ["collect", "defeat", "finish", "distance"].includes(r.event) ? { type: "score", event: r.event, points: num(r.points, 0, 100000, 10), ...(typeof r.tag === "string" ? { tag: r.tag } : {}) } : null;
  }
  return null;
}

// Repair anything spec-shaped into a valid spec. Returns the fixes applied, or throws SpecError.
export function repairSpec(input: any): { spec: GameSpec; fixes: string[] } {
  const fixes: string[] = [];
  const src = isObj(input) ? input : {};
  const metaIn = isObj(src.meta) ? src.meta : {};
  const genre: Genre = GENRES.includes(metaIn.genre) ? metaIn.genre : "platformer";
  if (metaIn.genre !== genre) fixes.push(`meta.genre → ${genre}`);
  const palette = Array.isArray(metaIn.palette) ? metaIn.palette.filter((c: any) => typeof c === "string" && HEX.test(c)).slice(0, 32) : [];
  const spec: any = {
    version: 1,
    meta: {
      title: typeof metaIn.title === "string" && metaIn.title.trim() ? metaIn.title.trim().slice(0, 80) : "Untitled Game",
      genre,
      pitch: typeof metaIn.pitch === "string" ? metaIn.pitch.slice(0, 600) : "",
      artStyle: ART_STYLES.includes(metaIn.artStyle) ? metaIn.artStyle : "pixel",
      palette: palette.length >= 3 ? palette : PALETTES.forest,
    },
    assets: {},
    audio: { music: [], sfx: {} },
  };
  if (isObj(src.assets))
    for (const [id0, a] of Object.entries<any>(src.assets)) {
      if (!isObj(a)) continue;
      const id = ID.test(id0) ? id0 : slug(id0, `asset-${Object.keys(spec.assets).length}`);
      const ref: any = {
        kind: ASSET_KINDS.includes(a.kind) ? a.kind : "sprite",
        source: ASSET_SOURCES.includes(a.source) ? a.source : "placeholder",
        seed: intSeed(a.seed, hashString(id) % 100000),
        recipe: typeof a.recipe === "string" && a.recipe ? a.recipe.slice(0, 80) : id,
      };
      if (typeof a.prompt === "string") ref.prompt = a.prompt.slice(0, 600);
      if (typeof a.data === "string" && /^data:image\/(png|webp|jpeg);base64,/.test(a.data)) ref.data = a.data;
      else if (ref.source === "generated" || ref.source === "user") ref.source = "placeholder";
      if (Number.isInteger(a.frames)) ref.frames = Math.min(32, Math.max(1, a.frames));
      if (typeof a.rig === "boolean") ref.rig = a.rig;
      if (Array.isArray(a.colors)) ref.colors = a.colors.filter((c: any) => HEX.test(c)).slice(0, 8);
      spec.assets[id] = ref;
    }
  if (isObj(src.audio)) {
    if (Array.isArray(src.audio.music))
      for (const c of src.audio.music)
        if (isObj(c) && typeof c.id === "string")
          spec.audio.music.push({
            id: c.id.slice(0, 40),
            mood: MOODS.includes(c.mood) ? c.mood : "adventure",
            seed: intSeed(c.seed, hashString(c.id) % 10000),
            ...(c.tempo !== undefined ? { tempo: Math.round(num(c.tempo, 50, 200, 110)) } : {}),
          });
    if (isObj(src.audio.sfx))
      for (const [k, s] of Object.entries<any>(src.audio.sfx))
        if (isObj(s) && SFX_PRESETS.includes(s.preset)) spec.audio.sfx[k] = { preset: s.preset, seed: intSeed(s.seed, hashString(k) % 10000), ...(isObj(s.params) ? { params: s.params } : {}) };
  }
  spec.player = repairEntity(src.player, "player", spec, fixes, "player");
  spec.player.kind = "player";
  spec.entities = [];
  const used = new Set([spec.player.id]);
  (Array.isArray(src.entities) ? src.entities : []).forEach((e: any, i: number) => {
    const ent = repairEntity(e, `entities[${i}]`, spec, fixes, `entity-${i + 1}`);
    while (used.has(ent.id)) ent.id = `${ent.id}-${i + 1}`.slice(0, 40);
    used.add(ent.id);
    spec.entities.push(ent);
  });
  spec.rules = (Array.isArray(src.rules) ? src.rules : []).map(repairRule).filter(Boolean);
  if (!spec.rules.some((r: Rule) => r.type === "win")) {
    fixes.push("rules: added the default win condition for the genre");
    spec.rules = [...defaultRules(genre).filter((r) => !spec.rules.some((x: Rule) => x.type === r.type && (x as any).when === (r as any).when)), ...spec.rules];
  }
  const dc = defaultControls(genre);
  spec.controls = {};
  for (const a of ACTIONS) spec.controls[a] = Array.isArray(src.controls?.[a]) ? src.controls[a].filter((k: any) => typeof k === "string").slice(0, 6) : dc[a];
  const levels = Array.isArray(src.levels) ? src.levels.slice(0, 30) : [];
  if (!levels.length) throw new SpecError(["the spec has no levels; generate levels before repair"]);
  spec.levels = levels.map((l: any, i: number) => repairLevel(l, i, spec, genre, fixes));
  const ids = new Set<string>();
  for (const l of spec.levels) {
    while (ids.has(l.id)) l.id = `${l.id}-b`;
    ids.add(l.id);
  }
  spec.ui = {
    hud: Array.isArray(src.ui?.hud) ? src.ui.hud.filter((h: any) => HUD.includes(h?.kind)) : defaultHud(genre),
    menus: Array.isArray(src.ui?.menus)
      ? src.ui.menus.filter((mm: any) => MENUS.includes(mm?.id) && typeof mm.title === "string").map((mm: any) => ({ id: mm.id, title: mm.title.slice(0, 60), items: (Array.isArray(mm.items) ? mm.items : []).filter((x: any) => typeof x === "string").slice(0, 8) }))
      : defaultMenus(spec.meta.title),
  };
  if (!spec.ui.menus.length) spec.ui.menus = defaultMenus(spec.meta.title);
  // Re-order so keys read naturally when the spec is shown to people.
  const ordered: GameSpec = {
    version: 1,
    meta: spec.meta,
    player: spec.player,
    entities: spec.entities,
    rules: spec.rules,
    controls: spec.controls,
    levels: spec.levels,
    audio: spec.audio,
    ui: spec.ui,
    assets: spec.assets,
  };
  if (isObj(src.script) && typeof src.script.code === "string")
    ordered.script = { code: src.script.code, ...(typeof src.script.howToPlay === "string" ? { howToPlay: src.script.howToPlay.slice(0, 300) } : {}), ...(typeof src.script.model === "string" ? { model: src.script.model.slice(0, 80) } : {}) };
  const v = validateSpec(ordered);
  if (!v.ok) throw new SpecError(v.errors);
  return { spec: ordered, fixes };
}

export function assertValid(spec: GameSpec): GameSpec {
  const v = validateSpec(spec);
  if (!v.ok) throw new SpecError(v.errors);
  return spec;
}
