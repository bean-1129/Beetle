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

export type GeometryTheme = 'serene' | 'volcanic';

let currentTheme: GeometryTheme = 'serene';
let currentBlend = 1; // fully at the current theme

/** 0 = fully serene, 1 = fully volcanic. */
export function volcanicAmount(): number {
  return currentTheme === 'volcanic' ? currentBlend : 1 - currentBlend;
}

/** Blend the geometry materials toward a theme; t runs 0..1 (progress toward `theme`). */
export function setGeometryTheme(theme: GeometryTheme, t: number): void {
  currentTheme = theme;
  currentBlend = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 1));
  const v = volcanicAmount();
  for (const g of live) g.applyTheme(v);
}

export function getGeometryTheme(): { theme: GeometryTheme; t: number } {
  return { theme: currentTheme, t: currentBlend };
}

// debug hook for the play page console: window.__beetleGeometry.setGeometryTheme('volcanic', 1)
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
  return { stoneNormal, soilNormal, barkNormal, woodAlbedo, stoneAlbedo, cracks, ropeAlbedo, tuftCard, leafCard, runeAlbedo, runeGlow, sparkle, flame, pool };
}

export type GeoTextures = ReturnType<typeof makeTextures>;

// ---------------------------------------------------------------- materials

type Look = { albedo: Color3; emissive?: Color3; emissiveIntensity?: number; roughness?: number; alpha?: number };
type Themed = { mat: PBRMaterial; serene: Required<Look>; volcanic: Required<Look> };

function fill(l: Look, base: PBRMaterial): Required<Look> {
  return {
    albedo: l.albedo,
    emissive: l.emissive ?? Color3.Black(),
    emissiveIntensity: l.emissiveIntensity ?? base.emissiveIntensity,
    roughness: l.roughness ?? (base.roughness ?? 1),
    alpha: l.alpha ?? base.alpha,
  };
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
    g.applyTheme(volcanicAmount());
  }
  return g;
}

