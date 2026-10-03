// Tilesets that join cleanly. One tileable base texture per material; every edge and corner
// variant is made by masking that same texture, so all tiles share one material. Supports
// the 47-tile blob layout (and the 16-tile edge layout as a subset), plus seam checks.
import { pixels, put, get, shade, mix, tileNoise, rampPalette, nearest, type Pixels, type RGBA } from "./pixels.ts";
import { materialOf, type Style } from "./sprites.ts";
import { mulberry } from "../engine/rng.ts";

// Neighbour bits: N NE E SE S SW W NW.
export const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;

// Corners only matter when both of their edges are solid.
export function canonical(mask: number): number {
  let m = mask;
  if (!(m & N) || !(m & E)) m &= ~NE;
  if (!(m & S) || !(m & E)) m &= ~SE;
  if (!(m & S) || !(m & W)) m &= ~SW;
  if (!(m & N) || !(m & W)) m &= ~NW;
  return m;
}
export const BLOB_MASKS: number[] = (() => {
  const set = new Set<number>();
  for (let m = 0; m < 256; m++) set.add(canonical(m));
  return [...set].sort((a, b) => a - b);
})();
export const BLOB_INDEX = new Map(BLOB_MASKS.map((m, i) => [m, i]));
// The simple 16-tile layout: edges only.
export const EDGE_MASKS = Array.from({ length: 16 }, (_, i) => (i & 1 ? N : 0) | (i & 2 ? E : 0) | (i & 4 ? S : 0) | (i & 8 ? W : 0));

export type Tileset = {
  size: number;
  material: string;
  solid: Pixels[]; // indexed by BLOB_INDEX
  oneway: Pixels;
  spike: Pixels;
  water: Pixels;
  breakable: Pixels;
  wall: Pixels[]; // top-down walls, blob indexed
  floor: Pixels; // top-down floor
};

function baseTexture(size: number, body: RGBA, accent: RGBA, rnd: () => number, material: string): Pixels {
  const p = pixels(size, size);
  const n1 = tileNoise(size, size, Math.max(2, size / 4), rnd);
  const n2 = tileNoise(size, size, Math.max(1, size / 8), rnd);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const v = n1(x, y) * 0.65 + n2(x, y) * 0.35;
      let c = shade(body, (v - 0.5) * 0.35);
      if (v > 0.78) c = mix(c, accent, 0.5);
      if (material === "brick" || material === "stone") {
        const row = Math.floor(y / (size / 2));
        const off = row % 2 ? size / 2 : 0;
        if (y % (size / 2) === 0 || (x + off) % size === 0) c = shade(body, -0.3);
      }
      if (material === "metal" && (x === size / 2 || y === size / 2)) c = shade(body, 0.2);
      put(p, x, y, c);
    }
  return p;
}

// Surface band along the top: grass, snow, sand crust... Its ragged edge depends only on x,
// so neighbouring tiles line up.
function topBand(size: number, top: RGBA, rnd: () => number) {
  const n = tileNoise(size, size, Math.max(2, size / 4), rnd);
  return (x: number) => Math.round(size * 0.2 + n(x, 0) * size * 0.2);
}

