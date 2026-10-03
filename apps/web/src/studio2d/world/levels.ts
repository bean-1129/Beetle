// World building: outline → layout → populate → validate → decorate, for every genre.
// The language model is good at ideas and bad at geometry, so every level is checked by
// code: reachability with the player's real physics, a difficulty budget, and the playtest
// bot. Levels that fail are repaired (rerolled a little easier) until they pass.
import type { GameSpec, Genre, LevelDef, Placement, Weather } from "../spec/types.ts";
import { assemble, BACKGROUND, type Theme } from "../spec/kit.ts";
import { DEFAULT_GRAVITY } from "../spec/defaults.ts";
import { mulberry } from "../engine/rng.ts";
import type { Streamer } from "../engine/game.ts";
import { stitchLevel, runnerChunk, jumpReach, type Beat, type Physics } from "./platformer.ts";
import { dungeon, arena, flood } from "./topdown.ts";
import { generatePuzzleRoom } from "./puzzle.ts";
import { builderTerrain, solveBuilder } from "./builder.ts";
import { playtest, type PlaytestResult } from "./bot.ts";
import { Paint } from "./paint.ts";
import { defenseLayout } from "./defense.ts";

export type LevelPlan = { name: string; beat: Beat; difficulty: number; story?: string; boss?: boolean };
export type WorldOptions = { base?: GameSpec; levels?: LevelPlan[]; count?: number; seed?: number; difficulty?: number; maxAttempts?: number; skipBot?: boolean; onProgress?: (msg: string) => void };
export type LevelReport = { id: string; attempts: number; passed: boolean; reason: string; reachable: boolean; budget: { cost: number; limit: number }; ms: number; frames: number };

export const BEAT_ORDER: Beat[] = ["intro", "teach", "test", "twist", "finale"];
const BEAT_MUSIC: Record<string, string> = { intro: "music-calm", teach: "music-adventure", test: "music-adventure", twist: "music-tense", finale: "music-boss", endless: "music-adventure" };

// The outline: beats spread across the levels with a rising difficulty curve.
export function outline(count: number, difficulty = 0.5, names?: string[]): LevelPlan[] {
  const n = Math.max(1, Math.min(8, count));
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const beat = n === 1 ? "test" : BEAT_ORDER[Math.min(4, Math.round(t * 4))];
    return { name: names?.[i] ?? `Level ${i + 1}`, beat, difficulty: Math.min(1, Math.max(0, difficulty * 0.6 + t * 0.5 - 0.1)), boss: i === n - 1 && n >= 3 };
  });
}

export function physicsOf(spec: GameSpec, level?: LevelDef): Physics {
  const c = spec.player.behaviors.find((b) => b.type === "platformer-controller")?.params ?? {};
  return {
    speed: Number(c.speed ?? 7),
    jumpHeight: Number(c.jumpHeight ?? 3.4),
    gravity: level?.gravity ?? DEFAULT_GRAVITY[spec.meta.genre],
    doubleJump: !!c.doubleJump,
  };
}

// ---------- reachability ----------

