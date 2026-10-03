// Puzzle rooms on a grid: an exact solver (breadth-first over player and crate positions) and
// a generator that builds rooms backwards from their solution, so every room is solvable.
import type { GameSpec, LevelDef, Placement } from "../spec/types.ts";
import { Paint } from "./paint.ts";
import { mulberry, type Rng } from "../engine/rng.ts";

export type Dir = "up" | "down" | "left" | "right";
const DIRS: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

type Model = {
  w: number;
  h: number;
  wall: Uint8Array;
  switches: { x: number; y: number; link: string }[];
  doors: { x: number; y: number; link: string; key: boolean }[];
  keys: { x: number; y: number }[];
  goal: { x: number; y: number } | null;
  start: { x: number; y: number };
  crates: { x: number; y: number }[];
};

function behaviorParams(spec: GameSpec, defId: string, type: string, over?: Record<string, any>) {
  const def = spec.entities.find((e) => e.id === defId);
  const b = def?.behaviors.find((x) => x.type === type);
  return b ? { ...(b.params || {}), ...(over || {}) } : null;
}

export function puzzleModel(spec: GameSpec, level: LevelDef): Model {
  const [w, h] = level.size;
  const wall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) wall[y * w + x] = "#WB~".includes(level.tiles[y][x]) ? 1 : 0;
  const m: Model = { w, h, wall, switches: [], doors: [], keys: [], goal: null, start: { x: Math.floor(level.spawn[0]), y: Math.floor(level.spawn[1]) }, crates: [] };
  for (const p of level.placements) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (behaviorParams(spec, p.def, "pushable")) m.crates.push({ x, y });
    const sw = behaviorParams(spec, p.def, "switch", p.params);
    if (sw) m.switches.push({ x, y, link: String(sw.link ?? "") });
    const d = behaviorParams(spec, p.def, "door", p.params);
    if (d) m.doors.push({ x, y, link: String(d.link ?? ""), key: !!d.needsKey });
    const c = behaviorParams(spec, p.def, "collectible", p.params);
    if (c && c.effect === "key") m.keys.push({ x, y });
    if (behaviorParams(spec, p.def, "goal")) m.goal = { x, y };
  }
  return m;
}

// Breadth-first search. Returns the move list or null when unsolvable within the budget.
export function solvePuzzle(m: Model, maxStates = 250000): Dir[] | null {
  if (!m.goal) return null;
  const cell = (x: number, y: number) => y * m.w + x;
  const crateKey = (cs: number[]) => cs.slice().sort((a, b) => a - b).join(",");
  type Node = { p: number; crates: number[]; keys: number; used: number; got: number; prev: Node | null; dir: Dir | null };
  const start: Node = { p: cell(m.start.x, m.start.y), crates: m.crates.map((c) => cell(c.x, c.y)), keys: 0, used: 0, got: 0, prev: null, dir: null };
  const doorOpen = (n: Node, i: number, playerAt = n.p) => {
    const d = m.doors[i];
    if (d.key) return (n.used & (1 << i)) !== 0;
    const sws = m.switches.filter((s) => s.link === d.link);
    if (!sws.length) return false;
    return sws.every((s) => {
      const c = cell(s.x, s.y);
      return c === playerAt || n.crates.includes(c);
    });
  };
  const blocked = (n: Node, c: number, ignoreCrate = -1) => {
    if (m.wall[c]) return true;
    for (let i = 0; i < m.doors.length; i++) if (cell(m.doors[i].x, m.doors[i].y) === c && !doorOpen(n, i)) return true;
    return n.crates.some((x) => x === c && x !== ignoreCrate);
  };
  const seen = new Set<string>();
  const key = (n: Node) => `${n.p}|${crateKey(n.crates)}|${n.keys}|${n.used}|${n.got}`;
  seen.add(key(start));
  let frontier = [start];
  const goal = cell(m.goal.x, m.goal.y);
  while (frontier.length && seen.size < maxStates) {
    const next: Node[] = [];
    for (const n of frontier) {
      for (const [dir, dx, dy] of DIRS) {
        const px = n.p % m.w, py = Math.floor(n.p / m.w);
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const c = cell(nx, ny);
        let crates = n.crates;
        if (n.crates.includes(c)) {
          const bx = nx + dx, by = ny + dy;
          if (bx < 0 || by < 0 || bx >= m.w || by >= m.h) continue;
          const bc = cell(bx, by);
          if (blocked(n, bc) || m.keys.some((k) => cell(k.x, k.y) === bc && !(n.got & (1 << m.keys.indexOf(k))))) continue;
          if (m.goal && bc === goal) continue;
          crates = n.crates.map((x) => (x === c ? bc : x));
        } else if (blocked(n, c)) continue;
        const child: Node = { p: c, crates, keys: n.keys, used: n.used, got: n.got, prev: n, dir };
        // Keys are picked up by walking over them.
        m.keys.forEach((k, i) => {
          if (cell(k.x, k.y) === c && !(child.got & (1 << i))) {
            child.got |= 1 << i;
            child.keys++;
          }
        });
        // Key doors open when the player stands next to them holding a key.
        m.doors.forEach((d, i) => {
          if (!d.key || child.used & (1 << i) || child.keys <= 0) return;
          if (Math.abs(d.x - nx) + Math.abs(d.y - ny) === 1) {
            child.used |= 1 << i;
            child.keys--;
          }
        });
        if (c === goal) {
          const out: Dir[] = [];
          for (let q: Node | null = child; q && q.dir; q = q.prev) out.push(q.dir);
          return out.reverse();
        }
        const k = key(child);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(child);
      }
    }
    frontier = next;
  }
  return null;
}

