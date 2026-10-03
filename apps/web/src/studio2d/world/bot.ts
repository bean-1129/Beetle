// The playtest bot. It plays a level in the headless engine using only the inputs a person
// has. Action games use beam search over short input macros, steered by a flow field toward
// the current objective; puzzle and builder levels use exact solvers, then replay the
// solution through the engine to prove it works.
import type { GameSpec } from "../spec/types.ts";
import { Game, type State, type Streamer } from "../engine/game.ts";
import { BIT } from "../engine/input.ts";
import { isSolidTile, tileAt, T } from "../engine/physics.ts";
import { puzzleModel, solvePuzzle, type Dir } from "./puzzle.ts";
import { solveBuilder } from "./builder.ts";
import { playDefense } from "./defense.ts";

export type PlaytestResult = {
  passed: boolean;
  level: number;
  frames: number;
  inputs: number[];
  reason: string;
  expanded: number;
  stuckAt?: [number, number];
  placements?: { tick: number; def: string; col: number; row: number }[];
  commands?: { tick: number; kind: "place" | "go"; def?: string; x?: number; y?: number; angle?: number }[];
};

type Macro = { frames: number[]; name: string };
const rep = (n: number, m: number) => Array(n).fill(m);

function macrosFor(genre: string): Macro[] {
  const R = BIT.right, L = BIT.left, J = BIT.jump, U = BIT.up, D = BIT.down, A = BIT.action;
  switch (genre) {
    case "platformer":
      return [
        { name: "R", frames: rep(8, R) },
        { name: "L", frames: rep(8, L) },
        { name: "RJ", frames: [0, ...rep(13, R | J)] },
        { name: "LJ", frames: [0, ...rep(13, L | J)] },
        { name: "J", frames: [0, ...rep(13, J)] },
        { name: "RJs", frames: [0, ...rep(4, R | J), ...rep(5, R)] },
        { name: "wait", frames: rep(8, 0) },
      ];
    case "runner":
      return [
        { name: "run", frames: rep(6, 0) },
        { name: "hop", frames: [0, ...rep(4, J), 0] },
        { name: "leap", frames: [0, ...rep(14, J)] },
      ];
    case "top-down":
    case "arena": {
      const dirs = [R, L, U, D, R | U, R | D, L | U, L | D];
      return [...dirs.map((d) => ({ name: `m${d}`, frames: rep(8, d | A) })), { name: "fire", frames: rep(8, A) }];
    }
    default:
      return [{ name: "wait", frames: rep(8, 0) }];
  }
}

// Breadth-first distance from every cell to the nearest target cell, through non-solid cells.
function flowField(g: Game, targets: [number, number][]) {
  const { w, h } = g.s.grid;
  const dist = new Float32Array(w * h).fill(1e9);
  const q: number[] = [];
  for (const [x, y] of targets)
    if (x >= 0 && y >= 0 && x < w && y < h) {
      dist[y * w + x] = 0;
      q.push(y * w + x);
    }
  const side = g.s.grid.sideView;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    const x = c % w, y = (c / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const t = tileAt(g.s.grid, nx, ny);
        if (isSolidTile(g.s.grid, t)) continue;
        if (!side && dx && dy && (isSolidTile(g.s.grid, tileAt(g.s.grid, x + dx, y)) || isSolidTile(g.s.grid, tileAt(g.s.grid, x, y + dy)))) continue;
        const cost = (dx && dy ? 1.41 : 1) + (t === T.SPIKE ? 6 : 0);
        const n = ny * w + nx;
        if (dist[c] + cost < dist[n]) {
          dist[n] = dist[c] + cost;
          q.push(n);
        }
      }
  }
  return dist;
}

