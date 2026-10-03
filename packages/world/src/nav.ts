// Nav grid construction and reachability (4-neighbour BFS) over a compiled world.
import { GEOMETRY, WORLD_LIMITS, type Vec2 } from '@beetle/contracts';
import type { CompiledWorld, NavGrid } from './types.ts';

type FitsFn = (x: number, z: number, opts: { gateOpen: boolean }) => boolean;
type BlockedFn = (x: number, z: number, opts: { gateOpen: boolean }) => string | null;

/**
 * Builds the nav grid covering ±bounds.halfExtent at GEOMETRY.navCell.
 * walkable = fits(cellCentre, { gateOpen: false }); gateCells = cells that become walkable only with the gate open.
 */
export function buildNavGrid(fits: FitsFn, blockedAt: BlockedFn, gateId: string | null): NavGrid {
  const H = WORLD_LIMITS.bounds.halfExtent;
  const cell = GEOMETRY.navCell;
  const cols = Math.ceil((2 * H) / cell);
  const rows = cols;
  const originX = -H + cell / 2;
  const originZ = -H + cell / 2;
  const walkable = new Uint8Array(cols * rows);
  const gateCells = new Uint8Array(cols * rows);
  const locked = { gateOpen: false };
  const open = { gateOpen: true };
  for (let row = 0; row < rows; row++) {
    const z = originZ + row * cell;
    for (let col = 0; col < cols; col++) {
      const x = originX + col * cell;
      const i = row * cols + col;
      if (fits(x, z, locked)) {
        walkable[i] = 1;
      } else if (gateId !== null && blockedAt(x, z, locked) === gateId && fits(x, z, open)) {
        gateCells[i] = 1;
      }
    }
  }
  return {
    cell, originX, originZ, cols, rows, walkable, gateCells,
    indexOf(x: number, z: number): number {
      const col = Math.floor((x + H) / cell);
      const row = Math.floor((z + H) / cell);
      if (col < 0 || row < 0 || col >= cols || row >= rows || !Number.isFinite(col) || !Number.isFinite(row)) return -1;
      return row * cols + col;
    },
    centerOf(index: number): Vec2 {
      const col = index % cols;
      const row = Math.floor(index / cols);
      return { x: originX + col * cell, z: originZ + row * cell };
    },
  };
}

export function isWalkable(nav: NavGrid, index: number, gateOpen: boolean): boolean {
  if (index < 0) return false;
  return nav.walkable[index] === 1 || (gateOpen && nav.gateCells[index] === 1);
}

/** Indices of grid cells whose centre lies within radius of p (square prefilter then exact distance). */
export function cellsWithin(nav: NavGrid, p: Vec2, radius: number): number[] {
  const out: number[] = [];
  const H = WORLD_LIMITS.bounds.halfExtent;
  const c0 = Math.max(0, Math.floor((p.x - radius + H) / nav.cell));
  const c1 = Math.min(nav.cols - 1, Math.floor((p.x + radius + H) / nav.cell));
  const r0 = Math.max(0, Math.floor((p.z - radius + H) / nav.cell));
  const r1 = Math.min(nav.rows - 1, Math.floor((p.z + radius + H) / nav.cell));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * nav.cols + col;
      const c = nav.centerOf(i);
      if (Math.hypot(c.x - p.x, c.z - p.z) <= radius) out.push(i);
    }
  }
  return out;
}

/** Nearest walkable cell (by centre distance) within snapRadius of p, or -1. */
export function nearestWalkable(nav: NavGrid, p: Vec2, snapRadius: number, gateOpen: boolean): number {
  let best = -1;
  let bestD = Infinity;
  for (const i of cellsWithin(nav, p, snapRadius)) {
    if (!isWalkable(nav, i, gateOpen)) continue;
    const c = nav.centerOf(i);
    const d = Math.hypot(c.x - p.x, c.z - p.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export type Flood = { start: number; parent: Int32Array; visited: Uint8Array; count: number };

/** BFS flood from a start cell. parent[i] = previous cell index on the shortest path (start maps to itself). */
export function flood(nav: NavGrid, start: number, gateOpen: boolean): Flood {
  const n = nav.cols * nav.rows;
  const parent = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  let count = 0;
  if (start < 0 || !isWalkable(nav, start, gateOpen)) return { start, parent, visited, count };
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  visited[start] = 1;
  parent[start] = start;
  const cols = nav.cols;
  while (head < tail) {
    const i = queue[head++];
    count++;
    const col = i % cols;
    const row = (i - col) / cols;
    // 4-neighbour expansion
    if (col > 0) tryPush(i - 1);
    if (col < cols - 1) tryPush(i + 1);
    if (row > 0) tryPush(i - cols);
    if (row < nav.rows - 1) tryPush(i + cols);
  }
  return { start, parent, visited, count };

  function tryPush(j: number): void {
    if (visited[j] === 1) return;
    if (!isWalkable(nav, j, gateOpen)) return;
    visited[j] = 1;
    parent[j] = queue[head - 1];
    queue[tail++] = j;
  }
}

/** First reached goal cell (closest to `to`) among walkable cells within goalRadius, or -1. */
export function reachedGoal(nav: NavGrid, f: Flood, to: Vec2, goalRadius: number, gateOpen: boolean): number {
  let best = -1;
  let bestD = Infinity;
  for (const i of cellsWithin(nav, to, goalRadius)) {
    if (!isWalkable(nav, i, gateOpen) || f.visited[i] !== 1) continue;
    const c = nav.centerOf(i);
    const d = Math.hypot(c.x - to.x, c.z - to.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function pathTo(nav: NavGrid, f: Flood, goal: number): Vec2[] {
  const cells: number[] = [];
  let i = goal;
  let guard = nav.cols * nav.rows + 1;
  while (i >= 0 && guard-- > 0) {
    cells.push(i);
    if (i === f.start) break;
    i = f.parent[i];
  }
  cells.reverse();
  return cells.map((c) => nav.centerOf(c));
}

/** BFS on the nav grid from the nearest walkable cell to `from` (within snapRadius) to any walkable cell within goalRadius of `to`. */
export function reachable(
  compiled: CompiledWorld,
  from: Vec2,
  to: Vec2,
  opts: { gateOpen?: boolean; snapRadius?: number; goalRadius?: number } = {},
): { reachable: boolean; cells: number; path?: Vec2[] } {
  const gateOpen = opts.gateOpen ?? false;
  const snapRadius = opts.snapRadius ?? 1.0;
  const goalRadius = opts.goalRadius ?? GEOMETRY.relicPickupRadius;
  const nav = compiled.nav;
  const start = nearestWalkable(nav, from, snapRadius, gateOpen);
  if (start < 0) return { reachable: false, cells: 0 };
  const f = flood(nav, start, gateOpen);
  const goal = reachedGoal(nav, f, to, goalRadius, gateOpen);
  if (goal < 0) return { reachable: false, cells: f.count };
  const path = pathTo(nav, f, goal);
  return { reachable: true, cells: path.length, path };
}
