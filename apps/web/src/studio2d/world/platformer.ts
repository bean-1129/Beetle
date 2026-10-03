// Platformer and runner layouts by chunk stitching: hand-designed chunk templates (gaps,
// stairs, floating and moving platforms, hazards) chosen by the level outline and joined
// so the ground line always stays within the player's jump.
import type { Placement } from "../spec/types.ts";
import { Paint } from "./paint.ts";
import type { Rng } from "../engine/rng.ts";

export type Physics = { speed: number; jumpHeight: number; gravity: number; doubleJump: boolean };
export type Beat = "intro" | "teach" | "test" | "twist" | "finale" | "endless";

// How far the player can jump horizontally when landing dy tiles higher (dy may be negative).
export function jumpReach(ph: Physics, dy: number): number {
  const v0 = Math.sqrt(2 * ph.gravity * ph.jumpHeight);
  const disc = v0 * v0 - 2 * ph.gravity * dy;
  if (disc < 0) return 0;
  const t = (v0 + Math.sqrt(disc)) / ph.gravity;
  return ph.speed * t;
}
export function limits(ph: Physics) {
  const extra = ph.doubleJump ? 1.6 : 1;
  return {
    gap: Math.max(1, Math.min(6, Math.floor(jumpReach(ph, 0) * 0.62 * extra))),
    up: Math.max(1, Math.min(4, Math.floor(ph.jumpHeight * (ph.doubleJump ? 1.5 : 1) - 0.7))),
    down: 4,
  };
}

type Ctx = { p: Paint; x: number; ground: number; rng: Rng; diff: number; ph: Physics; out: Placement[]; runner: boolean; minGround: number; maxGround: number };
type Chunk = { name: string; weight: (c: Ctx, beat: Beat) => number; build: (c: Ctx) => void };

const put = (c: Ctx, def: string, x: number, y: number, params?: Placement["params"]) => c.out.push(params ? { def, x, y, params } : { def, x, y });
function flat(c: Ctx, w: number) {
  c.p.ground(c.x, c.x + w - 1, c.ground);
  c.x += w;
}
function coinsArc(c: Ctx, x0: number, x1: number, top: number, n = 3) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = Math.round(x0 + (x1 - x0) * t);
    const lift = Math.round(Math.sin(t * Math.PI) * 2);
    put(c, "pickup", x, top - 1 - lift);
  }
}

export const CHUNKS: Chunk[] = [
  { name: "flat", weight: (_c, b) => (b === "intro" ? 3 : 1), build: (c) => {
    const w = c.rng.int(4, 7);
    const x0 = c.x;
    flat(c, w);
    if (c.rng.chance(0.6)) coinsArc(c, x0 + 1, x0 + w - 2, c.ground, Math.min(3, w - 2));
  } },
  { name: "gap", weight: (c, b) => (b === "intro" ? 1 : 2 + c.diff), build: (c) => {
    const L = limits(c.ph);
    flat(c, 2);
    const gap = c.rng.int(Math.max(1, L.gap - 2), Math.max(1, Math.min(L.gap, 2 + Math.round(c.diff * 3))));
    coinsArc(c, c.x, c.x + gap - 1, c.ground - 1, Math.min(3, gap));
    c.x += gap;
    flat(c, 3);
  } },
  { name: "stairs-up", weight: (c) => (c.ground - 1 > c.minGround ? 1.5 : 0), build: (c) => {
    const L = limits(c.ph);
    flat(c, 2);
    const steps = c.rng.int(1, 3);
    for (let i = 0; i < steps && c.ground - 1 > c.minGround; i++) {
      c.ground -= c.rng.int(1, Math.min(2, L.up));
      flat(c, c.rng.int(2, 4));
    }
  } },
  { name: "stairs-down", weight: (c) => (c.ground + 1 < c.maxGround ? 1.5 : 0), build: (c) => {
    flat(c, 2);
    const steps = c.rng.int(1, 2);
    for (let i = 0; i < steps && c.ground + 1 < c.maxGround; i++) {
      c.ground += c.rng.int(1, 2);
      flat(c, c.rng.int(2, 4));
    }
  } },
  { name: "floating", weight: (c, b) => (c.runner ? 0.5 : b === "intro" ? 0 : 1.5), build: (c) => {
    const L = limits(c.ph);
    flat(c, 2);
    // Two short one-way ledges over a pit, each within a jump of the last.
    const pit = c.rng.int(L.gap + 2, L.gap * 2 + 1);
    const y = c.ground - Math.min(2, L.up);
    const mid = c.x + Math.floor(pit / 2);
    c.p.rect(mid - 1, y, mid + 1, y, "=");
    put(c, "pickup", mid, y - 1);
    c.x += pit;
    flat(c, 3);
  } },
  { name: "moving", weight: (c, b) => (c.runner || b === "intro" ? 0 : 1.2 + c.diff), build: (c) => {
    flat(c, 3);
    const pit = c.rng.int(6, 8);
    // Platform rides from the near edge across the pit; its hitbox is 3 wide.
    put(c, "platform", c.x + 1, c.ground - 1, { dx: pit - 3, dy: 0, period: 3 + c.rng.int(0, 2) });
    put(c, "pickup", c.x + Math.floor(pit / 2), c.ground - 4);
    c.x += pit;
    flat(c, 3);
  } },
  { name: "spikes", weight: (c, b) => (b === "intro" ? 0.3 : 1 + c.diff), build: (c) => {
    const x0 = c.x;
    const n = c.rng.int(1, 2 + (c.diff > 0.5 ? 1 : 0));
    flat(c, n + 4);
    for (let i = 0; i < n; i++) c.p.set(x0 + 2 + i, c.ground - 1, "^");
    put(c, "pickup", x0 + 2 + Math.floor(n / 2), c.ground - 4);
  } },
  { name: "walker", weight: (c, b) => (c.runner ? 0 : b === "intro" ? 0.5 : 1.5 + c.diff), build: (c) => {
    const x0 = c.x;
    flat(c, c.rng.int(7, 9));
    put(c, "walker", x0 + 4, c.ground - 1);
  } },
  { name: "flyer", weight: (c, b) => (c.runner || b === "intro" || b === "teach" ? 0 : c.diff * 2), build: (c) => {
    const x0 = c.x;
    flat(c, 8);
    put(c, "flyer", x0 + 4, c.ground - 4);
  } },
  { name: "crumble", weight: (c, b) => (c.runner || b === "intro" ? 0 : 1), build: (c) => {
    flat(c, 2);
    const pit = c.rng.int(4, 6);
    put(c, "crumble", c.x + Math.floor(pit / 2), c.ground - 1);
    c.x += pit;
    flat(c, 3);
  } },
  { name: "spring", weight: (c, b) => (c.runner || b === "intro" || c.ground - 4 <= c.minGround ? 0 : 1), build: (c) => {
    flat(c, 3);
    put(c, "spring", c.x - 2, c.ground - 1);
    c.ground -= c.rng.int(3, 4);
    flat(c, 5);
  } },
  { name: "blocks", weight: (c) => (c.runner ? 0 : 0.8), build: (c) => {
    const x0 = c.x;
    flat(c, 6);
    c.p.rect(x0 + 2, c.ground - 4, x0 + 3, c.ground - 4, "B");
    put(c, "pickup", x0 + 2, c.ground - 5);
    put(c, "pickup", x0 + 3, c.ground - 5);
  } },
  { name: "turret", weight: (c, b) => (c.runner || b === "intro" || b === "teach" ? 0 : c.diff * 1.5), build: (c) => {
    const x0 = c.x;
    flat(c, 8);
    c.p.ground(x0 + 5, x0 + 6, c.ground - 2);
    put(c, "turret", x0 + 6, c.ground - 3);
  } },
];

