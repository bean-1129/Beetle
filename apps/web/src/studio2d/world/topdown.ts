// Top-down layouts: rooms and corridors by binary space partitioning, then wave function
// collapse for room interiors (water pools and pillars that never block the way through).
// Also the arena layout for the shooter genre.
import type { Placement } from "../spec/types.ts";
import { Paint } from "./paint.ts";
import type { Rng } from "../engine/rng.ts";

type Room = { x: number; y: number; w: number; h: number };

function split(rng: Rng, r: Room, depth: number, out: Room[]) {
  const canH = r.w >= 16, canV = r.h >= 14;
  if (depth <= 0 || (!canH && !canV)) {
    // Room inside the leaf, with a margin for walls.
    const w = rng.int(Math.max(5, Math.floor(r.w * 0.55)), r.w - 2);
    const h = rng.int(Math.max(4, Math.floor(r.h * 0.55)), r.h - 2);
    out.push({ x: r.x + rng.int(1, r.w - w - 1), y: r.y + rng.int(1, r.h - h - 1), w, h });
    return;
  }
  const horiz = canH && (!canV || r.w >= r.h ? true : rng.chance(0.3));
  if (horiz) {
    const cut = rng.int(Math.floor(r.w * 0.4), Math.floor(r.w * 0.6));
    split(rng, { x: r.x, y: r.y, w: cut, h: r.h }, depth - 1, out);
    split(rng, { x: r.x + cut, y: r.y, w: r.w - cut, h: r.h }, depth - 1, out);
  } else {
    const cut = rng.int(Math.floor(r.h * 0.4), Math.floor(r.h * 0.6));
    split(rng, { x: r.x, y: r.y, w: r.w, h: cut }, depth - 1, out);
    split(rng, { x: r.x, y: r.y + cut, w: r.w, h: r.h - cut }, depth - 1, out);
  }
}

const center = (r: Room): [number, number] => [Math.floor(r.x + r.w / 2), Math.floor(r.y + r.h / 2)];

function carveCorridor(p: Paint, a: [number, number], b: [number, number], rng: Rng) {
  const [x0, y0] = a, [x1, y1] = b;
  const hFirst = rng.chance(0.5);
  const hx = (y: number, xa: number, xb: number) => { for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) p.set(x, y, "."); };
  const vy = (x: number, ya: number, yb: number) => { for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) p.set(x, y, "."); };
  if (hFirst) {
    hx(y0, x0, x1);
    vy(x1, y0, y1);
  } else {
    vy(x0, y0, y1);
    hx(y1, x0, x1);
  }
}

export function flood(p: Paint, from: [number, number], blocked: (x: number, y: number) => boolean) {
  const seen = new Set<number>();
  const q = [from];
  seen.add(from[1] * p.w + from[0]);
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const k = ny * p.w + nx;
      if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h || seen.has(k) || blocked(nx, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return seen;
}
const walkable = (p: Paint) => (x: number, y: number) => "W#~B".includes(p.get(x, y));

// Wave function collapse over three interior tiles with adjacency rules:
// floor touches anything; water touches water or floor; pillars touch only floor.
const WFC_TILES = [".", "~", "W"] as const;
const ALLOWED: Record<string, string[]> = { ".": [".", "~", "W"], "~": [".", "~"], W: ["."] };
export function wfcInterior(rng: Rng, w: number, h: number, weights: [number, number, number]): string[][] {
  const cells: Set<string>[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => new Set(WFC_TILES)));
  // Keep a ring of floor so doors and corridors stay open.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) cells[y][x] = new Set(["."]);
  const propagate = (sx: number, sy: number) => {
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ok = new Set<string>();
        for (const t of cells[y][x]) for (const a of ALLOWED[t]) ok.add(a);
        const before = cells[ny][nx].size;
        cells[ny][nx] = new Set([...cells[ny][nx]].filter((t) => ok.has(t)));
        if (!cells[ny][nx].size) cells[ny][nx] = new Set(["."]);
        if (cells[ny][nx].size !== before) stack.push([nx, ny]);
      }
    }
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) propagate(x, y);
  for (;;) {
    // Lowest entropy cell first.
    let best: [number, number] | null = null, bs = 99;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = cells[y][x].size;
      if (n > 1 && n + rng.next() * 0.1 < bs) {
        bs = n + rng.next() * 0.1;
        best = [x, y];
      }
    }
    if (!best) break;
    const [x, y] = best;
    const opts = [...cells[y][x]];
    const ws = opts.map((t) => weights[WFC_TILES.indexOf(t as any)]);
    // Water likes water: raise its weight next to existing water, for pools not puddles.
    opts.forEach((t, i) => {
      if (t === "~" && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cells[y + dy]?.[x + dx]?.size === 1 && cells[y + dy][x + dx].has("~"))) ws[i] *= 6;
    });
    let r = rng.next() * ws.reduce((s, v) => s + v, 0);
    let pick = opts[0];
    for (let i = 0; i < opts.length; i++) {
      r -= ws[i];
      if (r <= 0) {
        pick = opts[i];
        break;
      }
    }
    cells[y][x] = new Set([pick]);
    propagate(x, y);
  }
  return cells.map((row) => row.map((s) => [...s][0]));
}

