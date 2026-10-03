// PBR materials and runtime-generated textures for the world geometry (islands, bridges, decorations, relics,
// gates, players). Cached per scene and disposed with it. The environment owner calls
// setGeometryTheme('serene' | 'volcanic', t) during theme blends; every material registered here lerps between
// its serene and volcanic look, and builders can register extra per-theme callbacks (tree canopies, embers...).
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { mulberry32 } from './terrain.ts';

import { type ThemeName, type BiomeName, lavaOf, biomeOf } from './palette.ts';

/** Accepted theme names: the renderer themes plus the plain biome names ('garden' is 'serene'). */
export type GeometryTheme = ThemeName | 'garden';
/** Blended biome weights (volcanic counts as garden with a lava overlay); they sum to 1. */
export type BiomeWeights = { garden: number; frost: number; desert: number; night: number };
type LookKey = 'serene' | 'volcanic' | 'frost' | 'desert' | 'night';

function normalizeTheme(t: string): ThemeName {
  if (t === 'garden') return 'serene';
  const known: readonly string[] = ['serene', 'volcanic', 'frost', 'desert', 'night', 'frost_lava', 'desert_lava', 'night_lava'];
  return (known.includes(t) ? t : 'serene') as ThemeName;
}
function weightsOf(theme: ThemeName): BiomeWeights {
  const b: BiomeName = biomeOf(theme);
  return { garden: b === 'garden' || b === 'volcanic' ? 1 : 0, frost: b === 'frost' ? 1 : 0, desert: b === 'desert' ? 1 : 0, night: b === 'night' ? 1 : 0 };
}
const smooth = (t: number) => t * t * (3 - 2 * t);

let currentTheme: ThemeName = 'serene';
let fromTheme: ThemeName = 'serene';
let currentBlend = 1; // fully at the current theme
let fromLava = 0;
let fromWeights: BiomeWeights = weightsOf('serene');
const liveWeights: BiomeWeights = weightsOf('serene');

/** 0 = no lava overlay, 1 = full lava overlay (the historical "volcanic amount"). */
export function volcanicAmount(): number {
  return fromLava + (lavaOf(currentTheme) - fromLava) * smooth(currentBlend);
}
/** Live biome weights at the current blend. */
export function biomeWeights(): BiomeWeights { return liveWeights; }

/** Blend the geometry materials toward a theme; t runs 0..1 (progress toward `theme`). Accepts biome names. */
export function setGeometryTheme(theme: GeometryTheme | string, t: number): void {
  const name = normalizeTheme(theme);
  if (name !== currentTheme) {
    // snapshot the live state so a mid-blend switch continues from where it is
    fromLava = volcanicAmount();
    fromWeights = { ...liveWeights };
    fromTheme = currentTheme;
    currentTheme = name;
    for (const g of live) g.snapshot();
  }
  currentBlend = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 1));
  const e = smooth(currentBlend);
  const tw = weightsOf(currentTheme);
  liveWeights.garden = fromWeights.garden + (tw.garden - fromWeights.garden) * e;
  liveWeights.frost = fromWeights.frost + (tw.frost - fromWeights.frost) * e;
  liveWeights.desert = fromWeights.desert + (tw.desert - fromWeights.desert) * e;
  liveWeights.night = fromWeights.night + (tw.night - fromWeights.night) * e;
  for (const g of live) g.applyTheme(e);
}

export function getGeometryTheme(): { theme: ThemeName; t: number; from: ThemeName; lava: number; weights: BiomeWeights } {
  return { theme: currentTheme, t: currentBlend, from: fromTheme, lava: volcanicAmount(), weights: { ...liveWeights } };
}

// debug hook for the play page console: window.__beetleGeometry.setGeometryTheme('frost', 1)
if (typeof window !== 'undefined') (window as unknown as { __beetleGeometry?: unknown }).__beetleGeometry = { setGeometryTheme, getGeometryTheme };

// ---------------------------------------------------------------- textures (all generated at runtime, tileable)

type Rgba = (x: number, y: number) => [number, number, number, number];

function makeTexture(scene: Scene, name: string, size: number, fn: Rgba, opts: { alpha?: boolean; wrap?: boolean } = {}): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
      img.data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      img.data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      img.data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.hasAlpha = !!opts.alpha;
  if (opts.wrap !== false) { tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE; }
  else { tex.wrapU = Texture.CLAMP_ADDRESSMODE; tex.wrapV = Texture.CLAMP_ADDRESSMODE; }
  return tex;
}