export function makeTileset(recipe: string, size: number, style: Style, palette: string[], seed: number, sideView = true): Tileset {
  const rng = mulberry(seed);
  const rnd = () => rng.next();
  const mat = materialOf(recipe, palette);
  const pal = style === "pixel" ? rampPalette(palette).concat([mat.top, mat.body, mat.accent, shade(mat.body, -0.3), shade(mat.body, 0.2), shade(mat.top, -0.2), shade(mat.top, 0.2)]) : null;
  const snap = (p: Pixels) => {
    if (!pal) return p;
    for (let i = 0; i < p.data.length; i += 4) {
      if (!p.data[i + 3]) continue;
      const c = nearest(pal, [p.data[i], p.data[i + 1], p.data[i + 2], 255]);
      p.data[i] = c[0];
      p.data[i + 1] = c[1];
      p.data[i + 2] = c[2];
    }
    return p;
  };
  const base = baseTexture(size, mat.body, mat.accent, rnd, mat.name);
  const band = topBand(size, mat.top, rnd);
  const edge = Math.max(1, Math.round(size / 8));
  const variant = (mask: number, wallMode: boolean): Pixels => {
    const p = pixels(size, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let c = get(base, x, y);
        if (wallMode) c = shade(c, 0.12);
        const openN = !(mask & N), openS = !(mask & S), openE = !(mask & E), openW = !(mask & W);
        const b = band(x);
        if (openN && y < b && !wallMode) c = shade(mat.top, (y / b) * -0.25);
        else if (openN && y < edge) c = shade(wallMode ? c : mat.top, 0.25);
        if (openS && y >= size - edge) c = shade(c, -0.35);
        if (openE && x >= size - edge) c = shade(c, -0.25);
        if (openW && x < edge) c = shade(c, openN && !wallMode && y < b ? 0 : 0.12);
        // Inner corners: the diagonal cell is open while both edges are solid.
        if (mask & N && mask & E && !(mask & NE) && x >= size - edge * 2 && y < edge * 2) c = wallMode ? shade(c, -0.25) : mat.top;
        if (mask & N && mask & W && !(mask & NW) && x < edge * 2 && y < edge * 2) c = wallMode ? shade(c, -0.25) : mat.top;
        if (mask & S && mask & E && !(mask & SE) && x >= size - edge && y >= size - edge) c = shade(c, -0.3);
        if (mask & S && mask & W && !(mask & SW) && x < edge && y >= size - edge) c = shade(c, -0.3);
        put(p, x, y, c);
      }
    return snap(p);
  };
  const solid = BLOB_MASKS.map((m) => variant(m, !sideView));
  const wall = BLOB_MASKS.map((m) => variant(m, true));
  const oneway = pixels(size, size);
  for (let y = 0; y < Math.max(3, size / 3); y++)
    for (let x = 0; x < size; x++) put(oneway, x, y, y < 2 ? mat.top : shade(get(base, x, y), y === Math.floor(size / 3) - 1 ? -0.3 : 0));
  const spike = pixels(size, size);
  const n = 3;
  for (let i = 0; i < n; i++)
    for (let y = 0; y < size; y++) {
      const half = ((size - y) / size) * (size / n / 2);
      const cx = (i + 0.5) * (size / n);
      for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) if (y > size * 0.35) put(spike, x, y, shade([200, 205, 215, 255], x < cx ? 0.2 : -0.2));
    }
  const water = pixels(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(water, x, y, shade([60, 140, 210, 190], ((x + y * 2) % size) / size * 0.2 - 0.1));
  const breakable = pixels(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = shade(mat.accent, (x === 0 || y === 0 ? 0.25 : x === size - 1 || y === size - 1 ? -0.35 : 0) + (((x * 7 + y * 3) % 11) === 0 ? -0.25 : 0));
      put(breakable, x, y, c);
    }
  const floor = pixels(size, size);
  const fn = tileNoise(size, size, Math.max(2, size / 4), rnd);
  const floorBase = sideView ? mat.body : mix(mat.top, mat.accent, 0.35);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(floor, x, y, shade(floorBase, (fn(x, y) - 0.5) * 0.18 - 0.08));
  return { size, material: mat.name, solid, oneway: snap(oneway), spike, water, breakable: snap(breakable), wall, floor: snap(floor) };
}

// Pick the variant for a cell from its eight neighbours.
export function blobIndexAt(solidAt: (x: number, y: number) => boolean, x: number, y: number): number {
  let m = 0;
  if (solidAt(x, y - 1)) m |= N;
  if (solidAt(x + 1, y - 1)) m |= NE;
  if (solidAt(x + 1, y)) m |= E;
  if (solidAt(x + 1, y + 1)) m |= SE;
  if (solidAt(x, y + 1)) m |= S;
  if (solidAt(x - 1, y + 1)) m |= SW;
  if (solidAt(x - 1, y)) m |= W;
  if (solidAt(x - 1, y - 1)) m |= NW;
  return BLOB_INDEX.get(canonical(m))!;
}

// Seam check: tile a piece 3x3 (or next to a partner) and compare the colour step across
// tile borders with the colour steps inside the tile. A clean join has border steps no
// bigger than the texture's own detail.
export function seamScore(a: Pixels, b: Pixels = a, axis: "x" | "y" = "x"): { border: number; inner: number; ok: boolean } {
  const size = a.w;
  const diff = (p: RGBA, q: RGBA) => (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) / 3;
  const step = (img: Pixels, j0: number, other: Pixels, j1: number) => {
    let s = 0;
    for (let i = 0; i < size; i++) s += axis === "x" ? diff(get(img, j0, i), get(other, j1, i)) : diff(get(img, i, j0), get(other, i, j1));
    return s / size;
  };
  const border = step(a, size - 1, b, 0);
  // The border should look like any other line-to-line step inside the texture, never an
  // outlier: compare it with the strongest step inside either tile.
  let inner = 0;
  for (let j = 1; j < size; j++) inner = Math.max(inner, step(a, j - 1, a, j), step(b, j - 1, b, j));
  return { border, inner, ok: border <= inner * 1.25 + 3 };
}

// Check every piece that can sit beside another along a shared solid edge.
export function checkTileset(t: Tileset): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const full = t.solid[BLOB_INDEX.get(255)!];
  const pairs: [string, number, number, "x" | "y"][] = [
    ["interior-x", 255, 255, "x"],
    ["interior-y", 255, 255, "y"],
    ["surface-x", canonical(0xff & ~(N | NE | NW)), canonical(0xff & ~(N | NE | NW)), "x"],
    ["wall-y", canonical(0xff & ~(E | NE | SE)), canonical(0xff & ~(E | NE | SE)), "y"],
  ];
  for (const [name, ma, mb, axis] of pairs) {
    const s = seamScore(t.solid[BLOB_INDEX.get(ma)!], t.solid[BLOB_INDEX.get(mb)!], axis);
    if (!s.ok) failures.push(`${name}: border ${s.border.toFixed(1)} vs inner ${s.inner.toFixed(1)}`);
  }
  const f = seamScore(t.floor, t.floor, "x");
  if (!f.ok) failures.push("floor");
  void full;
  return { ok: failures.length === 0, failures };
}