export type TopDownLayout = { tiles: string[]; spawn: [number, number]; placements: Placement[] };

export function dungeon(rng: Rng, diff: number, opts: { w?: number; h?: number; locked?: boolean } = {}): TopDownLayout {
  const W = opts.w ?? 40 + Math.round(diff * 12), H = opts.h ?? 26 + Math.round(diff * 6);
  const p = new Paint(W, H, "W");
  const rooms: Room[] = [];
  split(rng, { x: 0, y: 0, w: W, h: H }, 2 + (diff > 0.5 ? 1 : 0), rooms);
  for (const r of rooms) p.rect(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1, ".");
  // Connect rooms in a chain (each to the nearest unconnected one) so all are reachable.
  const order = [0];
  const left = new Set(rooms.map((_, i) => i).slice(1));
  while (left.size) {
    const last = rooms[order[order.length - 1]];
    let best = -1, bd = Infinity;
    for (const i of left) {
      const [ax, ay] = center(last), [bx, by] = center(rooms[i]);
      const d = Math.abs(ax - bx) + Math.abs(ay - by);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    carveCorridor(p, center(last), center(rooms[best]), rng);
    order.push(best);
    left.delete(best);
  }
  // Interiors by wave function collapse, kept only if the room stays connected.
  for (const r of rooms) {
    if (r.w < 6 || r.h < 5) continue;
    const inner = wfcInterior(rng, r.w, r.h, [8, 1.2 + diff, 0.6]);
    const backup = p.rows();
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (inner[y][x] !== ".") p.set(r.x + x, r.y + y, inner[y][x]);
    const all = flood(p, center(rooms[0]), walkable(p));
    const open = p.cells.flat().filter((c) => c === ".").length;
    if (all.size < open || "W~".includes(p.get(...center(r)))) {
      const b = Paint.from(backup);
      p.cells = b.cells;
    }
  }
  const spawnRoom = rooms[order[0]], goalRoom = rooms[order[order.length - 1]];
  const spawn = center(spawnRoom);
  p.set(spawn[0], spawn[1], ".");
  const placements: Placement[] = [];
  const goal = center(goalRoom);
  p.set(goal[0], goal[1], ".");
  placements.push({ def: "goal", x: goal[0], y: goal[1] });
  // Lock the goal room: find its entrances; if a single one remains after walling the
  // rest (without cutting off any other room), put a locked door there and a key elsewhere.
  if (opts.locked !== false && rooms.length >= 3) {
    const inRoom = (x: number, y: number) => x >= goalRoom.x && y >= goalRoom.y && x < goalRoom.x + goalRoom.w && y < goalRoom.y + goalRoom.h;
    const entrances: [number, number][] = [];
    for (let y = goalRoom.y - 1; y <= goalRoom.y + goalRoom.h; y++)
      for (let x = goalRoom.x - 1; x <= goalRoom.x + goalRoom.w; x++) {
        if (inRoom(x, y) || p.get(x, y) !== ".") continue;
        const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inRoom(x + dx, y + dy));
        if (touches) entrances.push([x, y]);
      }
    if (entrances.length) {
      const backup = p.rows();
      const [dx, dy] = entrances[0];
      for (const e of entrances.slice(1)) p.set(e[0], e[1], "W");
      const blocked = (x: number, y: number) => walkable(p)(x, y) || (x === dx && y === dy);
      const reach = flood(p, spawn, blocked);
      const others = rooms.filter((r) => r !== goalRoom).every((r) => reach.has(center(r)[1] * p.w + center(r)[0]));
      const goalOk = flood(p, spawn, walkable(p)).has(goal[1] * p.w + goal[0]);
      if (others && goalOk && !reach.has(goal[1] * p.w + goal[0])) {
        placements.push({ def: "door", x: dx, y: dy });
        const keyRoom = rooms[order[Math.max(1, Math.floor(order.length / 2))]] ?? spawnRoom;
        const k = center(keyRoom);
        p.set(k[0], k[1], ".");
        placements.push({ def: "key", x: k[0] === spawn[0] && k[1] === spawn[1] ? k[0] + 1 : k[0], y: k[1] });
      } else p.cells = Paint.from(backup).cells;
    }
  }
  // Pickups, hearts and enemies by room.
  const taken = new Set(placements.map((q) => `${q.x},${q.y}`).concat([`${spawn[0]},${spawn[1]}`]));
  const freeIn = (r: Room) => {
    for (let t = 0; t < 30; t++) {
      const x = rng.int(r.x + 1, r.x + r.w - 2), y = rng.int(r.y + 1, r.y + r.h - 2);
      if (p.get(x, y) === "." && !taken.has(`${x},${y}`)) {
        taken.add(`${x},${y}`);
        return [x, y] as [number, number];
      }
    }
    return null;
  };
  order.forEach((ri, i) => {
    const r = rooms[ri];
    const coins = rng.int(1, 3);
    for (let k = 0; k < coins; k++) {
      const c = freeIn(r);
      if (c) placements.push({ def: "pickup", x: c[0], y: c[1] });
    }
    if (i === 0) {
      const n = freeIn(r);
      if (n) placements.push({ def: "npc", x: n[0], y: n[1] });
      return;
    }
    const enemies = Math.round(rng.next() * (1 + diff * 2.5));
    for (let k = 0; k < enemies; k++) {
      const c = freeIn(r);
      if (c) placements.push({ def: diff > 0.4 && rng.chance(0.35) ? "flyer" : "walker", x: c[0], y: c[1] });
    }
    if (rng.chance(0.35)) {
      const c = freeIn(r);
      if (c) placements.push({ def: "heart", x: c[0], y: c[1] });
    }
  });
  return { tiles: p.rows(), spawn, placements };
}