/** Tileable lattice value noise in [0,1] over the unit square. */
function tileNoise(cells: number, seed: number): (u: number, v: number) => number {
  const rng = mulberry32(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return (u, v) => {
    const fx = ((u % 1) + 1) % 1 * cells; const fy = ((v % 1) + 1) % 1 * cells;
    const x0 = Math.floor(fx) % cells; const y0 = Math.floor(fy) % cells;
    const x1 = (x0 + 1) % cells; const y1 = (y0 + 1) % cells;
    const sx = fx - Math.floor(fx); const sy = fy - Math.floor(fy);
    const ux = sx * sx * (3 - 2 * sx); const uy = sy * sy * (3 - 2 * sy);
    const a0 = g[y0 * cells + x0] + (g[y0 * cells + x1] - g[y0 * cells + x0]) * ux;
    const a1 = g[y1 * cells + x0] + (g[y1 * cells + x1] - g[y1 * cells + x0]) * ux;
    return a0 + (a1 - a0) * uy;
  };
}

function fbmTile(seed: number, base = 4): (u: number, v: number) => number {
  const n1 = tileNoise(base, seed); const n2 = tileNoise(base * 2, seed + 1); const n3 = tileNoise(base * 4, seed + 2); const n4 = tileNoise(base * 8, seed + 3);
  return (u, v) => 0.5 * n1(u, v) + 0.25 * n2(u, v) + 0.15 * n3(u, v) + 0.1 * n4(u, v);
}

/** Normal map from a tileable height function (tangent-space, +Z up, Babylon convention). */
function makeNormalMap(scene: Scene, name: string, size: number, height: (u: number, v: number) => number, strength: number): DynamicTexture {
  const d = 1 / size;
  return makeTexture(scene, name, size, (u, v) => {
    const hx = (height(u + d, v) - height(u - d, v)) * strength * size * 0.5;
    const hy = (height(u, v + d) - height(u, v - d)) * strength * size * 0.5;
    const len = Math.hypot(hx, hy, 1);
    return [(-hx / len) * 0.5 + 0.5, (-hy / len) * 0.5 + 0.5, (1 / len) * 0.5 + 0.5, 1];
  });
}

/**
 * DynamicTexture.clone() creates an empty texture that is never marked ready (nothing ever calls update on it),
 * which would leave every material using it unready. Copy the pixels into the clone and update it instead.
 */
function cloneDyn(src: Texture): Texture {
  if (!(src instanceof DynamicTexture)) return src.clone() as Texture;
  const size = src.getSize();
  const out = new DynamicTexture(`${src.name}:copy`, { width: size.width, height: size.height }, src.getScene(), true);
  const srcCanvas = (src.getContext() as CanvasRenderingContext2D).canvas;
  (out.getContext() as CanvasRenderingContext2D).drawImage(srcCanvas as HTMLCanvasElement, 0, 0);
  out.update(false);
  out.hasAlpha = src.hasAlpha;
  out.wrapU = src.wrapU; out.wrapV = src.wrapV;
  return out;
}

function makeTextures(scene: Scene) {
  const stoneH = fbmTile(11, 5);
  const stoneHeight = (u: number, v: number) => {
    const n = stoneH(u, v);
    return n + 0.08 * Math.abs(Math.sin(v * Math.PI * 6 + n * 2)); // faint bedding
  };
  const stoneNormal = makeNormalMap(scene, 'geo:stoneNormal', 128, stoneHeight, 0.06);
  const soilNormal = makeNormalMap(scene, 'geo:soilNormal', 128, fbmTile(23, 6), 0.035);
  const barkH = fbmTile(37, 3);
  const barkHeight = (u: number, v: number) => 0.6 * barkH(u * 4, v) + 0.4 * Math.abs(Math.sin(u * Math.PI * 14 + 2 * barkH(u, v)));
  const barkNormal = makeNormalMap(scene, 'geo:barkNormal', 128, barkHeight, 0.07);
  const woodN = fbmTile(41, 2);
  const woodAlbedo = makeTexture(scene, 'geo:woodAlbedo', 128, (u, v) => {
    const grain = 0.5 + 0.5 * Math.sin((v * 9 + woodN(u, v) * 3) * Math.PI * 2);
    const s = 0.82 + 0.18 * grain - 0.1 * woodN(u * 3, v);
    return [s, s * 0.98, s * 0.95, 1];
  });
  const stoneAlbedo = makeTexture(scene, 'geo:stoneAlbedo', 128, (u, v) => {
    const n = stoneH(u, v);
    const s = 0.84 + 0.22 * n;
    return [s, s, s, 1];
  });
  // ember cracks: bright thin ridges on black (emissive for scorched earth, charred bridge wood, gate braziers)
  const crackN = fbmTile(53, 4);
  const cracks = makeTexture(scene, 'geo:cracks', 256, (u, v) => {
    const n = crackN(u, v);
    const ridge = Math.max(0, 1 - Math.abs(n - 0.5) * 26);
    const g = ridge * ridge * (0.6 + 0.4 * crackN(v * 2, u * 2));
    return [g, g * 0.42, g * 0.08, 1];
  });
  // rope twist: diagonal fibre bands
  const ropeAlbedo = makeTexture(scene, 'geo:rope', 64, (u, v) => {
    const band = 0.5 + 0.5 * Math.sin((u * 2 + v * 6) * Math.PI * 2);
    const s = 0.72 + 0.28 * band;
    return [s, s * 0.95, s * 0.86, 1];
  });
  // grass tuft card: a few tapered blades from the bottom centre (alpha tested)
  const tuftRng = mulberry32(77);
  const blades: { x0: number; lean: number; h: number; w: number; tone: number }[] = [];
  for (let i = 0; i < 9; i++) blades.push({ x0: 0.3 + 0.4 * tuftRng(), lean: (tuftRng() - 0.5) * 0.9, h: 0.55 + 0.45 * tuftRng(), w: 0.02 + 0.025 * tuftRng(), tone: 0.7 + 0.5 * tuftRng() });
  const tuftCard = makeTexture(scene, 'geo:tuft', 128, (u, v) => {
    const y = 1 - v; // 0 at the bottom
    let a = 0; let tone = 1;
    for (const b of blades) {
      if (y > b.h) continue;
      const t = y / b.h;
      const cx = b.x0 + b.lean * t * t;
      const w = b.w * (1 - t * 0.85) + 0.004;
      if (Math.abs(u - cx) < w) { a = 1; tone = b.tone * (0.75 + 0.5 * t); }
    }
    return [0.55 * tone, 0.85 * tone, 0.4 * tone, a];
  }, { alpha: true, wrap: false });
  // leaf cluster card: overlapping leaf ellipses (alpha tested), two-tone
  const leafRng = mulberry32(91);
  const leaves: { x: number; y: number; r: number; rot: number; tone: number }[] = [];
  for (let i = 0; i < 26; i++) leaves.push({ x: 0.2 + 0.6 * leafRng(), y: 0.2 + 0.6 * leafRng(), r: 0.07 + 0.09 * leafRng(), rot: leafRng() * Math.PI, tone: 0.65 + 0.6 * leafRng() });
  const leafCard = makeTexture(scene, 'geo:leaf', 128, (u, v) => {
    let a = 0; let tone = 1;
    for (const l of leaves) {
      const dx = u - l.x; const dy = v - l.y;
      const c = Math.cos(l.rot); const s = Math.sin(l.rot);
      const lx = dx * c - dy * s; const ly = dx * s + dy * c;
      if ((lx * lx) / (l.r * l.r) + (ly * ly) / (l.r * l.r * 0.3) < 1) { a = 1; tone = l.tone * (0.85 + 0.3 * (ly / l.r + 0.5)); }
    }
    return [0.3 * tone, 0.62 * tone, 0.28 * tone, a];
  }, { alpha: true, wrap: false });
  // rune column: pale stone with carved dark grooves (albedo) and the same grooves as a glow mask (emissive)
  const runeRng = mulberry32(131);
  const strokes: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const y = 0.08 + (i / 14) * 0.84;
    const vertical = runeRng() < 0.4;
    strokes.push(vertical ? { x: 0.3 + 0.4 * runeRng(), y, w: 0.06, h: 0.05 + 0.04 * runeRng() } : { x: 0.25 + 0.2 * runeRng(), y, w: 0.3 + 0.25 * runeRng(), h: 0.025 });
  }
  const inStroke = (u: number, v: number) => strokes.some((s) => u >= s.x && u <= s.x + s.w && v >= s.y && v <= s.y + s.h);
  const runeAlbedo = makeTexture(scene, 'geo:runeAlbedo', 128, (u, v) => {
    const n = stoneH(u, v);
    const s = (0.8 + 0.2 * n) * (inStroke(u, v) ? 0.45 : 1);
    return [s, s, s, 1];
  }, { wrap: false });
  const runeGlow = makeTexture(scene, 'geo:runeGlow', 128, (u, v) => {
    const g = inStroke(u, v) ? 1 : 0;
    return [g, g * 0.8, g * 0.5, 1];
  }, { wrap: false });
  // particle sprites
  const sparkle = makeTexture(scene, 'geo:sparkle', 64, (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const core = Math.max(0, 1 - d * d);
    const star = Math.max(0, 1 - Math.min(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 14) * Math.max(0, 1 - d);
    const a = Math.min(1, core * core + star * 0.8);
    return [1, 1, 1, a];
  }, { alpha: true, wrap: false });
  const flame = makeTexture(scene, 'geo:flame', 64, (u, v) => {
    const d = Math.hypot((u - 0.5) * 1.3, v - 0.5) * 2;
    const a = Math.max(0, 1 - d * d);
    return [1, 0.85, 0.6, a * a];
  }, { alpha: true, wrap: false });
  const pool = makeTexture(scene, 'geo:pool', 64, (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const a = Math.max(0, 1 - d);
    return [1, 1, 1, a * a];
  }, { alpha: true, wrap: false });
  // mushroom cap: cream spots on a plain base (the base colour comes from the material albedo)
  const spotRng = mulberry32(173);
  const spots: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 14; i++) spots.push({ x: spotRng(), y: spotRng(), r: 0.04 + 0.05 * spotRng() });
  const capSpots = makeTexture(scene, 'geo:capSpots', 128, (u, v) => {
    let s = 0.55 + 0.1 * stoneH(u * 2, v * 2);
    for (const sp of spots) {
      const dx = Math.min(Math.abs(u - sp.x), 1 - Math.abs(u - sp.x)); const dy = Math.min(Math.abs(v - sp.y), 1 - Math.abs(v - sp.y));
      if (dx * dx + dy * dy < sp.r * sp.r) s = 1.6;
    }
    return [s, s, s, 1];
  });
  // tower window / arrow slit glow mask (tiles vertically around the drum)
  const slits = makeTexture(scene, 'geo:slits', 64, (u, v) => {
    const g = Math.abs(u - 0.5) < 0.06 && v > 0.3 && v < 0.7 ? 1 : 0;
    return [g, g * 0.85, g * 0.55, 1];
  });
  return { stoneNormal, soilNormal, barkNormal, woodAlbedo, stoneAlbedo, cracks, ropeAlbedo, tuftCard, leafCard, runeAlbedo, runeGlow, sparkle, flame, pool, capSpots, slits };
}

