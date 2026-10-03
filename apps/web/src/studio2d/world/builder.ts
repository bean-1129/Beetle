// Physics-builder levels: a fixed goal and terrain, a parts budget, and a physics check that
// at least one solution exists. The solver simulates the real engine for every candidate.
import type { GameSpec, LevelDef, Placement } from "../spec/types.ts";
import { Game } from "../engine/game.ts";
import { mulberry } from "../engine/rng.ts";
import { Paint } from "./paint.ts";

export type PartPlacement = { def: string; x: number; y: number; angle: number };

export function simulateBuilder(spec: GameSpec, levelIndex: number, parts: PartPlacement[], maxFrames = 900) {
  const g = new Game(spec, { level: levelIndex });
  for (const p of parts) if (!g.placePart(p.def, p.x, p.y, p.angle)) return { won: false, frames: 0, dist: Infinity, placed: false };
  g.go();
  const goal = g.s.ents.find((e) => g.bh(e, "goal"));
  let best = Infinity;
  let frames = 0;
  for (; frames < maxFrames; frames++) {
    g.step(0);
    const b = g.player;
    if (goal) best = Math.min(best, Math.hypot(b.x + b.w / 2 - (goal.x + goal.w / 2), b.y + b.h / 2 - (goal.y + goal.h / 2)));
    if (g.s.status !== "playing") break;
  }
  return { won: g.s.status === "won", frames, dist: best, placed: true };
}

// Random search, then local refinement of the best candidate. Deterministic for a seed.
export function solveBuilder(spec: GameSpec, levelIndex: number, seed = 1, tries = 600): PartPlacement[] | null {
  const level = spec.levels[levelIndex];
  const rng = mulberry(seed);
  const budget = level.parts || [];
  const [w, h] = level.size;
  const goalP = level.placements.find((p) => p.def === "goal");
  const sx = level.spawn[0];
  const gx = goalP ? goalP.x : w / 2;
  const lo = Math.max(0, Math.min(sx, gx) - 4), hi = Math.min(w - 2, Math.max(sx, gx) + 4);
  const freeAt = (x: number, y: number) => level.tiles[y]?.[x] === ".";
  const candidate = (def: string): PartPlacement | null => {
    for (let t = 0; t < 20; t++) {
      const x = rng.int(lo, hi), y = rng.int(2, h - 3);
      if (!freeAt(x, y)) continue;
      const angle = def === "plank" ? rng.pick([-40, -30, -20, -12, 0, 12, 20, 30, 40]) : 0;
      return { def, x, y, angle };
    }
    return null;
  };
  // Plain drop first: some levels need no parts at all.
  let best: { parts: PartPlacement[]; dist: number } = { parts: [], dist: simulateBuilder(spec, levelIndex, []).dist };
  const dir = Math.sign(gx - sx) || 1;
  // The marble drops straight down from its spawn, so the first part must catch it there.
  const catcher = (): PartPlacement | null => {
    const planks = budget.find((b) => b.def === "plank");
    if (!planks) return null;
    for (let t = 0; t < 20; t++) {
      const x = Math.floor(sx) + rng.int(-1, 1) + dir, y = rng.int(3, h - 5);
      if (freeAt(x, y)) return { def: "plank", x, y, angle: dir * rng.pick([10, 15, 20, 25, 30, 35]) };
    }
    return null;
  };
  for (let i = 0; i < tries; i++) {
    const parts: PartPlacement[] = [];
    const first = catcher();
    if (first) parts.push(first);
    for (const b of budget) {
      const have = parts.filter((p) => p.def === b.def).length;
      const n = rng.int(0, b.count - have);
      for (let k = 0; k < n; k++) {
        const c = candidate(b.def);
        if (c) parts.push(c);
      }
    }
    if (!parts.length) continue;
    const r = simulateBuilder(spec, levelIndex, parts);
    if (r.won) return parts;
    if (r.placed && r.dist < best.dist) best = { parts, dist: r.dist };
  }
  // Nudge the closest attempt.
  for (let i = 0; i < 240 && best.parts.length; i++) {
    const parts = best.parts.map((p) => ({ ...p }));
    const j = rng.int(0, parts.length - 1);
    parts[j].x += rng.int(-1, 1);
    parts[j].y += rng.int(-1, 1);
    if (parts[j].def === "plank") parts[j].angle = Math.max(-45, Math.min(45, parts[j].angle + rng.pick([-10, -5, 0, 5, 10])));
    if (!freeAt(parts[j].x, parts[j].y)) continue;
    const r = simulateBuilder(spec, levelIndex, parts);
    if (r.won) return parts;
    if (r.placed && r.dist < best.dist) best = { parts, dist: r.dist };
  }
  return null;
}

// Terrain for a builder level: spikes below, a pedestal with the goal, the marble's drop
// point, and optional obstacles. The caller checks solvability with solveBuilder.
export function builderTerrain(seed: number, difficulty: number, w = 30, h = 17): { tiles: string[]; spawn: [number, number]; placements: Placement[]; parts: { def: string; count: number }[] } {
  const rng = mulberry(seed);
  const p = new Paint(w, h);
  p.rect(0, h - 1, w - 1, h - 1, "#").rect(0, h - 2, w - 1, h - 2, "^");
  const sx = rng.int(2, 8);
  const pedW = rng.int(4, 6);
  const gx0 = rng.int(Math.min(w - pedW - 2, sx + 6 + Math.round(difficulty * 6)), w - pedW - 2);
  const top = rng.int(Math.max(7, h - 7 - Math.round(difficulty * 3)), h - 4);
  p.ground(gx0, gx0 + pedW - 1, top);
  // A low wall on the far side of the pedestal catches fast marbles.
  p.rect(gx0 + pedW - 1, top - 1, gx0 + pedW - 1, top - 1, "#");
  if (difficulty > 0.5) {
    const ox = rng.int(sx + 2, gx0 - 2);
    p.rect(ox, rng.int(5, top - 2), ox, h - 3, "#");
  }
  const goalX = gx0 + Math.floor((pedW - 1) / 2);
  return {
    tiles: p.rows(),
    spawn: [sx, 1],
    placements: [{ def: "goal", x: goalX, y: top - 1 }],
    parts: [{ def: "plank", count: 2 + (difficulty > 0.6 ? 1 : 0) }, { def: "spring", count: 1 }],
  };
}

export function builderLevel(base: Omit<LevelDef, "tiles" | "spawn" | "placements" | "size">, seed: number, difficulty: number): LevelDef {
  const t = builderTerrain(seed, difficulty);
  return { ...base, size: [t.tiles[0].length, t.tiles.length], tiles: t.tiles, spawn: t.spawn, placements: t.placements, parts: t.parts, seed };
}
