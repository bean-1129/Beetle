// Deterministic 2D physics in tile units: axis-separated box sweeps against the tilemap and
// solid entities, one-way platforms, and circle bodies against boxes and rotated boxes for
// the physics-builder genre. Only +, -, *, / and sqrt are used in the step, so results are
// bit-identical run to run.

export const EPS = 1e-6;
export const T = { EMPTY: 0, SOLID: 1, ONEWAY: 2, SPIKE: 3, WATER: 4, BREAK: 5, WALL: 6 } as const;
const CODE: Record<string, number> = { ".": 0, "#": 1, "=": 2, "^": 3, "~": 4, B: 5, W: 6 };
const CHAR = [".", "#", "=", "^", "~", "B", "W"];

export type Grid = { w: number; h: number; cells: Uint8Array; sideView: boolean };

export function makeGrid(rows: string[], sideView: boolean): Grid {
  const h = rows.length, w = rows[0]?.length ?? 0;
  const cells = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells[y * w + x] = CODE[rows[y][x]] ?? 0;
  return { w, h, cells, sideView };
}
export function gridRows(g: Grid): string[] {
  const out: string[] = [];
  for (let y = 0; y < g.h; y++) {
    let r = "";
    for (let x = 0; x < g.w; x++) r += CHAR[g.cells[y * g.w + x]];
    out.push(r);
  }
  return out;
}
export function tileAt(g: Grid, x: number, y: number): number {
  if (x < 0 || x >= g.w) return T.SOLID;
  if (y < 0) return g.sideView ? T.EMPTY : T.SOLID;
  if (y >= g.h) return g.sideView ? T.EMPTY : T.SOLID;
  return g.cells[y * g.w + x];
}
export function setTile(g: Grid, x: number, y: number, t: number) {
  if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.cells[y * g.w + x] = t;
}
export function isSolidTile(g: Grid, t: number): boolean {
  return t === T.SOLID || t === T.BREAK || t === T.WALL || (!g.sideView && t === T.WATER);
}

export type Box = { x: number; y: number; w: number; h: number; oneWay?: boolean; uid?: number };
export type Mover = { x: number; y: number; w: number; h: number; vx: number; vy: number };
export type MoveResult = { hitLeft: boolean; hitRight: boolean; hitUp: boolean; hitDown: boolean; groundUid: number; ceilTiles: [number, number][] };

const overlap1 = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - EPS && a1 > b0 + EPS;

// Move a box by (dx, dy): X first, then Y. Clamps against solid tiles, one-way tiles (only
// when falling onto their top) and the given solid boxes. dropThrough ignores one-way floors.
export function moveBox(g: Grid, m: Mover, dx: number, dy: number, solids: Box[], dropThrough = false): MoveResult {
  const res: MoveResult = { hitLeft: false, hitRight: false, hitUp: false, hitDown: false, groundUid: -1, ceilTiles: [] };
  // ---- X ----
  if (dx !== 0) {
    let nx = m.x + dx;
    const y0 = Math.floor(m.y + EPS), y1 = Math.floor(m.y + m.h - EPS);
    if (dx > 0) {
      const c0 = Math.floor(m.x + m.w - EPS), c1 = Math.floor(nx + m.w - EPS);
      for (let c = c0 + 1; c <= c1; c++)
        for (let r = y0; r <= y1; r++)
          if (isSolidTile(g, tileAt(g, c, r))) {
            nx = Math.min(nx, c - m.w);
            res.hitRight = true;
          }
      for (const s of solids)
        if (!s.oneWay && overlap1(m.y, m.y + m.h, s.y, s.y + s.h) && m.x + m.w <= s.x + EPS && nx + m.w > s.x) {
          nx = Math.min(nx, s.x - m.w);
          res.hitRight = true;
        }
    } else {
      const c0 = Math.floor(m.x + EPS), c1 = Math.floor(nx + EPS);
      for (let c = c0 - 1; c >= c1; c--)
        for (let r = y0; r <= y1; r++)
          if (isSolidTile(g, tileAt(g, c, r))) {
            nx = Math.max(nx, c + 1);
            res.hitLeft = true;
          }
      for (const s of solids)
        if (!s.oneWay && overlap1(m.y, m.y + m.h, s.y, s.y + s.h) && m.x >= s.x + s.w - EPS && nx < s.x + s.w) {
          nx = Math.max(nx, s.x + s.w);
          res.hitLeft = true;
        }
    }
    m.x = nx;
    if (res.hitLeft || res.hitRight) m.vx = 0;
  }
  // ---- Y ----
  if (dy !== 0) {
    let ny = m.y + dy;
    const x0 = Math.floor(m.x + EPS), x1 = Math.floor(m.x + m.w - EPS);
    if (dy > 0) {
      const bottom = m.y + m.h;
      const r0 = Math.floor(bottom - EPS), r1 = Math.floor(ny + m.h - EPS);
      for (let r = r0 + 1; r <= r1; r++)
        for (let c = x0; c <= x1; c++) {
          const t = tileAt(g, c, r);
          if (isSolidTile(g, t) || (g.sideView && t === T.ONEWAY && !dropThrough && bottom <= r + EPS)) {
            if (r - m.h < ny) {
              ny = r - m.h;
              res.hitDown = true;
              res.groundUid = -1;
            }
          }
        }
      for (const s of solids)
        if (overlap1(m.x, m.x + m.w, s.x, s.x + s.w) && bottom <= s.y + EPS && ny + m.h > s.y && !(s.oneWay && dropThrough)) {
          if (s.y - m.h <= ny) {
            ny = s.y - m.h;
            res.hitDown = true;
            res.groundUid = s.uid ?? -1;
          }
        }
    } else {
      const r0 = Math.floor(m.y + EPS), r1 = Math.floor(ny + EPS);
      for (let r = r0 - 1; r >= r1; r--)
        for (let c = x0; c <= x1; c++)
          if (isSolidTile(g, tileAt(g, c, r))) {
            if (r + 1 > ny) {
              ny = r + 1;
              res.hitUp = true;
              res.ceilTiles.push([c, r]);
            }
          }
      for (const s of solids)
        if (!s.oneWay && overlap1(m.x, m.x + m.w, s.x, s.x + s.w) && m.y >= s.y + s.h - EPS && ny < s.y + s.h) {
          ny = Math.max(ny, s.y + s.h);
          res.hitUp = true;
        }
    }
    m.y = ny;
    if (res.hitDown || res.hitUp) m.vy = 0;
  }
  return res;
}