export type GeoTextures = ReturnType<typeof makeTextures>;

// ---------------------------------------------------------------- materials

type Look = { albedo: Color3; emissive?: Color3; emissiveIntensity?: number; roughness?: number; alpha?: number };
type FullLook = Required<Look>;
type Themed = { mat: PBRMaterial; looks: Record<LookKey, FullLook>; from: FullLook; target: FullLook; serene: FullLook; volcanic: FullLook };

function fill(l: Look, base: PBRMaterial): FullLook {
  // colours are cloned: the material's live albedo/emissive are written every blend frame and must never alias a look
  return {
    albedo: l.albedo.clone(),
    emissive: (l.emissive ?? Color3.Black()).clone(),
    emissiveIntensity: l.emissiveIntensity ?? base.emissiveIntensity,
    roughness: l.roughness ?? (base.roughness ?? 1),
    alpha: l.alpha ?? base.alpha,
  };
}
function cloneLook(l: FullLook): FullLook {
  return { albedo: l.albedo.clone(), emissive: l.emissive.clone(), emissiveIntensity: l.emissiveIntensity, roughness: l.roughness, alpha: l.alpha };
}
function lerpLook(out: FullLook, a: FullLook, b: FullLook, t: number) {
  Color3.LerpToRef(a.albedo, b.albedo, t, out.albedo);
  Color3.LerpToRef(a.emissive, b.emissive, t, out.emissive);
  out.emissiveIntensity = a.emissiveIntensity + (b.emissiveIntensity - a.emissiveIntensity) * t;
  out.roughness = a.roughness + (b.roughness - a.roughness) * t;
  out.alpha = a.alpha + (b.alpha - a.alpha) * t;
}
function desaturate(c: Color3, k: number): Color3 {
  const l = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
  return new Color3(c.r + (l - c.r) * k, c.g + (l - c.g) * k, c.b + (l - c.b) * k);
}
const isBlack = (c: Color3) => c.r + c.g + c.b < 0.002;
/** Derived biome looks for materials without an explicit one: frost cools and whitens, desert warms, night darkens. */
function deriveLook(base: FullLook, key: LookKey): FullLook {
  const out = cloneLook(base);
  if (key === 'frost') {
    out.albedo = Color3.Lerp(desaturate(base.albedo, 0.45), Color3.FromHexString('#dfe8f0'), 0.3);
    out.roughness = Math.min(1, base.roughness + 0.05);
  } else if (key === 'desert') {
    out.albedo = Color3.Lerp(base.albedo, Color3.FromHexString('#d8b070'), 0.28);
  } else if (key === 'night') {
    out.albedo = Color3.Lerp(desaturate(base.albedo, 0.3).scale(0.78), Color3.FromHexString('#6a7a9a'), 0.18);
    if (!isBlack(base.emissive)) out.emissiveIntensity = base.emissiveIntensity * 1.6;
  }
  return out;
}