// Side view: a search over standable cells using real jump height, speed and gravity.
export function reachableSide(spec: GameSpec, level: LevelDef): { ok: boolean; missing: string[]; reached: Set<number> } {
  const ph = physicsOf(spec, level);
  const [w, h] = level.size;
  const tile = (x: number, y: number) => (x < 0 || x >= w ? "#" : y < 0 ? "." : y >= h ? "." : level.tiles[y][x]);
  const solid = (x: number, y: number) => "#B".includes(tile(x, y));
  const standable = new Set<number>();
  const key = (x: number, y: number) => y * w + x;
  const floorBelow = (x: number, y: number) => solid(x, y + 1) || tile(x, y + 1) === "=";
  // Platforms and springs from placements count as floors.
  const extraFloor = new Set<number>();
  const springs = new Set<number>();
  for (const p of level.placements) {
    const def = spec.entities.find((e) => e.id === p.def);
    if (!def) continue;
    const mp = def.behaviors.find((b) => b.type === "moving-platform");
    if (def.body?.solid || def.behaviors.some((b) => b.type === "falling-platform")) {
      const dx = Number(mp?.params?.dx ?? 0), dy = Number(mp?.params?.dy ?? 0);
      const x0 = Math.floor(p.x + 0.5 - def.size[0] / 2), x1 = Math.floor(p.x + 0.5 + def.size[0] / 2 + Math.max(0, dx) - 0.01);
      const top = Math.floor(p.y + 1 - def.size[1]);
      for (let x = Math.min(x0, x0 + dx); x <= x1; x++) for (let y = top + Math.min(0, dy); y <= top + Math.max(0, dy); y++) extraFloor.add(key(x, y - 1));
    }
    if (def.behaviors.some((b) => b.type === "bouncy")) springs.add(key(Math.floor(p.x), Math.floor(p.y) - 1));
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (!solid(x, y) && tile(x, y) !== "^" && (floorBelow(x, y) || extraFloor.has(key(x, y)))) standable.add(key(x, y));
  const reached = new Set<number>();
  const sx = Math.floor(level.spawn[0]);
  let sy = Math.floor(level.spawn[1]);
  while (sy < h - 1 && !standable.has(key(sx, sy))) sy++;
  const q: [number, number][] = [[sx, sy]];
  reached.add(key(sx, sy));
  const H = ph.jumpHeight * (ph.doubleJump ? 1.6 : 1);
  const clear = (x0: number, y0: number, x1: number, y1: number, apex: number) => {
    // Sample the arc: up to the apex over the start, across, then down.
    const top = Math.min(y0, y1) - Math.max(0, apex);
    for (let y = y0; y >= Math.ceil(top); y--) if (solid(x0, y)) return false;
    const dir = Math.sign(x1 - x0);
    for (let x = x0; x !== x1 + dir && dir !== 0; x += dir) if (solid(x, Math.ceil(top))) return false;
    for (let y = Math.ceil(top); y <= y1; y++) if (solid(x1, y)) return false;
    return true;
  };
  while (q.length) {
    const [x, y] = q.shift()!;
    const spring = springs.has(key(x, y));
    const jh = spring ? H + 5 : H;
    const reach = Math.ceil(jumpReach({ ...ph, jumpHeight: jh }, 0)) + 1;
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -Math.floor(jh); dy <= h; dy++) {
        const nx = x + dx, ny = y + dy;
        const k = key(nx, ny);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || reached.has(k) || !standable.has(k)) continue;
        const rise = -dy; // positive when landing higher
        if (rise > jh - 0.3) continue;
        const r = jumpReach({ ...ph, jumpHeight: jh }, Math.max(0, rise));
        // Cells are whole tiles: from the far edge of one to the near edge of another is
        // up to one tile shorter than their index difference.
        if (Math.abs(dx) - 1 > (rise >= 0 ? r * 0.9 : r * 0.9 + Math.sqrt(Math.max(0, dy))) + 0.2) continue;
        if (!clear(x, y, nx, ny, Math.min(jh, rise + 1))) continue;
        reached.add(k);
        q.push([nx, ny]);
      }
  }
  const missing: string[] = [];
  const near = (px: number, py: number) => {
    for (const k of reached) {
      const x = k % w, y = Math.floor(k / w);
      if (Math.abs(x - px) <= 2 && py <= y && y - py <= Math.ceil(H)) return true;
    }
    return false;
  };
  for (const p of level.placements) {
    const def = spec.entities.find((e) => e.id === p.def);
    const required = def?.behaviors.some((b) => b.type === "goal" || (b.type === "collectible" && b.params?.required !== false && spec.rules.some((r) => r.type === "win" && r.when === "collect-all")));
    if (required && !near(Math.floor(p.x), Math.floor(p.y))) missing.push(`${p.def} at ${Math.floor(p.x)},${Math.floor(p.y)}`);
  }
  return { ok: missing.length === 0, missing, reached };
}

export function reachableTop(level: LevelDef): { ok: boolean; missing: string[] } {
  const p = Paint.from(level.tiles);
  const seen = flood(p, [Math.floor(level.spawn[0]), Math.floor(level.spawn[1])], (x, y) => "W#~B".includes(p.get(x, y)));
  const missing = level.placements.filter((q) => ["goal", "key"].includes(q.def) && !seen.has(Math.floor(q.y) * p.w + Math.floor(q.x))).map((q) => `${q.def} at ${q.x},${q.y}`);
  return { ok: missing.length === 0, missing };
}

// ---------- difficulty budget ----------