function targetsFor(g: Game): { cells: [number, number][]; kind: string } {
  const s = g.s;
  const cellsOf = (pred: (e: (typeof s.ents)[number]) => boolean) =>
    s.ents.filter((e) => e.alive && pred(e)).map((e) => [Math.floor(e.x + e.w / 2), Math.floor(e.y + e.h / 2)] as [number, number]);
  const wins = g.spec.rules.filter((r) => r.type === "win").map((r) => (r as any).when);
  if (wins.includes("reach-goal")) {
    // Locked doors first need a key.
    const lockedDoor = s.ents.some((e) => e.alive && g.bh(e, "door")?.p.needsKey && !g.bh(e, "door")!.s.open);
    const keys = cellsOf((e) => g.bh(e, "collectible")?.p.effect === "key");
    if (lockedDoor && s.keys === 0 && keys.length) return { cells: keys, kind: "key" };
    if (lockedDoor && s.keys > 0) {
      const doors = cellsOf((e) => !!g.bh(e, "door")?.p.needsKey && !g.bh(e, "door")!.s.open);
      if (doors.length) return { cells: doors, kind: "door" };
    }
    const goals = cellsOf((e) => !!g.bh(e, "goal"));
    if (goals.length) return { cells: goals, kind: "goal" };
  }
  if (wins.includes("collect-all")) {
    const c = cellsOf((e) => !!g.bh(e, "collectible")?.p.required);
    if (c.length) return { cells: c, kind: "collect" };
  }
  const enemies = cellsOf((e) => e.kind === "enemy");
  if (enemies.length) return { cells: enemies, kind: "enemy" };
  const spawners = cellsOf((e) => !!g.bh(e, "spawner") && !g.bh(e, "spawner")!.s.done);
  return { cells: spawners, kind: "spawner" };
}

export type BotOptions = { beam?: number; maxFrames?: number; streamer?: Streamer; seed?: number };

export function playtest(spec: GameSpec, levelIndex = 0, opts: BotOptions = {}): PlaytestResult {
  const genre = spec.meta.genre;
  if (genre === "puzzle") return playPuzzle(spec, levelIndex);
  if (genre === "builder") return playBuilder(spec, levelIndex, opts.seed ?? 1);
  if (genre === "defense") {
    const r = playDefense(spec, levelIndex);
    return { passed: r.won, level: levelIndex, frames: r.frames, inputs: [], reason: r.reason, expanded: r.commands.length, placements: r.commands };
  }
  // Top-down games first try a fast reactive player; the search only runs if it fails.
  if (genre === "top-down" || genre === "arena") {
    const r = policyRun(spec, levelIndex, opts);
    if (r.passed) return r;
    const b = beamSearch(spec, levelIndex, opts);
    return b.passed ? b : { ...b, reason: `${b.reason}; reactive: ${r.reason}` };
  }
  return beamSearch(spec, levelIndex, opts);
}

