// Asset checks: size, transparency, a readable silhouette and palette adherence.
import { alphaAt, type Pixels, type RGBA } from "./pixels.ts";

export type SpriteCheck = { ok: boolean; problems: string[]; coverage: number; mainShare: number; paletteShare: number };

export function checkSprite(p: Pixels, opts: { w?: number; h?: number; palette?: RGBA[]; minCoverage?: number } = {}): SpriteCheck {
  const problems: string[] = [];
  if (opts.w && p.w !== opts.w) problems.push(`width ${p.w} is not ${opts.w}`);
  if (opts.h && p.h !== opts.h) problems.push(`height ${p.h} is not ${opts.h}`);
  let opaque = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) opaque++;
  const coverage = opaque / (p.w * p.h);
  if (coverage < (opts.minCoverage ?? 0.06)) problems.push(`too empty (${Math.round(coverage * 100)}% filled)`);
  if (coverage > 0.97) problems.push("no transparent background");
  // Transparent corners: sprites must not carry a background box.
  const corners = [[0, 0], [p.w - 1, 0], [0, p.h - 1], [p.w - 1, p.h - 1]].filter(([x, y]) => alphaAt(p, x, y) > 0).length;
  if (corners >= 3 && coverage < 0.97) problems.push("background not cut out");
  // Silhouette: the largest connected shape should hold most of the pixels.
  const seen = new Uint8Array(p.w * p.h);
  let largest = 0;
  for (let s = 0; s < p.w * p.h; s++) {
    if (seen[s] || !p.data[s * 4 + 3]) continue;
    let n = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const x = c % p.w, y = (c / p.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
        const k = ny * p.w + nx;
        if (!seen[k] && p.data[k * 4 + 3]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    largest = Math.max(largest, n);
  }
  const mainShare = opaque ? largest / opaque : 0;
  if (opaque && mainShare < 0.6) problems.push(`silhouette is scattered (${Math.round(mainShare * 100)}% in one shape)`);
  let paletteShare = 1;
  if (opts.palette && opaque) {
    const set = new Set(opts.palette.map((c) => (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])));
    let on = 0;
    for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3] && set.has((p.data[i] << 16) | (p.data[i + 1] << 8) | p.data[i + 2])) on++;
    paletteShare = on / opaque;
    if (paletteShare < 0.97) problems.push(`off-palette colours (${Math.round((1 - paletteShare) * 100)}%)`);
  }
  return { ok: problems.length === 0, problems, coverage, mainShare, paletteShare };
}

// Frame-to-frame drift, for animations: colour histograms of consecutive frames should match.
export function frameDrift(a: Pixels, b: Pixels): number {
  const hist = (p: Pixels) => {
    const m = new Map<number, number>();
    for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3]) {
      const k = (p.data[i] >> 4 << 8) | (p.data[i + 1] >> 4 << 4) | (p.data[i + 2] >> 4);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const ha = hist(a), hb = hist(b);
  const ta = [...ha.values()].reduce((s, v) => s + v, 0) || 1, tb = [...hb.values()].reduce((s, v) => s + v, 0) || 1;
  let d = 0;
  for (const k of new Set([...ha.keys(), ...hb.keys()])) d += Math.abs((ha.get(k) || 0) / ta - (hb.get(k) || 0) / tb);
  return d / 2;
}