const COST: Record<string, number> = { walker: 2, flyer: 3, turret: 4, boss: 8, spikes: 1, fleer: 0 };
export function difficultyCost(level: LevelDef): number {
  let c = 0;
  for (const p of level.placements) {
    if (p.def === "spawner") c += Number(p.params?.waves ?? 3) * Number(p.params?.perWave ?? 3) * 1.2;
    else c += COST[p.def] ?? 0;
  }
  for (const row of level.tiles) for (const ch of row) if (ch === "^") c += 0.5;
  return Math.round(c * 10) / 10;
}
export function budgetFor(genre: Genre, level: LevelDef, difficulty: number): number {
  const size = genre === "platformer" || genre === "runner" ? level.size[0] / 60 : (level.size[0] * level.size[1]) / 900;
  if (genre === "defense") return 999; // waves are balanced by the bot instead
  const base = genre === "arena" ? 40 : genre === "puzzle" || genre === "builder" ? 0 : 10;
  return Math.round((base + difficulty * 30) * Math.max(0.6, size));
}
function enforceBudget(genre: Genre, level: LevelDef, difficulty: number) {
  const limit = budgetFor(genre, level, difficulty);
  // Remove the costliest non-boss threats until the level fits.
  while (difficultyCost(level) > limit) {
    let worst = -1, wc = 0;
    level.placements.forEach((p, i) => {
      const c = COST[p.def] ?? (p.def === "spawner" ? 5 : 0);
      if (p.def !== "boss" && c > wc) {
        wc = c;
        worst = i;
      }
    });
    if (worst < 0) break;
    level.placements.splice(worst, 1);
  }
  return limit;
}

// ---------- layout by genre ----------

function layout(theme: Theme, spec: GameSpec, plan: LevelPlan, seed: number): Omit<LevelDef, "id" | "name"> {
  const rng = mulberry(seed);
  const g = theme.genre;
  const base = { tileSize: 16, tileset: "tiles", background: BACKGROUND, beat: plan.beat, difficulty: plan.difficulty, seed };
  if (g === "platformer" || g === "runner") {
    const ph = physicsOf(spec);
    const r = stitchLevel(rng, [plan.beat === "finale" ? "twist" : plan.beat, plan.beat === "intro" ? "teach" : "test"], plan.difficulty, ph, {
      runner: g === "runner",
      boss: g === "platformer" && !!plan.boss,
      checkpoint: g === "platformer",
      length: g === "runner" ? Math.round(150 + plan.difficulty * 120) : undefined,
    });
    return { ...base, size: [r.width, r.tiles.length], tiles: r.tiles, spawn: r.spawn, placements: r.placements };
  }
  if (g === "top-down") {
    const r = dungeon(rng, plan.difficulty, { locked: plan.beat !== "intro" });
    if (plan.boss) {
      const goal = r.placements.find((p) => p.def === "goal")!;
      r.placements.push({ def: "boss", x: goal.x - 2, y: goal.y });
    }
    return { ...base, size: [r.tiles[0].length, r.tiles.length], tiles: r.tiles, spawn: r.spawn, placements: r.placements };
  }
  if (g === "arena") {
    const r = arena(rng, plan.difficulty);
    return { ...base, size: [r.tiles[0].length, r.tiles.length], tiles: r.tiles, spawn: r.spawn, placements: r.placements };
  }
  if (g === "defense") {
    const r = defenseLayout(seed, plan.difficulty, { boss: !!plan.boss });
    return { ...base, background: [BACKGROUND[0]], ...r };
  }
  if (g === "puzzle") {
    const r = generatePuzzleRoom(seed, plan.difficulty);
    if (!r) throw new Error("could not build a solvable puzzle room");
    return { ...base, size: [r.tiles[0].length, r.tiles.length], tiles: r.tiles, spawn: r.spawn, placements: r.placements };
  }
  const t = builderTerrain(seed, plan.difficulty);
  return { ...base, size: [t.tiles[0].length, t.tiles.length], tiles: t.tiles, spawn: t.spawn, placements: t.placements, parts: t.parts };
}

function decorate(level: LevelDef, theme: Theme, plan: LevelPlan, index: number, count: number) {
  level.music = BEAT_MUSIC[plan.beat] ?? "music-adventure";
  const weather: Weather = (theme.weather as Weather) || "none";
  if (weather !== "none") {
    level.weather = weather;
    level.weatherAmount = Math.min(1, 0.3 + (index / Math.max(1, count - 1)) * 0.5);
  }
  if (plan.beat === "twist") level.tint = "#2a2f4a";
  if (plan.beat === "finale") level.tint = "#3d1414";
  if (plan.story) level.story = plan.story;
}