// A reactive player for top-down games: follows the flow field to the objective, keeps its
// distance from enemies and incoming shots, and fires (with aim assist) the whole time.
export function policyRun(spec: GameSpec, levelIndex: number, opts: BotOptions = {}): PlaytestResult {
  const g = new Game(spec, { level: levelIndex, seed: opts.seed });
  const maxFrames = opts.maxFrames ?? 60 * 150;
  const inputs: number[] = [];
  let flowKey = "";
  let field = new Float32Array(0);
  let choice = 0;
  const DIRS: [number, number, number][] = [[0, 0, 0], [1, 0, BIT.right], [-1, 0, BIT.left], [0, -1, BIT.up], [0, 1, BIT.down], [1, -1, BIT.right | BIT.up], [1, 1, BIT.right | BIT.down], [-1, -1, BIT.left | BIT.up], [-1, 1, BIT.left | BIT.down]];
  const { w, h } = g.s.grid;
  for (let f = 0; f < maxFrames && g.s.status === "playing"; f++) {
    if (f % 4 === 0) {
      const t = targetsFor(g);
      const key = t.kind + t.cells.map((c) => c.join(",")).join(";");
      if (key !== flowKey) {
        flowKey = key;
        field = flowField(g, t.cells);
      }
      const p = g.player;
      const px = p.x + p.w / 2, py = p.y + p.h / 2;
      const threats = g.s.ents.filter((e) => e.alive && !e.hidden && (e.kind === "enemy" || (g.bh(e, "projectile") && !e.friendly) || (g.bh(e, "damage-on-touch") && e.kind === "hazard")));
      const fighting = t.kind === "enemy" || t.kind === "spawner";
      // A threat right next to the player switches from path following to dodging.
      const danger = !fighting && threats.some((e) => Math.hypot(e.x + e.w / 2 - px, e.y + e.h / 2 - py) < (e.tags.includes("boss") ? 3.5 : 2.2));
      if (!fighting && !danger) {
        // Path following: steer to the centre of the neighbouring cell nearest the objective.
        const cx = Math.floor(px), cy = Math.floor(py);
        let bx = cx, by = cy, bd = field[cy * w + cx] ?? 1e9;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (dx && dy && (isSolidTile(g.s.grid, tileAt(g.s.grid, cx + dx, cy)) || isSolidTile(g.s.grid, tileAt(g.s.grid, cx, cy + dy)))) continue;
          const d = field[ny * w + nx];
          if (d < bd - 1e-3) {
            bd = d;
            bx = nx;
            by = ny;
          }
        }
        const tx = bx + 0.5 - px, ty = by + 0.5 - py;
        choice = (tx > 0.08 ? BIT.right : tx < -0.08 ? BIT.left : 0) | (ty > 0.08 ? BIT.down : ty < -0.08 ? BIT.up : 0);
        // In the objective cell itself: walk into it (keys, goals, doors).
        if (bx === cx && by === cy) {
          const tc = t.cells[0];
          if (tc) choice = (tc[0] + 0.5 > px + 0.05 ? BIT.right : tc[0] + 0.5 < px - 0.05 ? BIT.left : 0) | (tc[1] + 0.5 > py + 0.05 ? BIT.down : tc[1] + 0.5 < py - 0.05 ? BIT.up : 0);
        }
      }
      let best = fighting || danger ? -Infinity : Infinity;
      for (let i = 0; i < DIRS.length; i++) {
        const [dx, dy] = DIRS[i];
        const n = dx && dy ? 0.7071 : 1;
        const cx = px + dx * n * 1.1, cy = py + dy * n * 1.1;
        const tx = Math.floor(cx), ty = Math.floor(cy);
        if (tx < 0 || ty < 0 || tx >= w || ty >= h || isSolidTile(g.s.grid, tileAt(g.s.grid, tx, ty))) continue;
        // Blocked by a solid entity (closed door, npc, turret)?
        if (g.s.ents.some((o) => o.alive && o.uid !== p.uid && g.isSolidEnt(o) && cx > o.x - 0.3 && cx < o.x + o.w + 0.3 && cy > o.y - 0.3 && cy < o.y + o.h + 0.3)) continue;
        let score = 0;
        const d = field[ty * w + tx];
        if (!fighting) score -= d >= 1e9 ? 1000 : d * 4;
        else {
          // Hold a firing distance, and prefer spots with a clear shot at the nearest enemy.
          score -= Math.abs(Math.min(d, 60) - 3) * 0.8;
          const near = threats.filter((e) => e.kind === "enemy").sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
          if (near && lineOfSight(g, cx, cy, near.x + near.w / 2, near.y + near.h / 2)) score += 2;
        }
        for (const e of threats) {
          const ex = e.x + e.w / 2 + e.vx * 0.25, ey = e.y + e.h / 2 + e.vy * 0.25;
          const dd = Math.max(0.3, Math.hypot(ex - cx, ey - cy));
          if (dd < 4) score -= (g.bh(e, "projectile") ? 30 : 18) / (dd * dd);
        }
        // Stay off walls a little so the reactive player does not get pinned.
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isSolidTile(g.s.grid, tileAt(g.s.grid, tx + ox, ty + oy))) score -= fighting ? 1.2 : 0.3;
        if (i === 0) score -= fighting ? 0.5 : 3;
        if (score > best) {
          best = score;
          choice = DIRS[i][2];
        }
      }
    }
    const inp = choice | BIT.action;
    g.step(inp);
    inputs.push(inp);
  }
  const passed = g.s.status === "won";
  return { passed, level: levelIndex, frames: inputs.length, inputs, reason: passed ? "won" : g.s.status === "lost" ? "lost" : "timed out", expanded: 1 };
}