// Is there solid ground directly beneath the point (x, y)? Used by patrol ledge checks.
export function groundBelow(g: Grid, x: number, y: number): boolean {
  const t = tileAt(g, Math.floor(x), Math.floor(y + 0.05));
  return isSolidTile(g, t) || t === T.ONEWAY;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
}

// Does the box touch any tile of the given type?
export function touchesTile(g: Grid, m: Box, type: number, shrink = 0.1): boolean {
  const x0 = Math.floor(m.x + shrink), x1 = Math.floor(m.x + m.w - shrink);
  const y0 = Math.floor(m.y + shrink), y1 = Math.floor(m.y + m.h - shrink);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (tileAt(g, x, y) === type) return true;
  return false;
}

// ---------------- circles (physics builder) ----------------

// A rotated box: center, half extents and rotation as a unit vector (cos, sin), precomputed by
// the caller so the step itself uses no trigonometry.
export type OBB = { cx: number; cy: number; hw: number; hh: number; c: number; s: number; bounce: number; friction: number; uid: number; boost?: number };
export type Ball = { x: number; y: number; r: number; vx: number; vy: number; bounce: number; friction: number };

// Push a ball out of a rotated box. Returns the contact normal or null.
export function ballVsOBB(b: Ball, o: OBB): { nx: number; ny: number; depth: number } | null {
  const dx = b.x - o.cx, dy = b.y - o.cy;
  // Into box space.
  const lx = dx * o.c + dy * o.s;
  const ly = -dx * o.s + dy * o.c;
  const qx = Math.max(-o.hw, Math.min(o.hw, lx));
  const qy = Math.max(-o.hh, Math.min(o.hh, ly));
  let nxL = lx - qx, nyL = ly - qy;
  let d2 = nxL * nxL + nyL * nyL;
  let depth: number;
  if (d2 > EPS) {
    if (d2 >= b.r * b.r) return null;
    const d = Math.sqrt(d2);
    nxL /= d;
    nyL /= d;
    depth = b.r - d;
  } else {
    // Center inside the box: push out along the nearest face.
    const px = o.hw - Math.abs(lx), py = o.hh - Math.abs(ly);
    if (px < py) {
      nxL = lx < 0 ? -1 : 1;
      nyL = 0;
      depth = px + b.r;
    } else {
      nxL = 0;
      nyL = ly < 0 ? -1 : 1;
      depth = py + b.r;
    }
  }
  // Back to world space.
  return { nx: nxL * o.c - nyL * o.s, ny: nxL * o.s + nyL * o.c, depth };
}

export function resolveBall(b: Ball, n: { nx: number; ny: number; depth: number }, bounce: number, friction: number) {
  b.x += n.nx * n.depth;
  b.y += n.ny * n.depth;
  const vn = b.vx * n.nx + b.vy * n.ny;
  if (vn < 0) {
    const e = Math.max(b.bounce, bounce);
    // Remove the normal part (with restitution), damp the tangential part a little.
    const tx = b.vx - vn * n.nx, ty = b.vy - vn * n.ny;
    const keep = 1 - Math.min(0.2, friction * 0.03);
    b.vx = tx * keep - e * vn * n.nx;
    b.vy = ty * keep - e * vn * n.ny;
    // Resting contacts should not jitter.
    if (Math.abs(vn) < 0.6) {
      b.vx = tx * keep;
      b.vy = ty * keep;
    }
  }
}

// Precompute cos/sin for an angle given in whole degrees, from a table (no trig in the step).
const TRIG: [number, number][] = [];
for (let d = 0; d < 360; d++) TRIG.push([Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)]);
export function rot(deg: number): [number, number] {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return TRIG[d];
}