// Generate a room backwards: carve a room, place the goal behind a gated wall, then pull
// crates away from their plates. Every pull is a legal push in reverse, so the room is
// solvable by construction; the forward solver confirms it and measures its length.
export function generatePuzzleRoom(seed: number, difficulty: number): { tiles: string[]; spawn: [number, number]; placements: Placement[]; solution: Dir[] } | null {
  const rng = mulberry(seed);
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = tryRoom(rng, difficulty);
    if (r) return r;
  }
  return null;
}

function tryRoom(rng: Rng, difficulty: number) {
  const w = rng.int(10, 13), h = rng.int(8, 10);
  const p = new Paint(w, h).border("W");
  // Split: the gate wall runs across near the bottom; the goal area lies beyond it.
  const gateRow = h - 3;
  p.rect(1, gateRow, w - 2, gateRow, "W");
  const gateX = rng.int(2, w - 3);
  // Interior pillars.
  const pillars = rng.int(0, 1 + Math.round(difficulty * 3));
  for (let i = 0; i < pillars; i++) p.set(rng.int(2, w - 3), rng.int(2, gateRow - 2), "W");
  const plates = 1 + (difficulty > 0.55 ? 1 : 0);
  const free = (x: number, y: number) => p.get(x, y) === ".";
  const crates: { x: number; y: number }[] = [];
  const platesAt: { x: number; y: number }[] = [];
  const used = new Set<string>();
  const k = (x: number, y: number) => `${x},${y}`;
  for (let i = 0; i < plates; i++) {
    let sx = 0, sy = 0, ok = false;
    for (let t = 0; t < 30 && !ok; t++) {
      sx = rng.int(2, w - 3);
      sy = rng.int(2, gateRow - 2);
      ok = free(sx, sy) && !used.has(k(sx, sy)) && !(sx === gateX && sy === gateRow - 1);
    }
    if (!ok) return null;
    used.add(k(sx, sy));
    platesAt.push({ x: sx, y: sy });
    // Pull the crate away from the plate a few steps.
    let cx = sx, cy = sy;
    const pulls = 2 + Math.round(difficulty * 4) + rng.int(0, 2);
    for (let j = 0; j < pulls; j++) {
      const [, dx, dy] = rng.pick(DIRS);
      // Reverse push: the player stands at crate+d, then walks to crate+2d, pulling the crate to crate+d.
      const nx = cx + dx, ny = cy + dy, px = cx + 2 * dx, py = cy + 2 * dy;
      if (!free(nx, ny) || !free(px, py) || ny >= gateRow || py >= gateRow || used.has(k(nx, ny))) continue;
      cx = nx;
      cy = ny;
    }
    if (cx === sx && cy === sy) return null;
    // Crates on the border walls' neighbours can get stuck; the solver weeds those out.
    used.add(k(cx, cy));
    crates.push({ x: cx, y: cy });
  }
  const goal = { x: rng.int(1, w - 2), y: gateRow + 1 };
  let spawn: [number, number] = [1, 1];
  for (let t = 0; t < 40; t++) {
    const s: [number, number] = [rng.int(1, w - 2), rng.int(1, gateRow - 1)];
    if (free(s[0], s[1]) && !used.has(k(s[0], s[1]))) {
      spawn = s;
      break;
    }
  }
  const placements: Placement[] = [
    ...crates.map((c) => ({ def: "crate", x: c.x, y: c.y })),
    ...platesAt.map((s) => ({ def: "switch", x: s.x, y: s.y, params: { link: "a" } })),
    { def: "door", x: gateX, y: gateRow, params: { link: "a" } },
    { def: "goal", x: goal.x, y: goal.y },
  ];
  p.set(gateX, gateRow, ".");
  const tiles = p.rows();
  const model: Model = {
    w, h,
    wall: new Uint8Array(tiles.join("").split("").map((c) => ("W#".includes(c) ? 1 : 0))),
    switches: platesAt.map((s) => ({ ...s, link: "a" })),
    doors: [{ x: gateX, y: gateRow, link: "a", key: false }],
    keys: [],
    goal,
    start: { x: spawn[0], y: spawn[1] },
    crates,
  };
  const solution = solvePuzzle(model, 120000);
  if (!solution) return null;
  // Too-easy rooms (solved in a handful of moves) are rerolled for higher difficulties.
  if (solution.length < 6 + difficulty * 10) return null;
  return { tiles, spawn, placements, solution };
}