export function arena(rng: Rng, diff: number): TopDownLayout {
  const W = 30, H = 18;
  const p = new Paint(W, H).border("W");
  // Mirrored pillars give cover and read as designed.
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const x = rng.int(4, W / 2 - 4), y = rng.int(3, H / 2 - 3), w = rng.int(1, 2), h = rng.int(1, 2);
    for (const [mx, my] of [[x, y], [W - 1 - x - (w - 1), y], [x, H - 1 - y - (h - 1)], [W - 1 - x - (w - 1), H - 1 - y - (h - 1)]]) p.rect(mx, my, mx + w - 1, my + h - 1, "W");
  }
  const spawn: [number, number] = [Math.floor(W / 2), Math.floor(H / 2)];
  p.rect(spawn[0] - 2, spawn[1] - 2, spawn[0] + 2, spawn[1] + 2, ".");
  const waves = 2 + Math.round(diff * 3);
  const per = 2 + Math.round(diff * 3);
  const placements: Placement[] = [
    { def: "spawner", x: 2, y: 2, params: { waves, perWave: per, every: 2.2 - diff } },
    { def: "spawner", x: W - 3, y: H - 3, params: { waves: Math.max(1, waves - 1), perWave: Math.max(2, per - 1), every: 2.6 - diff, spawn: diff > 0.3 ? "flyer" : "walker" } },
    { def: "heart", x: spawn[0], y: 2 },
    { def: "heart", x: spawn[0], y: H - 3 },
  ];
  if (diff > 0.7) placements.push({ def: "spawner", x: W - 3, y: 2, params: { waves: 1, perWave: 1, every: 12, spawn: "boss" } });
  return { tiles: p.rows(), spawn, placements };
}
