// Parallax backgrounds: sky, far shapes and near shapes, each tileable horizontally so the
// renderer can scroll them forever at different speeds.
import { pixels, put, shade, mix, hex, rampPalette, nearest, type Pixels, type RGBA } from "./pixels.ts";
import { mulberry } from "../engine/rng.ts";
import type { Style } from "./sprites.ts";

type Scene = { sky: [string, string]; far: string; near: string; kind: "trees" | "dunes" | "peaks" | "city" | "stars" | "coral" | "cave" | "candy" };
function sceneOf(recipe: string): Scene {
  const r = recipe.toLowerCase();
  if (/space|galaxy|star|moon|asteroid/.test(r)) return { sky: ["#05050f", "#1c1c4a"], far: "#2b2b6e", near: "#141432", kind: "stars" };
  if (/desert|sand|dune|egypt/.test(r)) return { sky: ["#f2b36a", "#fff1d0"], far: "#d68a45", near: "#a0562e", kind: "dunes" };
  if (/snow|ice|arctic|winter|mountain/.test(r)) return { sky: ["#9cc3d9", "#eaf6fd"], far: "#c7dcea", near: "#6f93ab", kind: "peaks" };
  if (/lava|volcano|fire/.test(r)) return { sky: ["#2a0c0c", "#7a2418"], far: "#4a1a14", near: "#1a0b0b", kind: "peaks" };
  if (/city|street|urban|roof|neon/.test(r)) return { sky: ["#1c2150", "#5c6fd6"], far: "#34408a", near: "#161a3a", kind: "city" };
  if (/ocean|sea|reef|coral|underwater/.test(r)) return { sky: ["#0f3b52", "#2aa3c4"], far: "#17658a", near: "#0a2a3a", kind: "coral" };
  if (/cave|dungeon|mine|castle|temple/.test(r)) return { sky: ["#141418", "#2e2e3d"], far: "#26262f", near: "#101014", kind: "cave" };
  if (/candy|sweet|cake/.test(r)) return { sky: ["#ffc1dc", "#fff4f8"], far: "#f278b8", near: "#a54aa5", kind: "candy" };
  if (/night/.test(r)) return { sky: ["#0d1026", "#34408a"], far: "#1c2150", near: "#0b0d1c", kind: "trees" };
  if (/rain/.test(r)) return { sky: ["#4a5a6a", "#9aa8b4"], far: "#56705f", near: "#2e4a3a", kind: "trees" };
  return { sky: ["#8fd0ff", "#e6f7ff"], far: "#7fb88a", near: "#2e6b3f", kind: "trees" };
}

// Periodic height profile built from whole-number harmonics, so it wraps at width w.
function profile(w: number, rng: ReturnType<typeof mulberry>, harmonics: number, amp: number) {
  const hs = Array.from({ length: harmonics }, (_, i) => ({ k: i + 1 + rng.int(0, 2), a: amp / (i + 1.3), p: rng.next() * Math.PI * 2 }));
  return (x: number) => hs.reduce((s, h) => s + h.a * Math.sin((x / w) * Math.PI * 2 * h.k + h.p), 0);
}