function beamSearch(spec: GameSpec, levelIndex: number, opts: BotOptions): PlaytestResult {
  const genre = spec.meta.genre;
  const g = new Game(spec, { level: levelIndex, streamer: opts.streamer, seed: opts.seed });
  const width = opts.beam ?? (genre === "arena" ? 10 : 14);
  const maxFrames = opts.maxFrames ?? Math.min(60 * 240, 60 * (20 + g.s.grid.w * 0.9 + g.s.grid.h * 0.5));
  const macros = macrosFor(genre);
  type Node = { snap: State; inputs: number[]; score: number };
  let flowKey = "";
  let field: Float32Array = new Float32Array(0);
  let targetKind = "";
  const heuristic = (game: Game): number => {
    const t = targetsFor(game);
    const key = t.kind + t.cells.map((c) => c.join(",")).join(";");
    if (key !== flowKey) {
      flowKey = key;
      field = flowField(game, t.cells);
      targetKind = t.kind;
    }
    const p = game.player;
    const cx = Math.floor(p.x + p.w / 2), cy = Math.floor(p.y + p.h / 2);
    const { w, h } = game.s.grid;
    let d = cx >= 0 && cy >= 0 && cx < w && cy < h ? field[cy * w + cx] : 1e9;
    if (d >= 1e9) d = 500;
    const s = game.s;
    let score = d;
    score += s.deaths * 400 + (p.maxHp - p.hp) * 25;
    // Objectives reached (keys found, locked doors opened, required pickups) are progress
    // that must outrank raw distance, or the beam would drop the node that just got a key.
    const stage = s.collected + s.keysFound + s.doorsOpened * 2;
    score -= stage * 1000;
    if (genre === "arena" || targetKind === "enemy" || targetKind === "spawner") {
      const alive = s.ents.filter((e) => e.alive && e.kind === "enemy").length;
      score = alive * 30 + (alive ? 0 : d * 0.5) + (p.maxHp - p.hp) * 40 + s.deaths * 400 - s.defeated * 30;
      // Waves still to come count as work left.
      for (const e of s.ents) {
        const sp = game.bh(e, "spawner");
        if (sp && !sp.s.done) score += ((sp.p.waves || 1) - (sp.s.wave || 0)) * sp.p.perWave * 20;
      }
    }
    if (genre === "runner") score = -p.x * 2 + s.deaths * 1000;
    return score;
  };
  let beam: Node[] = [{ snap: g.snapshot(), inputs: [], score: heuristic(g) }];
  const seen = new Map<string, number>();
  let expanded = 0;
  let bestReason = "ran out of time";
  let furthest = { x: g.player.x, y: g.player.y, score: Infinity };
  while (beam.length) {
    const cand: Node[] = [];
    for (const node of beam) {
      for (const m of macros) {
        g.restore(node.snap);
        const deaths = g.s.deaths;
        const inputs = node.inputs.slice();
        let done = false;
        for (const inp of m.frames) {
          g.step(inp);
          inputs.push(inp);
          if (g.s.status !== "playing") {
            done = true;
            break;
          }
        }
        expanded++;
        if (g.s.status === "won") return { passed: true, level: levelIndex, frames: inputs.length, inputs, reason: "won", expanded };
        if (done || g.s.deaths > deaths) {
          bestReason = g.s.status === "lost" ? "lost every attempt" : bestReason;
          continue;
        }
        if (inputs.length >= maxFrames) continue;
        const p = g.player;
        const alive = genre === "arena" || genre === "top-down" ? g.s.ents.filter((e) => e.alive && e.kind === "enemy").length : 0;
        const key = `${Math.round(p.x * 3)},${Math.round(p.y * 3)},${p.grounded ? 1 : 0},${Math.sign(Math.round(p.vx))},${Math.sign(Math.round(p.vy / 4))},${alive},${g.s.keys},${g.s.collected},${Math.round(p.hp)}`;
        const sc = heuristic(g) + inputs.length * 0.002;
        const prev = seen.get(key);
        if (prev !== undefined && prev <= sc) continue;
        seen.set(key, sc);
        if (sc < furthest.score) furthest = { x: p.x, y: p.y, score: sc };
        cand.push({ snap: g.snapshot(), inputs, score: sc });
      }
    }
    cand.sort((a, b) => a.score - b.score);
    beam = cand.slice(0, width);
  }
  return { passed: false, level: levelIndex, frames: 0, inputs: [], reason: `${bestReason}; got closest at tile ${Math.floor(furthest.x)},${Math.floor(furthest.y)}`, expanded, stuckAt: [furthest.x, furthest.y] };
}

