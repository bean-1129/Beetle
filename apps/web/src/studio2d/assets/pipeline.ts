// The asset pipeline: turn every AssetRef in a Game Spec into pixels. Procedural art is the
// instant default (and the fallback); generated art, when present, is cut out, downscaled,
// snapped to the palette and checked before it replaces its procedural twin.
import type { AssetRef, GameSpec } from "../spec/types.ts";
import { makeCharacter, makeItem, archetypeOf, frameSize, type SpriteSet, type Style } from "./sprites.ts";
import { makeTileset, checkTileset, type Tileset } from "./tiles.ts";
import { makeBackground } from "./backgrounds.ts";
import { checkSprite } from "./checks.ts";
import { downscale, snapToPalette, rampPalette, pixels, get, put, type Pixels } from "./pixels.ts";
import { bakeRig, type Part, type Rig } from "./rig.ts";

export type AssetReport = { id: string; kind: string; source: string; ms: number; ok: boolean; problems: string[] };
export type BuiltAssets = {
  tile: number;
  sprites: Record<string, SpriteSet>;
  tilesets: Record<string, Tileset>;
  backgrounds: Record<string, Pixels>;
  report: AssetReport[];
  ms: number;
};
export type Decoder = (dataUrl: string) => Promise<Pixels>;

const CHARACTER_KINDS = new Set(["player", "enemy", "npc"]);

function usage(spec: GameSpec, id: string) {
  const defs = [spec.player, ...spec.entities].filter((e) => e.sprite === id);
  let w = 0.8, h = 0.8;
  let character = false;
  for (const d of defs) {
    w = Math.max(w, d.size[0]);
    h = Math.max(h, d.size[1]);
    if (CHARACTER_KINDS.has(d.kind || "")) character = true;
  }
  return { size: [defs.length ? w : 1, defs.length ? h : 1] as [number, number], character, used: defs.length > 0 };
}

export function viewPixels(tile: number): [number, number] {
  return [30 * tile, 17 * tile];
}

export function buildAsset(spec: GameSpec, id: string, ref: AssetRef, tile: number, out: BuiltAssets) {
  const t0 = performance.now();
  const style = spec.meta.artStyle as Style;
  const palette = spec.meta.palette;
  let problems: string[] = [];
  if (ref.kind === "tileset") {
    const side = spec.meta.genre === "platformer" || spec.meta.genre === "runner" || spec.meta.genre === "builder";
    const ts = makeTileset(ref.recipe, tile, style, palette, ref.seed, side);
    out.tilesets[id] = ts;
    problems = checkTileset(ts).failures;
  } else if (ref.kind === "background") {
    const [vw, vh] = viewPixels(tile);
    // Wider than the view, so the sun and clouds never repeat on screen.
    out.backgrounds[id] = makeBackground(ref.recipe, Math.round(vw * (/sky|far/.test(ref.recipe) ? 2 : 1.2)), vh, style, palette, ref.seed);
  } else if (ref.kind === "sprite" || ref.kind === "ui") {
    const u = usage(spec, id);
    const arch = archetypeOf(ref.recipe, "none");
    const character = ref.rig || u.character || arch !== "none";
    const set = character && arch !== "none" ? makeCharacter(ref.recipe, u.size, tile, style, palette, ref.seed) : character ? makeCharacter(`${ref.recipe} blob`, u.size, tile, style, palette, ref.seed) : makeItem(ref.recipe, u.size, tile, style, palette, ref.seed);
    out.sprites[id] = set;
    const first = set.frames.idle?.[0];
    // Solid props (platforms, crates, doors) fill their whole frame by design.
    const solidProp = !character && /platform|crate|box|door|gate|block|brick|plank|board|spring/.test(ref.recipe);
    if (first)
      problems = checkSprite(first, { minCoverage: /wind|fan/.test(ref.recipe) ? 0.01 : 0.06 }).problems.filter(
        (p) => !(/scattered/.test(p) && /wind|spike|star/.test(ref.recipe)) && !(solidProp && /transparent|cut out/.test(p)),
      );
  }
  out.report.push({ id, kind: ref.kind, source: ref.source === "generated" ? "generated" : "procedural", ms: performance.now() - t0, ok: problems.length === 0, problems });
}