function createGeoMaterials(scene: Scene) {
  const tex = makeTextures(scene);
  const themed: Themed[] = [];
  const callbacks = new Set<(v: number) => void>();

  type Opts = {
    metallic?: number; roughness?: number; bump?: Texture; bumpScale?: number; albedoTex?: Texture; albedoScale?: number;
    emissiveTex?: Texture; emissiveScale?: number; alpha?: number; unlit?: boolean; twoSided?: boolean; alphaTest?: boolean;
    volcanic?: Look; sheen?: Color3; clearCoat?: boolean;
  };
  function pbr(name: string, albedo: Color3, o: Opts = {}): PBRMaterial {
    const m = new PBRMaterial(`geo:${name}`, scene);
    m.albedoColor = albedo;
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
    themed.push({ mat: m, serene, volcanic });
    return m;
  }

  const c = (hex: string) => Color3.FromHexString(hex);
  const ember = c('#ff7a2a');

  const mats = {
    // island
    grass: pbr('grass', c('#7fbf66'), {
      roughness: 0.9, bump: tex.soilNormal, bumpScale: 1, emissiveTex: tex.cracks, emissiveScale: 0.6,
      volcanic: { albedo: c('#3a2c22'), emissive: ember, emissiveIntensity: 1.4, roughness: 0.95 },
    }),
    stone: pbr('stone', c('#cfc5b2'), {
      roughness: 0.85, bump: tex.stoneNormal, bumpScale: 1.2, albedoTex: tex.stoneAlbedo, albedoScale: 1.2,
      volcanic: { albedo: c('#5a5048'), roughness: 0.9 },
    }),
    stoneDark: pbr('stoneDark', c('#8c8373'), { roughness: 0.88, bump: tex.stoneNormal, bumpScale: 2, volcanic: { albedo: c('#3d3632') } }),
    rock: pbr('rock', c('#8d918c'), { roughness: 0.8, bump: tex.stoneNormal, bumpScale: 3, volcanic: { albedo: c('#45403c') } }),
    pebble: pbr('pebble', c('#a9a79c'), { roughness: 0.8, bump: tex.stoneNormal, bumpScale: 4, volcanic: { albedo: c('#4a4541') } }),
    tuft: pbr('tuft', c('#d8ffb0'), { roughness: 0.95, albedoTex: tex.tuftCard, alphaTest: true, twoSided: true, volcanic: { albedo: c('#4a3a2a'), emissive: ember.scale(0.35), emissiveIntensity: 1 } }),
    crust: pbr('crust', c('#4a1c0c'), { unlit: true, alpha: 0, twoSided: true, volcanic: { albedo: c('#5a200c'), emissive: c('#ffb050'), emissiveIntensity: 1.6, alpha: 0.9 } }),
    underShadow: pbr('underShadow', c('#0b1a1c'), { unlit: true, alpha: 0.38, twoSided: true }),
    // bridge
    wood: pbr('wood', c('#8a5a30'), { roughness: 0.8, albedoTex: tex.woodAlbedo, albedoScale: 1, bump: tex.barkNormal, bumpScale: 0.5, volcanic: { albedo: c('#3a2a1e'), emissive: ember.scale(0.25), emissiveIntensity: 0.8 } }),
    plankA: pbr('plankA', c('#a26a35'), { roughness: 0.8, albedoTex: tex.woodAlbedo, albedoScale: 2, bump: tex.barkNormal, bumpScale: 0.6, emissiveTex: tex.cracks, emissiveScale: 1, volcanic: { albedo: c('#3b2b1f'), emissive: ember, emissiveIntensity: 0.9 } }),
    plankB: pbr('plankB', c('#8c5729'), { roughness: 0.82, albedoTex: tex.woodAlbedo, albedoScale: 2, bump: tex.barkNormal, bumpScale: 0.6, emissiveTex: tex.cracks, emissiveScale: 1, volcanic: { albedo: c('#33251b'), emissive: ember, emissiveIntensity: 0.8 } }),
    woodLight: pbr('woodLight', c('#b57a3e'), { roughness: 0.78, albedoTex: tex.woodAlbedo, albedoScale: 1, volcanic: { albedo: c('#4a3524') } }),
    rope: pbr('rope', c('#dcc9a3'), { roughness: 0.95, albedoTex: tex.ropeAlbedo, albedoScale: 1, volcanic: { albedo: c('#8a7458') } }),
    iron: pbr('iron', c('#3a3b3f'), { metallic: 0.85, roughness: 0.5, volcanic: { albedo: c('#2a2425') } }),
    lanternGlass: pbr('lanternGlass', c('#ffd27f'), { roughness: 0.3, volcanic: { albedo: c('#ff8a4a'), emissive: c('#ff6a30'), emissiveIntensity: 1.6 } }),
    // decorations
    trunk: pbr('trunk', c('#6b4625'), { roughness: 0.9, bump: tex.barkNormal, bumpScale: 1, albedoTex: tex.woodAlbedo, albedoScale: 1, volcanic: { albedo: c('#2b211b') } }),
    leaves: pbr('leaves', c('#4aa255'), { roughness: 0.85, bump: tex.soilNormal, bumpScale: 2, volcanic: { albedo: c('#3a2f26'), roughness: 0.95 } }),
    leavesDark: pbr('leavesDark', c('#2f7a3c'), { roughness: 0.85, bump: tex.soilNormal, bumpScale: 2, volcanic: { albedo: c('#2a221c'), roughness: 0.95 } }),
    leafCard: pbr('leafCard', c('#ffffff'), { roughness: 0.85, albedoTex: tex.leafCard, alphaTest: true, twoSided: true, volcanic: { albedo: c('#3a2a20') } }),
    emberTip: pbr('emberTip', c('#ff9a4a'), { unlit: true, alpha: 0, volcanic: { albedo: c('#ff9a4a'), emissive: ember, emissiveIntensity: 2, alpha: 1 } }),
    bush: pbr('bush', c('#4fae5c'), { roughness: 0.9, bump: tex.soilNormal, bumpScale: 2, volcanic: { albedo: c('#3b3028') } }),
    lanternPost: pbr('lanternPost', c('#4a3a2a'), { roughness: 0.7, metallic: 0.3, volcanic: { albedo: c('#2a2220') } }),
    halo: pbr('halo', c('#ffd98a'), { unlit: true, alpha: 0.18, twoSided: true, volcanic: { albedo: c('#ff8a4a'), alpha: 0.22 } }),
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
    hood: pbr('hood', c('#5a4632'), { roughness: 0.95, sheen: c('#8a7458') }),
    crown: pbr('crown', c('#f0c060'), { metallic: 0.9, roughness: 0.25 }),
    skin: pbr('skin', c('#e8c9a8'), { roughness: 0.7 }),
  };
  mats.lanternGlass.emissiveColor = c('#ffb850');
  // thin grass blades are lit at a grazing angle from above: a little self-light keeps them reading as grass
  mats.tuft.emissiveColor = c('#2f5a22');
  themed.find((t) => t.mat === mats.tuft)!.serene.emissive = c('#2f5a22');
  themed.find((t) => t.mat === mats.lanternGlass)!.serene.emissive = c('#ffb850');
  mats.gateCone.backFaceCulling = false;

  const playerCache = new Map<string, { body: PBRMaterial; cape: PBRMaterial }>();
  function playerMaterials(color: string): { body: PBRMaterial; cape: PBRMaterial } {
    let m = playerCache.get(color);
    if (!m) {
      let col: Color3;
      try { col = Color3.FromHexString(/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#9fb7b3'); } catch { col = c('#9fb7b3'); }
      const body = pbr(`player:${color}`, col, { roughness: 0.55, metallic: 0.05, sheen: col.scale(0.8) });
      body.emissiveColor = col.scale(0.12);
      themed.find((t) => t.mat === body)!.serene.emissive = col.scale(0.12);
      themed.find((t) => t.mat === body)!.volcanic.emissive = col.scale(0.18);
      const cape = pbr(`cape:${color}`, col.scale(0.65), { roughness: 0.9, twoSided: true, sheen: col.scale(0.5) });
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
      core.emissiveColor = color; core.emissiveIntensity = 1.6;
      const shell = pbr(`relicShell${index}`, Color3.Lerp(color, Color3.White(), 0.4), { metallic: 0.2, roughness: 0.2, alpha: 0.42, clearCoat: true });
      shell.emissiveColor = color.scale(0.35);
      const halo = pbr(`relicHalo${index}`, color, { unlit: true, alpha: 0.12, twoSided: true });
      halo.emissiveColor = color;
      const pool = pbr(`relicPool${index}`, color, { unlit: true, alpha: 0.55, albedoTex: tex.pool, twoSided: true });
      pool.emissiveColor = color;
      (pool.albedoTexture as Texture).hasAlpha = true;
      pool.useAlphaFromAlbedoTexture = true;
      for (const m of [core, shell, halo, pool]) {
        const t = themed.find((x) => x.mat === m)!;
        t.serene.emissive = m.emissiveColor.clone(); t.volcanic.emissive = m.emissiveColor.clone();
        t.serene.emissiveIntensity = m.emissiveIntensity; t.volcanic.emissiveIntensity = m.emissiveIntensity;
      }
      r = { core, shell, halo, pool, color };
      relicCache.set(index, r);
    }
    return r;
  }

  let lastV = -1;
  function applyTheme(v: number) {
    if (v === lastV) return;
    lastV = v;
    const e = v * v * (3 - 2 * v);
    for (const t of themed) {
      Color3.LerpToRef(t.serene.albedo, t.volcanic.albedo, e, t.mat.albedoColor);
      Color3.LerpToRef(t.serene.emissive, t.volcanic.emissive, e, t.mat.emissiveColor);
      t.mat.emissiveIntensity = t.serene.emissiveIntensity + (t.volcanic.emissiveIntensity - t.serene.emissiveIntensity) * e;
      t.mat.roughness = t.serene.roughness + (t.volcanic.roughness - t.serene.roughness) * e;
      const a = t.serene.alpha + (t.volcanic.alpha - t.serene.alpha) * e;
      if (a !== t.mat.alpha) t.mat.alpha = a;
    }
    for (const cb of callbacks) { try { cb(v); } catch { /* ignore */ } }
  }

  /** Register a per-theme callback (returns an unsubscribe). Called immediately with the current amount. */
  function onTheme(cb: (v: number) => void): () => void {
    callbacks.add(cb);
    cb(volcanicAmount());
    return () => { callbacks.delete(cb); };
  }

  return { ...mats, tex, playerMaterials, relicMaterials, applyTheme, onTheme, volcanic: volcanicAmount };
}
