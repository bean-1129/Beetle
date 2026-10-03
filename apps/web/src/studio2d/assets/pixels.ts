// Pixel buffers and color helpers. Everything here is pure, so asset generation and asset
// checks run the same in the app, in exported games and in node tests.

export type Pixels = { w: number; h: number; data: Uint8ClampedArray };
export type RGBA = [number, number, number, number];

export function pixels(w: number, h: number): Pixels {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}
export function clone(p: Pixels): Pixels {
  return { w: p.w, h: p.h, data: new Uint8ClampedArray(p.data) };
}

export function hex(c: string): RGBA {
  const n = parseInt(c.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
export function toHex([r, g, b]: RGBA | [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}
export function shade(c: RGBA, k: number): RGBA {
  return k >= 0 ? mix(c, [255, 255, 255, c[3]], k) : mix(c, [0, 0, 0, c[3]], -k);
}
export function luminance(c: RGBA | [number, number, number]) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function dist2(a: ArrayLike<number>, b: ArrayLike<number>) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
}

export function get(p: Pixels, x: number, y: number): RGBA {
  const i = (y * p.w + x) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]];
}
export function put(p: Pixels, x: number, y: number, c: RGBA) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return;
  const i = (y * p.w + x) * 4;
  const a = c[3] / 255;
  if (a >= 1 || p.data[i + 3] === 0) {
    p.data[i] = c[0];
    p.data[i + 1] = c[1];
    p.data[i + 2] = c[2];
    p.data[i + 3] = c[3];
    return;
  }
  p.data[i] = p.data[i] + (c[0] - p.data[i]) * a;
  p.data[i + 1] = p.data[i + 1] + (c[1] - p.data[i + 1]) * a;
  p.data[i + 2] = p.data[i + 2] + (c[2] - p.data[i + 2]) * a;
  p.data[i + 3] = Math.max(p.data[i + 3], c[3]);
}
export const alphaAt = (p: Pixels, x: number, y: number) => (x < 0 || y < 0 || x >= p.w || y >= p.h ? 0 : p.data[(y * p.w + x) * 4 + 3]);

// ---- shapes (filled, pixel-exact) ----
export function rect(p: Pixels, x0: number, y0: number, w: number, h: number, c: RGBA) {
  for (let y = Math.floor(y0); y < Math.floor(y0 + h); y++) for (let x = Math.floor(x0); x < Math.floor(x0 + w); x++) put(p, x, y, c);
}
export function ellipse(p: Pixels, cx: number, cy: number, rx: number, ry: number, c: RGBA | ((x: number, y: number, u: number, v: number) => RGBA | null)) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
      if (u * u + v * v <= 1) {
        const col = typeof c === "function" ? c(x, y, u, v) : c;
        if (col) put(p, x, y, col);
      }
    }
}
export function poly(p: Pixels, pts: [number, number][], c: RGBA) {
  const ys = pts.map((q) => q[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= py && y2 > py) || (y2 <= py && y1 > py)) xs.push(x1 + ((py - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) put(p, x, y, c);
  }
}
export function line(p: Pixels, x0: number, y0: number, x1: number, y1: number, c: RGBA, thick = 1) {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    rect(p, x0 + (x1 - x0) * t - thick / 2 + 0.5, y0 + (y1 - y0) * t - thick / 2 + 0.5, thick, thick, c);
  }
}

// A one pixel dark outline around every opaque shape: the single biggest readability win for
// small sprites.
export function outline(p: Pixels, c: RGBA): Pixels {
  const out = clone(p);
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      if (alphaAt(p, x, y) > 0) continue;
      if (alphaAt(p, x + 1, y) || alphaAt(p, x - 1, y) || alphaAt(p, x, y + 1) || alphaAt(p, x, y - 1)) put(out, x, y, c);
    }
  return out;
}

// Light from the top-left: brighten pixels near the top-left edge of each shape, darken the
// bottom-right edge.
export function lightEdges(p: Pixels, amount = 0.18) {
  const src = clone(p);
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      if (!alphaAt(src, x, y)) continue;
      const c = get(src, x, y);
      if (!alphaAt(src, x, y - 1) || !alphaAt(src, x - 1, y)) put(p, x, y, shade(c, amount));
      else if (!alphaAt(src, x, y + 1) || !alphaAt(src, x + 1, y)) put(p, x, y, shade(c, -amount));
    }
  return p;
}

export function flipX(p: Pixels): Pixels {
  const out = pixels(p.w, p.h);
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const i = (y * p.w + x) * 4, j = (y * p.w + (p.w - 1 - x)) * 4;
    for (let k = 0; k < 4; k++) out.data[j + k] = p.data[i + k];
  }
  return out;
}

export function blit(dst: Pixels, src: Pixels, dx: number, dy: number) {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      if (src.data[i + 3]) put(dst, dx + x, dy + y, [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]]);
    }
}

// Box-filter downscale (used on generated art before palette snapping).
export function downscale(p: Pixels, w: number, h: number): Pixels {
  const out = pixels(w, h);
  const sx = p.w / w, sy = p.h / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.max(Math.floor(y * sy) + 1, Math.floor((y + 1) * sy)); yy++)
        for (let xx = Math.floor(x * sx); xx < Math.max(Math.floor(x * sx) + 1, Math.floor((x + 1) * sx)); xx++) {
          const i = (yy * p.w + xx) * 4;
          const al = p.data[i + 3];
          r += p.data[i] * al;
          g += p.data[i + 1] * al;
          b += p.data[i + 2] * al;
          a += al;
          n++;
        }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = r / a;
        out.data[o + 1] = g / a;
        out.data[o + 2] = b / a;
      }
      // Pixel styles want hard edges: alpha is either on or off.
      out.data[o + 3] = a / n >= 128 ? 255 : 0;
    }
  return out;
}

// The working palette for pixel styles: the spec palette plus a darker and lighter step of
// each color, so shading stays on-palette.
export function rampPalette(palette: string[]): RGBA[] {
  const out: RGBA[] = [];
  for (const c of palette) {
    const base = hex(c);
    out.push(shade(base, -0.35), base, shade(base, 0.3));
  }
  return out.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255]);
}

export function snapToPalette(p: Pixels, pal: RGBA[]): Pixels {
  const out = clone(p);
  for (let i = 0; i < out.data.length; i += 4) {
    if (!out.data[i + 3]) continue;
    let best = pal[0], bd = Infinity;
    const c = [out.data[i], out.data[i + 1], out.data[i + 2]];
    for (const q of pal) {
      const d = dist2(c, q);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    out.data[i] = best[0];
    out.data[i + 1] = best[1];
    out.data[i + 2] = best[2];
    out.data[i + 3] = 255;
  }
  return out;
}

// The palette color nearest to a wanted color (keeps procedural art on-palette).
export function nearest(pal: RGBA[], want: RGBA): RGBA {
  let best = pal[0], bd = Infinity;
  for (const q of pal) {
    const d = dist2(want, q);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return [best[0], best[1], best[2], want[3]];
}

// Tileable value noise on a w×h torus, in [0,1].
export function tileNoise(w: number, h: number, cell: number, rnd: () => number): (x: number, y: number) => number {
  const gw = Math.max(1, Math.round(w / cell)), gh = Math.max(1, Math.round(h / cell));
  const grid = Array.from({ length: gw * gh }, () => rnd());
  const at = (i: number, j: number) => grid[((j % gh) + gh) % gh * gw + (((i % gw) + gw) % gw)];
  return (x, y) => {
    const fx = (x / w) * gw, fy = (y / h) * gh;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}