// Build and validate every level of a game. Returns the levels plus a report per level.
export function buildWorld(theme: Theme, opts: WorldOptions = {}): { levels: LevelDef[]; reports: LevelReport[] } {
  const seed = opts.seed ?? 1;
  const plans = opts.levels ?? outline(opts.count ?? 3, opts.difficulty ?? 0.5);
  const levels: LevelDef[] = [];
  const reports: LevelReport[] = [];
  // A spec with the kit's entity defs, used for physics, reachability and the bot.
  const probe = opts.base ?? assemble(theme, [placeholderLevel()]);
  plans.forEach((plan, i) => {
    const t0 = performance.now();
    let attempts = 0;
    let passed = false;
    let reason = "";
    let best: LevelDef | null = null;
    let reach = false;
    let bud = { cost: 0, limit: 0 };
    let frames = 0;
    let diff = plan.difficulty;
    const max = opts.maxAttempts ?? 4;
    while (attempts < max && !passed) {
      attempts++;
      const s = (seed * 7919 + i * 104729 + attempts * 15485863) >>> 0;
      let lv: LevelDef;
      try {
        lv = { id: `level-${i + 1}`, name: plan.name, ...layout(theme, probe, { ...plan, difficulty: diff }, s) };
      } catch (e) {
        reason = (e as Error).message;
        diff *= 0.8;
        continue;
      }
      const limit = enforceBudget(theme.genre, lv, diff);
      bud = { cost: difficultyCost(lv), limit };
      decorate(lv, theme, plan, i, plans.length);
      const spec = { ...probe, levels: [lv] };
      const r = theme.genre === "platformer" || theme.genre === "runner" ? reachableSide(spec, lv) : theme.genre === "top-down" ? reachableTop(lv) : { ok: true, missing: [] as string[] };
      reach = r.ok;
      best = lv;
      if (!r.ok) {
        reason = `unreachable: ${r.missing.join(", ")}`;
        diff *= 0.85;
        continue;
      }
      if (opts.skipBot) {
        passed = true;
        reason = "reachable";
        break;
      }
      opts.onProgress?.(`Playtesting ${plan.name} (try ${attempts})`);
      const bot: PlaytestResult = playtest(spec, 0, { streamer: makeStreamer(spec) });
      frames = bot.frames;
      if (bot.passed) {
        passed = true;
        reason = "bot finished";
        if (theme.genre === "builder" && bot.commands) lv.solution = bot.commands.filter((c) => c.kind === "place").map((c) => ({ def: c.def!, x: c.x!, y: c.y!, angle: c.angle ?? 0 }));
      } else {
        reason = `bot: ${bot.reason}`;
        diff *= 0.85;
      }
    }
    levels.push(best!);
    reports.push({ id: best!.id, attempts, passed, reason, reachable: reach, budget: bud, ms: Math.round(performance.now() - t0), frames });
  });
  return { levels, reports };
}

export function placeholderLevel(): LevelDef {
  const p = new Paint(20, 10).ground(0, 19, 8);
  return { id: "probe", name: "Probe", size: [20, 10], tileSize: 16, tileset: "tiles", tiles: p.rows(), spawn: [1, 7], placements: [], background: [] };
}

// Endless runners stream new chunks as the player advances.
export function makeStreamer(spec: GameSpec): Streamer | undefined {
  if (spec.meta.genre !== "runner") return undefined;
  const ph = physicsOf(spec);
  return (_spec, level, chunk, from) => {
    const rng = mulberry(((level.seed ?? 1) * 31 + chunk * 977) >>> 0);
    const h = level.size[1];
    const base = h - 3;
    const r = runnerChunk(rng, chunk, ph, h, base);
    // Come back to the base ground line so chunks always join.
    const p = Paint.from(r.columns);
    let cols = r.columns;
    if (r.ground !== base) {
      const ext = new Paint(p.w + 4, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < p.w; x++) ext.set(x, y, p.get(x, y));
      ext.ground(p.w, p.w + 3, base);
      cols = ext.rows();
    }
    return { columns: cols, placements: r.placements.map((q: Placement) => ({ ...q, x: q.x + from })) };
  };
}

// A whole spec for an endless run: a short start strip, then streamed chunks forever.
export function endlessLevel(seed: number): LevelDef {
  const p = new Paint(30, 12).ground(0, 29, 9);
  return { id: "endless", name: "Endless", size: [30, 12], tileSize: 16, tileset: "tiles", tiles: p.rows(), spawn: [3, 8], placements: [], background: BACKGROUND, endless: true, seed, music: "music-adventure", beat: "endless" };
}

void solveBuilder;