export function makeBackground(recipe: string, w: number, h: number, style: Style, palette: string[], seed: number): Pixels {
  const r = recipe.toLowerCase();
  const rng = mulberry(seed);
  const sc = sceneOf(r);
  const p = pixels(w, h);
  const layer = /sky|far/.test(r) ? "sky" : /hill|mid|dune|mountain|peak/.test(r) ? "mid" : "near";
  const pal = style === "pixel" ? rampPalette(palette).concat([hex(sc.sky[0]), hex(sc.sky[1]), hex(sc.far), hex(sc.near), shade(hex(sc.far), 0.15), shade(hex(sc.near), 0.15)]) : null;
  const c = (col: RGBA) => (pal ? nearest(pal, col) : col);
  if (layer === "sky") {
    const top = hex(sc.sky[0]), bottom = hex(sc.sky[1]);
    for (let y = 0; y < h; y++) {
      // Dithered bands keep the gradient smooth in few colours.
      const t = y / (h - 1);
      for (let x = 0; x < w; x++) {
        const dither = ((x + y) % 2) * 0.04;
        const band = pal ? Math.floor((t + dither) * 6) / 6 : t;
        put(p, x, y, mix(top, bottom, band));
      }
    }
    if (sc.kind === "stars" || /night/.test(r)) for (let i = 0; i < (w * h) / 180; i++) put(p, rng.int(0, w - 1), rng.int(0, Math.floor(h * 0.8)), [255, 255, 255, rng.int(120, 255)]);
    else if (sc.kind !== "cave" && sc.kind !== "coral") {
      // Soft clouds that wrap.
      for (let i = 0; i < 5; i++) {
        const cx = rng.int(0, w - 1), cy = rng.int(10, Math.floor(h * 0.45)), rx = rng.int(14, 34), ry = rng.int(4, 8);
        for (let y = -ry; y <= ry; y++)
          for (let x = -rx; x <= rx; x++)
            if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) put(p, (((cx + x) % w) + w) % w, cy + y, [255, 255, 255, 150]);
      }
      const sun = sc.kind === "peaks" && /lava/.test(r) ? "#ff9a3c" : "#fff4c0";
      const sx = rng.int(20, w - 20), sy = rng.int(14, 30);
      for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) if (x * x + y * y <= 81) put(p, sx + x, sy + y, hex(sun));
    }
    return p;
  }
  const base = layer === "mid" ? hex(sc.far) : hex(sc.near);
  const horizon = layer === "mid" ? h * 0.55 : h * 0.72;
  const prof = profile(w, rng, 4, layer === "mid" ? h * 0.12 : h * 0.06);
  for (let x = 0; x < w; x++) {
    const top = Math.round(horizon + prof(x));
    for (let y = Math.max(0, top); y < h; y++) put(p, x, y, c(shade(base, ((y - top) / h) * -0.3)));
  }
  // Silhouette details on the near layer.
  if (layer === "near") {
    const count = Math.round(w / 22);
    for (let i = 0; i < count; i++) {
      const x0 = Math.round((i / count) * w + rng.int(-4, 4));
      const baseY = Math.round(horizon + prof(((x0 % w) + w) % w));
      const put2 = (x: number, y: number, col: RGBA) => put(p, ((x % w) + w) % w, y, c(col));
      if (sc.kind === "trees") {
        const th = rng.int(18, 40), tw = rng.int(8, 14);
        for (let y = 0; y < th; y++) for (let x = -Math.round(tw * (1 - y / th)); x <= Math.round(tw * (1 - y / th)); x++) put2(x0 + x, baseY - y, shade(base, 0.05));
        for (let y = 0; y < 5; y++) put2(x0, baseY + y, shade(base, -0.2));
      } else if (sc.kind === "city") {
        const bh = rng.int(20, 60), bw = rng.int(10, 18);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) put2(x0 + x, baseY - y, (y % 6 === 3 && x % 4 === 1 && rng.chance(0.5)) ? [255, 220, 120, 255] : base);
      } else if (sc.kind === "coral") {
        for (let k = 0; k < 3; k++) {
          const hh = rng.int(8, 22);
          for (let y = 0; y < hh; y++) put2(x0 + k * 3 + Math.round(Math.sin(y / 3) * 2), baseY - y, hex("#f07a5a"));
        }
      } else if (sc.kind === "candy") {
        const hh = rng.int(14, 30);
        for (let y = 0; y < hh; y++) put2(x0, baseY - y, [255, 255, 255, 255]);
        for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) if (x * x + y * y <= 25) put2(x0 + x, baseY - hh + y, hex("#f278b8"));
      } else if (sc.kind === "cave") {
        const hh = rng.int(10, 30);
        for (let y = 0; y < hh; y++) for (let x = -Math.round(4 * (1 - y / hh)); x <= Math.round(4 * (1 - y / hh)); x++) put2(x0 + x, y, shade(base, 0.1));
      }
    }
  }
  return p;
}