export function buildAssets(spec: GameSpec, tile = 16): BuiltAssets {
  const t0 = performance.now();
  const out: BuiltAssets = { tile, sprites: {}, tilesets: {}, backgrounds: {}, report: [], ms: 0 };
  for (const [id, ref] of Object.entries(spec.assets)) buildAsset(spec, id, ref, tile, out);
  out.ms = performance.now() - t0;
  return out;
}

// ---------- generated art ----------

// Make generated art fit the game: fit into the frame, snap pixel styles to the palette, and
// check it. Returns null when the art fails its checks (the procedural twin stays).
export function processGenerated(img: Pixels, spec: GameSpec, id: string, tile: number): { set: SpriteSet; problems: string[] } | { set: null; problems: string[] } {
  const u = usage(spec, id);
  const [W, H] = frameSize(u.size, tile);
  const bounds = opaqueBounds(img);
  if (!bounds) return { set: null, problems: ["image is empty after cutout"] };
  const crop = cropTo(img, bounds);
  const scale = Math.min(W / crop.w, H / crop.h);
  const w = Math.max(1, Math.round(crop.w * scale)), h = Math.max(1, Math.round(crop.h * scale));
  let small = downscale(crop, w, h);
  if (spec.meta.artStyle === "pixel") small = snapToPalette(small, rampPalette(spec.meta.palette));
  const frame = pixels(W, H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = get(small, x, y);
    if (c[3]) put(frame, Math.floor((W - w) / 2) + x, H - h + y, c);
  }
  const check = checkSprite(frame);
  if (!check.ok) return { set: null, problems: check.problems };
  // Characters get a cutout rig from horizontal bands: head, body, and two legs.
  if (u.character) {
    const rig = rigFromImage(frame);
    return { set: { w: W, h: H, frames: bakeRig(rig), rig, archetype: "biped" }, problems: [] };
  }
  return { set: { w: W, h: H, frames: { idle: [frame] }, archetype: "item" }, problems: [] };
}

function opaqueBounds(p: Pixels) {
  let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.data[(y * p.w + x) * 4 + 3] > 127) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
function cropTo(p: Pixels, b: { x0: number; y0: number; x1: number; y1: number }) {
  const out = pixels(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
    const c = get(p, b.x0 + x, b.y0 + y);
    if (c[3]) put(out, x, y, c);
  }
  return out;
}

// Split one character image into parts for cutout animation.
export function rigFromImage(frame: Pixels): Rig {
  const W = frame.w, H = frame.h;
  const b = opaqueBounds(frame)!;
  const hgt = b.y1 - b.y0 + 1;
  const headEnd = b.y0 + Math.round(hgt * 0.42), bodyEnd = b.y0 + Math.round(hgt * 0.78);
  const cut = (x0: number, y0: number, x1: number, y1: number) => {
    const p = pixels(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const c = get(frame, x, y);
      if (c[3]) put(p, x - x0, y - y0, c);
    }
    return p;
  };
  const mid = Math.round((b.x0 + b.x1 + 1) / 2);
  const parts: Part[] = [
    { name: "legFar", img: cut(b.x0, bodyEnd, mid, b.y1 + 1), pivot: [(mid - b.x0) / 2, 0], at: [(b.x0 + mid) / 2, bodyEnd], z: 0 },
    { name: "body", img: cut(b.x0, headEnd, b.x1 + 1, bodyEnd), pivot: [(b.x1 + 1 - b.x0) / 2, bodyEnd - headEnd], at: [(b.x0 + b.x1 + 1) / 2, bodyEnd], z: 1 },
    { name: "legNear", img: cut(mid, bodyEnd, b.x1 + 1, b.y1 + 1), pivot: [(b.x1 + 1 - mid) / 2, 0], at: [(mid + b.x1 + 1) / 2, bodyEnd], z: 2 },
    { name: "head", img: cut(b.x0, b.y0, b.x1 + 1, headEnd), pivot: [(b.x1 + 1 - b.x0) / 2, headEnd - b.y0], at: [(b.x0 + b.x1 + 1) / 2, headEnd], z: 3 },
  ];
  return { w: W, h: H, parts, archetype: "biped" };
}