function lineOfSight(g: Game, x0: number, y0: number, x1: number, y1: number) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 3);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (isSolidTile(g.s.grid, tileAt(g.s.grid, Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t)))) return false;
  }
  return true;
}

const DIR_BIT: Record<Dir, number> = { up: BIT.up, down: BIT.down, left: BIT.left, right: BIT.right };

// Replay grid moves: hold each direction until the step finishes.
export function replayPuzzle(spec: GameSpec, levelIndex: number, moves: Dir[]) {
  const g = new Game(spec, { level: levelIndex });
  const inputs: number[] = [];
  for (const mv of moves) {
    const ctrl = g.bh(g.player, "top-down-controller")!;
    const start = [g.player.x, g.player.y];
    let started = false;
    for (let f = 0; f < 40; f++) {
      const inp = started ? 0 : DIR_BIT[mv];
      g.step(inp);
      inputs.push(inp);
      if (ctrl.s.moving) started = true;
      if (g.s.status !== "playing") break;
      if (started && !ctrl.s.moving) break;
    }
    if (g.s.status !== "playing") break;
    if (!started || (g.player.x === start[0] && g.player.y === start[1])) break;
  }
  for (let f = 0; f < 30 && g.s.status === "playing"; f++) {
    g.step(0);
    inputs.push(0);
  }
  return { game: g, inputs };
}

function playPuzzle(spec: GameSpec, levelIndex: number): PlaytestResult {
  const model = puzzleModel(spec, spec.levels[levelIndex]);
  const moves = solvePuzzle(model);
  if (!moves) return { passed: false, level: levelIndex, frames: 0, inputs: [], reason: "no solution exists", expanded: 0 };
  const { game, inputs } = replayPuzzle(spec, levelIndex, moves);
  const passed = game.s.status === "won";
  return { passed, level: levelIndex, frames: inputs.length, inputs, reason: passed ? "won" : "solution did not replay in the engine", expanded: moves.length };
}

function playBuilder(spec: GameSpec, levelIndex: number, seed: number): PlaytestResult {
  const parts = solveBuilder(spec, levelIndex, seed);
  if (!parts) return { passed: false, level: levelIndex, frames: 0, inputs: [], reason: "no layout of the parts reaches the goal", expanded: 0 };
  const g = new Game(spec, { level: levelIndex });
  const commands: PlaytestResult["commands"] = [];
  for (const p of parts) {
    g.placePart(p.def, p.x, p.y, p.angle);
    commands.push({ tick: 0, kind: "place", def: p.def, x: p.x, y: p.y, angle: p.angle });
  }
  const inputs: number[] = [BIT.action];
  g.step(BIT.action);
  commands.push({ tick: 0, kind: "go" });
  for (let f = 0; f < 1200 && g.s.status === "playing"; f++) {
    g.step(0);
    inputs.push(0);
  }
  const passed = g.s.status === "won";
  return { passed, level: levelIndex, frames: inputs.length, inputs, reason: passed ? "won" : "layout did not replay", expanded: parts.length, commands };
}

// Replay recorded inputs from the start of a level and report the outcome.
export function replay(spec: GameSpec, levelIndex: number, inputs: number[], streamer?: Streamer) {
  const g = new Game(spec, { level: levelIndex, streamer });
  for (const i of inputs) {
    g.step(i);
    if (g.s.status === "won" || g.s.status === "lost") break;
  }
  return g;
}