export type GeoMaterials = ReturnType<typeof createGeoMaterials>;

const cache = new WeakMap<Scene, GeoMaterials>();
const live = new Set<GeoMaterials>();

/** Materials for a scene, created on first use and disposed with the scene. */
export function geoMaterials(scene: Scene): GeoMaterials {
  let g = cache.get(scene);
  if (!g) {
    g = createGeoMaterials(scene);
    cache.set(scene, g);
    live.add(g);
    const ref = g;
    scene.onDisposeObservable.addOnce(() => { live.delete(ref); cache.delete(scene); });
    g.applyTheme(smooth(currentBlend));
  }
  return g;
}

function createGeoMaterials(scene: Scene) {
  const tex = makeTextures(scene);
  const themed: Themed[] = [];
  const callbacks = new Set<(v: number, w: BiomeWeights) => void>();

  type Opts = {
    metallic?: number; roughness?: number; bump?: Texture; bumpScale?: number; albedoTex?: Texture; albedoScale?: number;
    emissiveTex?: Texture; emissiveScale?: number; alpha?: number; unlit?: boolean; twoSided?: boolean; alphaTest?: boolean;
    volcanic?: Look; frost?: Look; desert?: Look; night?: Look; sheen?: Color3; clearCoat?: boolean;
  };
  const tmpLook: FullLook = { albedo: new Color3(), emissive: new Color3(), emissiveIntensity: 1, roughness: 1, alpha: 1 };
  /** Target look for a theme: the biome look, with the lava look blended in for a lava hazard. */
  function lookFor(t: Themed, theme: ThemeName): FullLook {
    const biome = biomeOf(theme);
    const key: LookKey = biome === 'garden' ? 'serene' : biome;
    const base = t.looks[key];
    if (lavaOf(theme) > 0 && key !== 'volcanic') {
      const out = cloneLook(base);
      lerpLook(out, base, t.looks.volcanic, 0.55);
      return out;
    }
    return base;
  }
  function retarget(t: Themed) {
    t.target = lookFor(t, currentTheme);
  }
  function pbr(name: string, albedo: Color3, o: Opts = {}): PBRMaterial {
    const m = new PBRMaterial(`geo:${name}`, scene);
    m.albedoColor = albedo.clone();
    m.metallic = o.metallic ?? 0;
    m.roughness = o.roughness ?? 0.85;
    m.enableSpecularAntiAliasing = true;
    m.emissiveColor = Color3.Black();
    m.emissiveIntensity = 1;
    if (o.bump) {
      m.bumpTexture = cloneDyn(o.bump);
      (m.bumpTexture as Texture).uScale = o.bumpScale ?? 1;
      (m.bumpTexture as Texture).vScale = o.bumpScale ?? 1;
    }
    if (o.albedoTex) {
      m.albedoTexture = cloneDyn(o.albedoTex);
      (m.albedoTexture as Texture).uScale = o.albedoScale ?? 1;
      (m.albedoTexture as Texture).vScale = o.albedoScale ?? 1;
    }
    if (o.emissiveTex) {
      m.emissiveTexture = cloneDyn(o.emissiveTex);
      (m.emissiveTexture as Texture).uScale = o.emissiveScale ?? 1;
      (m.emissiveTexture as Texture).vScale = o.emissiveScale ?? 1;
    }
    if (o.alphaTest && o.albedoTex) {
      (m.albedoTexture as Texture).hasAlpha = true;
      m.useAlphaFromAlbedoTexture = true;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
      m.alphaCutOff = 0.45;
    }
    if (o.alpha !== undefined) {
      m.alpha = o.alpha;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }
    if (o.unlit) m.unlit = true;
    if (o.twoSided) { m.backFaceCulling = false; m.twoSidedLighting = true; }
    if (o.sheen) { m.sheen.isEnabled = true; m.sheen.color = o.sheen; m.sheen.intensity = 0.5; m.sheen.roughness = 0.6; }
    if (o.clearCoat) { m.clearCoat.isEnabled = true; m.clearCoat.intensity = 0.6; m.clearCoat.roughness = 0.1; }
    const serene = fill({ albedo, roughness: m.roughness ?? 0.85, alpha: m.alpha }, m);
    const volcanic = fill(o.volcanic ?? serene, m);
    const looks: Record<LookKey, FullLook> = {
      serene, volcanic,
      frost: o.frost ? fill({ ...o.frost, alpha: o.frost.alpha ?? serene.alpha, roughness: o.frost.roughness ?? serene.roughness }, m) : deriveLook(serene, 'frost'),
      desert: o.desert ? fill({ ...o.desert, alpha: o.desert.alpha ?? serene.alpha, roughness: o.desert.roughness ?? serene.roughness }, m) : deriveLook(serene, 'desert'),
      night: o.night ? fill({ ...o.night, alpha: o.night.alpha ?? serene.alpha, roughness: o.night.roughness ?? serene.roughness }, m) : deriveLook(serene, 'night'),
    };
    const t: Themed = { mat: m, looks, from: cloneLook(serene), target: serene, serene, volcanic };
    t.from = cloneLook(lookFor(t, fromTheme));
    retarget(t);
    themed.push(t);
    applyOne(t, smooth(currentBlend));
    return m;
  }
  /** Re-derive the biome looks after a builder patched the serene/volcanic emissive (relics, lanterns, players). */
  function rederive(m: PBRMaterial, night?: Partial<FullLook>) {
    const t = themed.find((x) => x.mat === m);
    if (!t) return;
    t.looks.frost = deriveLook(t.serene, 'frost');
    t.looks.desert = deriveLook(t.serene, 'desert');
    t.looks.night = { ...deriveLook(t.serene, 'night'), ...night };
    t.from = cloneLook(lookFor(t, fromTheme));
    retarget(t);
    applyOne(t, smooth(currentBlend));
  }

  const c = (hex: string) => Color3.FromHexString(hex);
  const ember = c('#ff7a2a');
  const snow = c('#e9f0f4');
  const iceStone = c('#8d9aa8');
  const sand = c('#d9b981');
  const ochre = c('#b0763c');

  /** Rotate the hue of every colour in a material's option looks (bounded material variants, not per object). */
  const hueShift = (col: Color3, deg: number): Color3 => {
    const hsv = col.toHSV();
    const out = new Color3();
    Color3.HSVtoRGBToRef((hsv.r + deg + 360) % 360, hsv.g, hsv.b, out);
    return out;
  };
  const shiftLook = (l: Look | undefined, deg: number): Look | undefined => l && ({ ...l, albedo: hueShift(l.albedo, deg), emissive: l.emissive ? hueShift(l.emissive, deg) : undefined });
  const shiftOpts = (o: Opts, deg: number): Opts => ({ ...o, volcanic: shiftLook(o.volcanic, deg * 0.4), frost: shiftLook(o.frost, deg), desert: shiftLook(o.desert, deg * 0.5), night: shiftLook(o.night, deg) });
  const crystalOpts: Opts = { roughness: 0.15, metallic: 0.1, alpha: 0.9, clearCoat: true, volcanic: { albedo: c('#ff9a5a'), emissive: c('#ff6a2a'), emissiveIntensity: 1.2, alpha: 0.92 }, frost: { albedo: c('#bfe6ff'), emissive: c('#7fc4ff'), emissiveIntensity: 1.1, alpha: 0.9 }, desert: { albedo: c('#ffd27a'), emissive: c('#ffb040'), emissiveIntensity: 0.9, alpha: 0.9 }, night: { albedo: c('#c89aff'), emissive: c('#9a5cff'), emissiveIntensity: 1.8, alpha: 0.92 } };

  const mats = {
    // island
    grass: pbr('grass', c('#7fbf66'), {
      roughness: 0.9, bump: tex.soilNormal, bumpScale: 1, emissiveTex: tex.cracks, emissiveScale: 0.6,
      volcanic: { albedo: c('#3a2c22'), emissive: ember, emissiveIntensity: 1.4, roughness: 0.95 },
      frost: { albedo: snow, roughness: 0.97 },
      desert: { albedo: sand, roughness: 0.92 },
      night: { albedo: c('#3e5a4a'), roughness: 0.9 },
    }),
    stone: pbr('stone', c('#cfc5b2'), {
      roughness: 0.85, bump: tex.stoneNormal, bumpScale: 1.2, albedoTex: tex.stoneAlbedo, albedoScale: 1.2,
      volcanic: { albedo: c('#5a5048'), roughness: 0.9 },
      frost: { albedo: iceStone, roughness: 0.8 },
      desert: { albedo: ochre, roughness: 0.9 },
      night: { albedo: c('#6e7482'), roughness: 0.85 },
    }),
    stoneDark: pbr('stoneDark', c('#8c8373'), { roughness: 0.88, bump: tex.stoneNormal, bumpScale: 2, volcanic: { albedo: c('#3d3632') }, frost: { albedo: c('#62707e') }, desert: { albedo: c('#8c5f32') }, night: { albedo: c('#4a505c') } }),
    rock: pbr('rock', c('#8d918c'), { roughness: 0.8, bump: tex.stoneNormal, bumpScale: 3, volcanic: { albedo: c('#45403c') }, frost: { albedo: c('#9fb0bf'), roughness: 0.75 }, desert: { albedo: c('#a8783f') }, night: { albedo: c('#4f5665') } }),
    pebble: pbr('pebble', c('#a9a79c'), { roughness: 0.8, bump: tex.stoneNormal, bumpScale: 4, volcanic: { albedo: c('#4a4541') }, frost: { albedo: c('#c8d4dc') }, desert: { albedo: c('#c09a5e') }, night: { albedo: c('#5a6070') } }),
    tuft: pbr('tuft', c('#d8ffb0'), {
      roughness: 0.95, albedoTex: tex.tuftCard, alphaTest: true, twoSided: true,
      volcanic: { albedo: c('#4a3a2a'), emissive: ember.scale(0.35), emissiveIntensity: 1 },
      frost: { albedo: c('#c9d8d0'), emissive: c('#1a2a26'), emissiveIntensity: 1 },
      desert: { albedo: c('#d8c07a'), emissive: c('#3a3010'), emissiveIntensity: 1 },
      night: { albedo: c('#6a8a70'), emissive: c('#14241c'), emissiveIntensity: 1 },
    }),
    crust: pbr('crust', c('#4a1c0c'), { unlit: true, alpha: 0, twoSided: true, volcanic: { albedo: c('#5a200c'), emissive: c('#ffb050'), emissiveIntensity: 1.6, alpha: 0.9 } }),
    underShadow: pbr('underShadow', c('#0b1a1c'), { unlit: true, alpha: 0.38, twoSided: true }),
    // bridge
    wood: pbr('wood', c('#8a5a30'), { roughness: 0.8, albedoTex: tex.woodAlbedo, albedoScale: 1, bump: tex.barkNormal, bumpScale: 0.5, volcanic: { albedo: c('#3a2a1e'), emissive: ember.scale(0.25), emissiveIntensity: 0.8 }, frost: { albedo: c('#8a8c86'), roughness: 0.9 }, desert: { albedo: c('#a8824a'), roughness: 0.85 }, night: { albedo: c('#4a3c32') } }),
    plankA: pbr('plankA', c('#a26a35'), { roughness: 0.8, albedoTex: tex.woodAlbedo, albedoScale: 2, bump: tex.barkNormal, bumpScale: 0.6, emissiveTex: tex.cracks, emissiveScale: 1, volcanic: { albedo: c('#3b2b1f'), emissive: ember, emissiveIntensity: 0.9 }, frost: { albedo: c('#b9bfc0'), roughness: 0.92 }, desert: { albedo: c('#c09a5c') }, night: { albedo: c('#55473c') } }),
    plankC: pbr('plankC', c('#b8834a'), { roughness: 0.78, albedoTex: tex.woodAlbedo, albedoScale: 2, bump: tex.barkNormal, bumpScale: 0.6, emissiveTex: tex.cracks, emissiveScale: 1, volcanic: { albedo: c('#42301f'), emissive: ember, emissiveIntensity: 0.85 }, frost: { albedo: c('#c4c8c6'), roughness: 0.92 }, desert: { albedo: c('#cfa868') }, night: { albedo: c('#5e4f42') } }),
    plankB: pbr('plankB', c('#8c5729'), { roughness: 0.82, albedoTex: tex.woodAlbedo, albedoScale: 2, bump: tex.barkNormal, bumpScale: 0.6, emissiveTex: tex.cracks, emissiveScale: 1, volcanic: { albedo: c('#33251b'), emissive: ember, emissiveIntensity: 0.8 }, frost: { albedo: c('#a4acae'), roughness: 0.92 }, desert: { albedo: c('#aa864c') }, night: { albedo: c('#493d33') } }),
    woodLight: pbr('woodLight', c('#b57a3e'), { roughness: 0.78, albedoTex: tex.woodAlbedo, albedoScale: 1, volcanic: { albedo: c('#4a3524') }, frost: { albedo: c('#9c9e98') }, desert: { albedo: c('#c89c5a') }, night: { albedo: c('#5a4a3c') } }),
    rope: pbr('rope', c('#dcc9a3'), { roughness: 0.95, albedoTex: tex.ropeAlbedo, albedoScale: 1, volcanic: { albedo: c('#8a7458') } }),
    iron: pbr('iron', c('#3a3b3f'), { metallic: 0.85, roughness: 0.5, volcanic: { albedo: c('#2a2425') } }),
    lanternGlass: pbr('lanternGlass', c('#ffd27f'), { roughness: 0.3, volcanic: { albedo: c('#ff8a4a'), emissive: c('#ff6a30'), emissiveIntensity: 1.6 } }),
    lanternGlassB: pbr('lanternGlassB', c('#fff0b8'), { roughness: 0.3, volcanic: { albedo: c('#ffa05a'), emissive: c('#ff7a3a'), emissiveIntensity: 1.6 } }),
    lanternGlassC: pbr('lanternGlassC', c('#d0ecff'), { roughness: 0.3, volcanic: { albedo: c('#ff9a6a'), emissive: c('#ff6a40'), emissiveIntensity: 1.5 } }),
    // decorations
    trunk: pbr('trunk', c('#6b4625'), { roughness: 0.9, bump: tex.barkNormal, bumpScale: 1, albedoTex: tex.woodAlbedo, albedoScale: 1, volcanic: { albedo: c('#2b211b') }, frost: { albedo: c('#5a5450') }, desert: { albedo: c('#8a6238') }, night: { albedo: c('#3a3230') } }),
    leaves: pbr('leaves', c('#4aa255'), { roughness: 0.85, bump: tex.soilNormal, bumpScale: 2, volcanic: { albedo: c('#3a2f26'), roughness: 0.95 }, frost: { albedo: c('#b8c9cc'), roughness: 0.95 }, desert: { albedo: c('#9a9448'), roughness: 0.9 }, night: { albedo: c('#2a4a42') } }),
    leavesDark: pbr('leavesDark', c('#2f7a3c'), { roughness: 0.85, bump: tex.soilNormal, bumpScale: 2, volcanic: { albedo: c('#2a221c'), roughness: 0.95 }, frost: { albedo: c('#8fa5ad'), roughness: 0.95 }, desert: { albedo: c('#7a7238'), roughness: 0.9 }, night: { albedo: c('#1e3a32') } }),
    leafCard: pbr('leafCard', c('#ffffff'), { roughness: 0.85, albedoTex: tex.leafCard, alphaTest: true, twoSided: true, volcanic: { albedo: c('#3a2a20') }, frost: { albedo: c('#e4ecf0') }, desert: { albedo: c('#d8c070') }, night: { albedo: c('#7a8aa0') } }),
    emberTip: pbr('emberTip', c('#ff9a4a'), { unlit: true, alpha: 0, volcanic: { albedo: c('#ff9a4a'), emissive: ember, emissiveIntensity: 2, alpha: 1 } }),
    bush: pbr('bush', c('#4fae5c'), { roughness: 0.9, bump: tex.soilNormal, bumpScale: 2, volcanic: { albedo: c('#3b3028') }, frost: { albedo: c('#c4d2d6') }, desert: { albedo: c('#9c9650') }, night: { albedo: c('#2c4a44') } }),
    lanternPost: pbr('lanternPost', c('#4a3a2a'), { roughness: 0.7, metallic: 0.3, volcanic: { albedo: c('#2a2220') } }),
    halo: pbr('halo', c('#ffd98a'), { unlit: true, alpha: 0.18, twoSided: true, volcanic: { albedo: c('#ff8a4a'), alpha: 0.22 }, night: { albedo: c('#ffd98a'), alpha: 0.3 } }),
    // new decorations
    moss: pbr('moss', c('#5c8a3e'), { roughness: 0.95, bump: tex.soilNormal, bumpScale: 3, volcanic: { albedo: c('#3a3326') }, frost: { albedo: c('#cfdcdc') }, desert: { albedo: c('#9a8a4a') }, night: { albedo: c('#2e4a36') } }),
    towerStone: pbr('towerStone', c('#9a948a'), { roughness: 0.88, bump: tex.stoneNormal, bumpScale: 2, albedoTex: tex.stoneAlbedo, albedoScale: 2, volcanic: { albedo: c('#4a423c') }, frost: { albedo: c('#8494a4') }, desert: { albedo: c('#a67a44') }, night: { albedo: c('#5a6070') } }),
    towerWindow: pbr('towerWindow', c('#2a2420'), { roughness: 0.6, emissiveTex: tex.slits, volcanic: { albedo: c('#2a2420') } }),
    crystal: pbr('crystal', c('#7fe3d8'), crystalOpts),
    // hue-shifted crystal variants (the cluster picks one of three per instance)
    crystalB: pbr('crystalB', hueShift(c('#7fe3d8'), 28), shiftOpts(crystalOpts, 28)),
    crystalC: pbr('crystalC', hueShift(c('#7fe3d8'), -30), shiftOpts(crystalOpts, -30)),
    mushroomStem: pbr('mushroomStem', c('#e8dcc4'), { roughness: 0.85, volcanic: { albedo: c('#5a4a3e') }, frost: { albedo: c('#dfe4e8') }, night: { albedo: c('#b4b8c8'), emissive: c('#3a5a70'), emissiveIntensity: 0.6 } }),
    mushroomCap: pbr('mushroomCap', c('#c0442e'), { roughness: 0.6, albedoTex: tex.capSpots, albedoScale: 1, volcanic: { albedo: c('#4a2a22') }, frost: { albedo: c('#8aa0b0') }, desert: { albedo: c('#b8803a') }, night: { albedo: c('#4a5a9a'), emissive: c('#4a8ad0'), emissiveIntensity: 1.2 } }),
    statueStone: pbr('statueStone', c('#b4ada0'), { roughness: 0.75, bump: tex.stoneNormal, bumpScale: 1.5, volcanic: { albedo: c('#524a44') }, frost: { albedo: c('#a2b2c0') }, desert: { albedo: c('#c09a66') }, night: { albedo: c('#6a7080') } }),
    beam: pbr('beam', c('#ffffff'), { unlit: true, alpha: 0, twoSided: true }),
    holdRing: pbr('holdRing', c('#ffffff'), { unlit: true, alpha: 0.9, twoSided: true }),
    // relic
    relicCore: pbr('relicCore', c('#ffffff'), { unlit: true }),
    relicShell: pbr('relicShell', c('#ffffff'), { metallic: 0.2, roughness: 0.2, alpha: 0.45, clearCoat: true }),
    relicHalo: pbr('relicHalo', c('#ffd98a'), { unlit: true, alpha: 0.14, twoSided: true }),
    lightPool: pbr('lightPool', c('#ffd98a'), { unlit: true, alpha: 0.5, albedoTex: tex.pool, twoSided: true }),
    // gate
    gateStone: pbr('gateStone', c('#8d8778'), { roughness: 0.85, albedoTex: tex.runeAlbedo, bump: tex.stoneNormal, bumpScale: 1, emissiveTex: tex.runeGlow, volcanic: { albedo: c('#4d4541') } }),
    gateCone: pbr('gateCone', c('#ffd27f'), { unlit: true, alpha: 0, twoSided: true }),
    brazier: pbr('brazier', c('#3a3230'), { metallic: 0.7, roughness: 0.55 }),
    // players
    playerBase: pbr('playerBase', c('#4f4a40'), { roughness: 0.6, metallic: 0.2 }),
    leather: pbr('leather', c('#4a3324'), { roughness: 0.62, sheen: c('#6a4a34') }),
    leggings: pbr('leggings', c('#5a5248'), { roughness: 0.9, sheen: c('#7a7268') }),
    trim: pbr('trim', c('#c9a24a'), { metallic: 0.85, roughness: 0.35 }),
    hood: pbr('hood', c('#5a4632'), { roughness: 0.95, sheen: c('#8a7458') }),
    crown: pbr('crown', c('#f0c060'), { metallic: 0.9, roughness: 0.25 }),
    skin: pbr('skin', c('#e8c9a8'), { roughness: 0.7 }),
  };
  // thin grass blades are lit at a grazing angle from above: a little self-light keeps them reading as grass
  themed.find((t) => t.mat === mats.tuft)!.serene.emissive = c('#2f5a22');
  rederive(mats.tuft);
  themed.find((t) => t.mat === mats.lanternGlass)!.serene.emissive = c('#ffb850');
  rederive(mats.lanternGlass, { emissive: c('#ffc060'), emissiveIntensity: 2.4 });
  themed.find((t) => t.mat === mats.lanternGlassB)!.serene.emissive = c('#ffe08a');
  rederive(mats.lanternGlassB, { emissive: c('#ffe8a0'), emissiveIntensity: 2.4 });
  themed.find((t) => t.mat === mats.lanternGlassC)!.serene.emissive = c('#9ad4ff');
  rederive(mats.lanternGlassC, { emissive: c('#a8dcff'), emissiveIntensity: 2.4 });
  themed.find((t) => t.mat === mats.towerWindow)!.serene.emissive = c('#ffb850');
  themed.find((t) => t.mat === mats.towerWindow)!.volcanic.emissive = c('#ff7a3a');
  rederive(mats.towerWindow, { emissive: c('#ffc060'), emissiveIntensity: 2.2 });
  mats.gateCone.backFaceCulling = false;
  (mats.towerWindow.emissiveTexture as Texture).uScale = 6;
  (mats.towerWindow.emissiveTexture as Texture).vScale = 1;

  const playerCache = new Map<string, { body: PBRMaterial; cape: PBRMaterial }>();
  function playerMaterials(color: string): { body: PBRMaterial; cape: PBRMaterial } {
    let m = playerCache.get(color);
    if (!m) {
      let col: Color3;
      try { col = Color3.FromHexString(/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#9fb7b3'); } catch { col = c('#9fb7b3'); }
      const body = pbr(`player:${color}`, col, { roughness: 0.55, metallic: 0.05, sheen: col.scale(0.8) });
      const tb = themed.find((t) => t.mat === body)!;
      tb.serene.emissive = col.scale(0.12);
      tb.volcanic.emissive = col.scale(0.18);
      rederive(body, { albedo: col.scale(0.85), emissive: col.scale(0.3) });
      const cape = pbr(`cape:${color}`, col.scale(0.65), { roughness: 0.9, twoSided: true, sheen: col.scale(0.5) });
      rederive(cape, { albedo: col.scale(0.5) });
      m = { body, cape };
      playerCache.set(color, m);
    }
    return m;
  }

  const relicCache = new Map<number, { core: PBRMaterial; shell: PBRMaterial; halo: PBRMaterial; pool: PBRMaterial; color: Color3 }>();
  const relicColors = [c('#ffc85c'), c('#7fd4ff'), c('#d48cff'), c('#8dff9a'), c('#ff8c8c')];
  function relicMaterials(index: number) {
    let r = relicCache.get(index);
    if (!r) {
      const color = relicColors[((index % relicColors.length) + relicColors.length) % relicColors.length];
      const core = pbr(`relicCore${index}`, color, { unlit: true });
      const shell = pbr(`relicShell${index}`, Color3.Lerp(color, Color3.White(), 0.4), { metallic: 0.2, roughness: 0.2, alpha: 0.42, clearCoat: true });
      const halo = pbr(`relicHalo${index}`, color, { unlit: true, alpha: 0.12, twoSided: true });
      const pool = pbr(`relicPool${index}`, color, { unlit: true, alpha: 0.55, albedoTex: tex.pool, twoSided: true });
      (pool.albedoTexture as Texture).hasAlpha = true;
      pool.useAlphaFromAlbedoTexture = true;
      const emis: [PBRMaterial, Color3, number][] = [[core, color, 1.6], [shell, color.scale(0.35), 1], [halo, color, 1], [pool, color, 1]];
      for (const [m, e, i] of emis) {
        const t = themed.find((x) => x.mat === m)!;
        for (const k of ['serene', 'volcanic'] as const) { t.looks[k].emissive = e.clone(); t.looks[k].emissiveIntensity = i; }
        // relics keep their colour in every biome; night only turns them up
        rederive(m, { albedo: t.serene.albedo.clone(), emissive: e.clone(), emissiveIntensity: i * 1.7 });
      }
      r = { core, shell, halo, pool, color };
      relicCache.set(index, r);
    }
    return r;
  }

  function applyOne(t: Themed, e: number) {
    lerpLook(tmpLook, t.from, t.target, e);
    t.mat.albedoColor.copyFrom(tmpLook.albedo);
    t.mat.emissiveColor.copyFrom(tmpLook.emissive);
    t.mat.emissiveIntensity = tmpLook.emissiveIntensity;
    t.mat.roughness = tmpLook.roughness;
    if (tmpLook.alpha !== t.mat.alpha) t.mat.alpha = tmpLook.alpha;
  }
  /** Capture the live look of every material as the blend origin (theme switch). */
  function snapshot() {
    for (const t of themed) {
      t.from.albedo.copyFrom(t.mat.albedoColor);
      t.from.emissive.copyFrom(t.mat.emissiveColor);
      t.from.emissiveIntensity = t.mat.emissiveIntensity;
      t.from.roughness = t.mat.roughness ?? t.from.roughness;
      t.from.alpha = t.mat.alpha;
      retarget(t);
    }
  }

  let lastE = -1;
  let lastTheme: ThemeName | null = null;
  function applyTheme(e: number) {
    if (e === lastE && lastTheme === currentTheme) return;
    lastE = e; lastTheme = currentTheme;
    for (const t of themed) applyOne(t, e);
    const v = volcanicAmount();
    for (const cb of callbacks) { try { cb(v, liveWeights); } catch { /* ignore */ } }
  }

  /** Register a per-theme callback (lava amount, biome weights); returns an unsubscribe. Called immediately. */
  function onTheme(cb: (v: number, w: BiomeWeights) => void): () => void {
    callbacks.add(cb);
    cb(volcanicAmount(), liveWeights);
    return () => { callbacks.delete(cb); };
  }

  return { ...mats, tex, playerMaterials, relicMaterials, applyTheme, snapshot, onTheme, volcanic: volcanicAmount, weights: biomeWeights };
}