// Prompts for the image worker: the asset recipe plus a locked style line, so every asset
// in a game reads as one set.
export function assetPrompt(spec: GameSpec, ref: AssetRef): string {
  const style = spec.meta.artStyle === "pixel" ? "clean 2D pixel art sprite, crisp edges, limited palette" : spec.meta.artStyle === "flat" ? "flat vector game art, bold shapes" : "hand-painted 2D game art";
  const subject = ref.kind === "background" ? `${ref.recipe}, wide side-scrolling game background layer, no characters` : ref.kind === "tileset" ? `${ref.recipe} ground texture, seamless, top-down lit` : `a single ${ref.recipe}, full body, side view facing right, centered`;
  const bg = ref.kind === "sprite" ? ", plain flat white background, no shadow" : "";
  return `${subject}. ${style}. Colors: ${spec.meta.palette.slice(0, 6).join(", ")}. Game: ${spec.meta.title}${bg}`;
}

// Cutouts for generated art. With an Apple Vision subject mask, its brightness becomes the
// alpha; without one, the plain background the prompt asked for is flood-filled away from
// the corners.
export function applyMask(img: Pixels, mask: Pixels): Pixels {
  const out = pixels(img.w, img.h);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const mx = Math.min(mask.w - 1, Math.floor((x * mask.w) / img.w)), my = Math.min(mask.h - 1, Math.floor((y * mask.h) / img.h));
      const m = mask.data[(my * mask.w + mx) * 4];
      const i = (y * img.w + x) * 4;
      out.data[i] = img.data[i];
      out.data[i + 1] = img.data[i + 1];
      out.data[i + 2] = img.data[i + 2];
      out.data[i + 3] = m > 127 ? 255 : 0;
    }
  return out;
}

export function cutoutPlainBackground(img: Pixels, tolerance = 38): Pixels {
  const out = pixels(img.w, img.h);
  out.data.set(img.data);
  const corner = [0, 0, 0];
  for (const [x, y] of [[0, 0], [img.w - 1, 0], [0, img.h - 1], [img.w - 1, img.h - 1]]) {
    const c = get(img, x, y);
    for (let k = 0; k < 3; k++) corner[k] += c[k] / 4;
  }
  const near = (i: number) => Math.abs(img.data[i] - corner[0]) + Math.abs(img.data[i + 1] - corner[1]) + Math.abs(img.data[i + 2] - corner[2]) < tolerance * 3;
  const seen = new Uint8Array(img.w * img.h);
  const stack: number[] = [];
  for (let x = 0; x < img.w; x++) stack.push(x, (img.h - 1) * img.w + x);
  for (let y = 0; y < img.h; y++) stack.push(y * img.w, y * img.w + img.w - 1);
  while (stack.length) {
    const c = stack.pop()!;
    if (seen[c] || !near(c * 4)) continue;
    seen[c] = 1;
    out.data[c * 4 + 3] = 0;
    const x = c % img.w, y = (c / img.w) | 0;
    if (x > 0) stack.push(c - 1);
    if (x < img.w - 1) stack.push(c + 1);
    if (y > 0) stack.push(c - img.w);
    if (y < img.h - 1) stack.push(c + img.w);
  }
  return out;
}