export type LayoutResult = { tiles: string[]; spawn: [number, number]; placements: Placement[]; width: number };

export function stitchLevel(rng: Rng, beats: Beat[], diff: number, ph: Physics, opts: { runner?: boolean; height?: number; length?: number; boss?: boolean; checkpoint?: boolean } = {}): LayoutResult {
  const h = opts.height ?? 15;
  const length = opts.length ?? Math.round(60 + diff * 50);
  const p = new Paint(length + 40, h);
  const c: Ctx = { p, x: 0, ground: h - 3, rng, diff, ph, out: [], runner: !!opts.runner, minGround: 6, maxGround: h - 2 };
  flat(c, 6);
  const spawn: [number, number] = [2, c.ground - 1];
  let beatIndex = 0;
  let placedCheckpoint = false;
  while (c.x < length) {
    const beat = beats[Math.min(beats.length - 1, Math.floor((c.x / length) * beats.length))] ?? "test";
    const choices = CHUNKS.map((ch) => ({ ch, w: Math.max(0, ch.weight(c, beat)) })).filter((q) => q.w > 0);
    const total = choices.reduce((s, q) => s + q.w, 0);
    let pick = rng.next() * total;
    let chosen = choices[0].ch;
    for (const q of choices) {
      pick -= q.w;
      if (pick <= 0) {
        chosen = q.ch;
        break;
      }
    }
    chosen.build(c);
    if (opts.checkpoint && !placedCheckpoint && c.x > length / 2) {
      flat(c, 2);
      put(c, "checkpoint", c.x - 1, c.ground - 1);
      placedCheckpoint = true;
    }
    beatIndex++;
  }
  // Finale: a boss arena, then the goal.
  if (opts.boss) {
    const x0 = c.x;
    flat(c, 16);
    put(c, "boss", x0 + 10, c.ground - 1);
    c.p.rect(x0 + 3, c.ground - 3, x0 + 5, c.ground - 3, "=");
  }
  const end = c.x;
  flat(c, 8);
  put(c, "goal", end + 5, c.ground - 1);
  const width = c.x;
  const tiles = p.rows().map((r) => r.slice(0, width));
  void beatIndex;
  return { tiles, spawn, placements: c.out, width };
}

// Endless runner streaming: each call makes the next chunk, getting harder with distance.
export function runnerChunk(rng: Rng, index: number, ph: Physics, h: number, ground: number): { columns: string[]; placements: Placement[]; ground: number } {
  const diff = Math.min(1, index / 30);
  const p = new Paint(40, h);
  // Stay within two tiles of the base line so every chunk can climb back to it.
  const c: Ctx = { p, x: 0, ground, rng, diff, ph, out: [], runner: true, minGround: Math.max(6, ground - 3), maxGround: Math.min(h - 2, ground + 3) };
  while (c.x < 24) {
    const choices = CHUNKS.filter((ch) => ch.weight(c, "endless") > 0);
    rng.pick(choices).build(c);
  }
  const w = c.x;
  return { columns: p.rows().map((r) => r.slice(0, w)), placements: c.out, ground: c.ground };
}
