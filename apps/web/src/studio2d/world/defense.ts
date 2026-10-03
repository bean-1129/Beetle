// Lane defense: the lawn layout, waves per lane, and a playtest bot that plays it the way a
// person does (producers early, a shooter wherever enemies are coming, a blocker when one
// gets close).
import type { GameSpec, LevelDef, Placement } from "../spec/types.ts";
import { Game } from "../engine/game.ts";
import { mulberry } from "../engine/rng.ts";
import { Paint } from "./paint.ts";

export const LANE_CELL = 3;

export type DefenseCommand = { tick: number; def: string; col: number; row: number };

export function defenseLayout(seed: number, difficulty: number, opts: { boss?: boolean } = {}): Pick<LevelDef, "size" | "tiles" | "spawn" | "placements" | "lanes" | "shop" | "economy"> {
  const rng = mulberry(seed);
  const rows = difficulty < 0.2 ? 3 : 5;
  const cols = 9;
  const W = 30, H = 17;
  const y0 = rows === 3 ? 2 + LANE_CELL : 2;
  const lanes = { x0: 1, y0, cell: LANE_CELL, cols, rows };
  const p = new Paint(W, H);
  const placements: Placement[] = [];
  const waves = 2 + Math.round(difficulty * 3);
  for (let r = 0; r < rows; r++) {
    const kind = difficulty > 0.6 && rng.chance(0.35) ? "brute" : difficulty > 0.35 && rng.chance(0.4) ? "runner" : "walker";
    placements.push({
      def: "spawner",
      x: 28,
      y: y0 + r * LANE_CELL + LANE_CELL - 1,
      params: {
        spawn: kind,
        waves,
        perWave: 1 + (difficulty > 0.5 && rng.chance(0.5) ? 1 : 0),
        every: 8 + rng.int(0, 5),
        delay: 14 + r * 3 + rng.int(0, 6),
        spacing: 5,
      },
    });
  }
  if (opts.boss) {
    const r = Math.floor(rows / 2);
    placements.push({ def: "spawner", x: 28, y: y0 + r * LANE_CELL + LANE_CELL - 1, params: { spawn: "boss", waves: 1, perWave: 1, every: 1, delay: 70 + rng.int(0, 10) } });
  }
  return {
    size: [W, H],
    tiles: p.rows(),
    spawn: [0, 0],
    placements,
    lanes,
    shop: [
      { def: "producer", cost: 50, cooldown: 6 },
      { def: "shooter", cost: 100, cooldown: 6 },
      { def: "blocker", cost: 50, cooldown: 20 },
    ],
    economy: { start: 150, perSecond: 1.5 },
  };
}

// One decision of the bot: what to place next, if anything.
export function defenseMove(g: Game): { def: string; col: number; row: number } | null {
  const lanes = g.level.lanes;
  if (!lanes || !g.level.shop) return null;
  const has = (def: string) => g.level.shop!.some((s) => s.def === def);
  const count = (def: string, row?: number) => g.s.ents.filter((e) => e.alive && e.def === def && e.cell && (row === undefined || e.cell[1] === row)).length;
  const firstFree = (row: number, from = 0) => {
    for (let c = from; c < lanes.cols; c++) if (!g.unitAt(c, row)) return c;
    return -1;
  };
  const threat = Array.from({ length: lanes.rows }, () => ({ hp: 0, nearest: Infinity }));
  for (const e of g.s.ents) {
    if (!e.alive || e.kind !== "enemy") continue;
    const r = g.laneOf(e.y + e.h / 2);
    if (r < 0) continue;
    threat[r].hp += Math.max(1, e.hp);
    threat[r].nearest = Math.min(threat[r].nearest, e.x);
  }
  // Never place a unit where an invader already stands (or is about to).
  const safe = (col: number, row: number) => lanes.x0 + (col + 1) * lanes.cell + 1 < threat[row].nearest;
  const try_ = (def: string, col: number, row: number) => (col >= 0 && has(def) && safe(col, row) && !g.canPlace(def, col, row) ? { def, col, row } : null);
  // 1. Defend lanes under attack.
  const order = threat.map((t, r) => ({ r, ...t })).filter((t) => t.hp > 0).sort((a, b) => a.nearest - b.nearest);
  // Every threatened lane gets its first shooter before any lane gets a second.
  for (const t of order)
    if (count("shooter", t.r) === 0) {
      const m = try_("shooter", firstFree(t.r, 1), t.r) ?? try_("shooter", firstFree(t.r, 0), t.r);
      if (m) return m;
      if (g.s.currency < 100) return null; // save up for it
    }
  for (const t of order) {
    const need = Math.ceil(t.hp / 8) + 1;
    if (count("shooter", t.r) < need) {
      const m = try_("shooter", firstFree(t.r, 1), t.r);
      if (m) return m;
    }
    // A blocker in front of the defenders when an enemy gets close.
    const front = Math.max(-1, ...g.s.ents.filter((e) => e.alive && e.cell && e.cell[1] === t.r).map((e) => e.cell![0]));
    const frontX = lanes.x0 + (front + 1) * lanes.cell;
    if (t.nearest - frontX < 7 && count("blocker", t.r) === 0 && front + 1 < lanes.cols) {
      const m = try_("blocker", front + 1, t.r);
      if (m) return m;
    }
  }
  // 2. Build the economy early.
  const producers = count("producer");
  if (producers < Math.min(lanes.rows + 1, 2 + Math.floor(g.s.time / 12))) {
    for (let r = 0; r < lanes.rows; r++) {
      const m = try_("producer", g.unitAt(0, r) ? firstFree(r, 0) : 0, r);
      if (m && (m.col === 0 || producers >= lanes.rows)) return m;
    }
  }
  // 3. Prepare: one shooter per lane, then more where the waves are heavier.
  const ranked = Array.from({ length: lanes.rows }, (_, r) => r).sort((a, b) => count("shooter", a) - count("shooter", b));
  for (const r of ranked) {
    if (g.s.currency < 150 && count("shooter", r) > 0) continue;
    const m = try_("shooter", firstFree(r, 1), r);
    if (m) return m;
  }
  return null;
}

// Play a defense level to the end. Returns the commands, so the run can be replayed.
export function playDefense(spec: GameSpec, levelIndex = 0, maxSeconds = 360): { won: boolean; frames: number; commands: DefenseCommand[]; reason: string } {
  const g = new Game(spec, { level: levelIndex });
  const commands: DefenseCommand[] = [];
  let f = 0;
  for (; f < maxSeconds * 60 && g.s.status === "playing"; f++) {
    if (f % 10 === 0) {
      const m = defenseMove(g);
      if (m && g.placeUnit(m.def, m.col, m.row)) commands.push({ tick: g.s.tick, ...m });
    }
    g.step(0);
  }
  const won = g.s.status === "won";
  return { won, frames: f, commands, reason: won ? "won" : g.s.status === "lost" ? "an enemy reached the base" : "ran out of time" };
}

export function replayDefense(spec: GameSpec, levelIndex: number, commands: DefenseCommand[], maxFrames = 60 * 400) {
  const g = new Game(spec, { level: levelIndex });
  let i = 0;
  for (let f = 0; f < maxFrames && g.s.status === "playing"; f++) {
    while (i < commands.length && commands[i].tick === g.s.tick) {
      g.placeUnit(commands[i].def, commands[i].col, commands[i].row);
      i++;
    }
    g.step(0);
  }
  return g;
}
