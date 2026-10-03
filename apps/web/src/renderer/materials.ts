import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { HazardKind, WorldSpec } from '@beetle/contracts';
import { PALETTE } from './palette.ts';

type MatOpts = { emissive?: Color3; specular?: number; alpha?: number; unlit?: boolean; twoSided?: boolean };

function mat(scene: Scene, name: string, diffuse: Color3, opts: MatOpts = {}): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = new Color3(opts.specular ?? 0.08, opts.specular ?? 0.08, opts.specular ?? 0.08);
  if (opts.emissive) m.emissiveColor = opts.emissive;
  if (opts.alpha !== undefined) m.alpha = opts.alpha;
  if (opts.unlit) m.disableLighting = true;
  if (opts.twoSided) m.backFaceCulling = false;
  return m;
}

// ---------------------------------------------------------------------------------------------------------
// Runtime textures: tileable value noise (height) and a tangent-space normal map derived from it.
// ---------------------------------------------------------------------------------------------------------

function valueNoise(size: number, seed: number): Float32Array {
  const lattice = (n: number, s: number) => {
    const g = new Float32Array(n * n);
    let a = s >>> 0;
    for (let i = 0; i < n * n; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      g[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return (x: number, y: number) => {
      const fx = (x * n) / size; const fy = (y * n) / size;
      const x0 = Math.floor(fx) % n; const y0 = Math.floor(fy) % n;
      const x1 = (x0 + 1) % n; const y1 = (y0 + 1) % n;
      const sx = fx - Math.floor(fx); const sy = fy - Math.floor(fy);
      const ux = sx * sx * (3 - 2 * sx); const uy = sy * sy * (3 - 2 * sy);
      const a0 = g[y0 * n + x0] + (g[y0 * n + x1] - g[y0 * n + x0]) * ux;
      const a1 = g[y1 * n + x0] + (g[y1 * n + x1] - g[y1 * n + x0]) * ux;
      return a0 + (a1 - a0) * uy;
    };
  };
  const n1 = lattice(4, seed + 1234); const n2 = lattice(8, seed + 5678); const n3 = lattice(16, seed + 9012); const n4 = lattice(32, seed + 77);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = 0.45 * n1(x, y) + 0.28 * n2(x, y) + 0.17 * n3(x, y) + 0.1 * n4(x, y);
    }
  }
  return out;
}

function makeHeightTexture(scene: Scene, name: string, h: Float32Array, size: number): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(Math.min(1, Math.max(0, h[i])) * 255);
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function makeNormalTexture(scene: Scene, name: string, h: Float32Array, size: number, strength: number): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x + size - 1) % size)]; const r = h[y * size + ((x + 1) % size)];
      const u = h[((y + size - 1) % size) * size + x]; const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength; let ny = (u - d) * strength; let nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE; tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

// ---------------------------------------------------------------------------------------------------------
// Hazard surface shader: water (two scrolling normal layers, fresnel to sky, sun glints, shore tint, vertex
// waves) and lava (flowing noise, emissive channels between crust, pulse) computed in one pass and mixed by
// uMix so a theme change blends on the same mesh. uGlowPass = 1 outputs only the emissive term for the
// GlowLayer (which renders this mesh with its own material).
// ---------------------------------------------------------------------------------------------------------

const MAX_ISLANDS = 8;

const HAZARD_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float uTime;
uniform float uMix;
varying vec3 vWorldPos;
varying float vWave;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  float t = uTime * mix(1.0, 0.35, uMix);
  float w1 = sin(wp.x * 0.35 + t * 1.1) * cos(wp.z * 0.28 - t * 0.9);
  float w2 = sin((wp.x + wp.z) * 0.6 + t * 1.7);
  float amp = mix(0.07, 0.035, uMix);
  wp.y += (w1 * 0.7 + w2 * 0.3) * amp;
  vWave = w1;
  vWorldPos = wp.xyz;
  gl_Position = viewProjection * wp;
}`;

const HAZARD_FRAGMENT = `
precision highp float;
varying vec3 vWorldPos;
varying float vWave;
uniform sampler2D uNoise;
uniform sampler2D uNormal;
uniform float uTime;
uniform float uMix;
uniform float uGlowPass;
uniform float uPulse;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uLavaDark;
uniform vec3 uLavaBright;
uniform vec3 uLavaGlow;
uniform vec4 uIslands[${MAX_ISLANDS}];
uniform int uIslandCount;

void main() {
  vec2 p = vWorldPos.xz;
  // distance to the nearest island rim: 1 at the rim, 0 a few metres out
  float shore = 0.0;
  for (int i = 0; i < ${MAX_ISLANDS}; i++) {
    if (i >= uIslandCount) break;
    float d = length(p - uIslands[i].xy) - uIslands[i].z;
    shore = max(shore, 1.0 - smoothstep(0.0, 3.2, d));
  }
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = normalize(-uSunDir);

  // ---- water ----
  vec2 uvA = p * 0.075 + vec2(uTime * 0.013, uTime * 0.009);
  vec2 uvB = p * 0.16 - vec2(uTime * 0.016, -uTime * 0.012);
  vec3 nA = texture2D(uNormal, uvA).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uNormal, uvB).xyz * 2.0 - 1.0;
  vec2 slope = (nA.xy + nB.xy) * 0.55 * (1.0 - 0.35 * shore);
  vec3 N = normalize(vec3(slope.x, 1.0, slope.y));
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - ndv, 4.5);
  vec3 R = reflect(-V, N);
  vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.6));
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float glint = pow(ndh, 320.0) * 3.0 + pow(ndh, 28.0) * 0.18;
  float ndl = max(dot(N, L), 0.0);
  vec3 base = mix(uWaterDeep, uWaterShallow, clamp(shore * 0.8 + 0.2 * ndl + 0.1 * vWave, 0.0, 1.0));
  float foamN = texture2D(uNoise, p * 0.22 + vec2(uTime * 0.02, -uTime * 0.015)).r;
  float foam = smoothstep(0.52, 0.8, foamN + shore * 0.25) * shore * shore;
  // foam follows the sky brightness: at night it drops to about a third so lantern and relic light lead
  foam *= clamp(dot(uSkyHorizon, vec3(0.3, 0.59, 0.11)) * 2.5, 0.35, 1.0);
  vec3 water = mix(base, skyRefl, fres * 0.9) + uSunColor * glint + vec3(0.85, 0.9, 0.92) * foam * 0.6;
  float waterAlpha = mix(0.86, 0.98, fres) + 0.1 * foam;

  // ---- lava ----
  vec2 fuv = p * 0.055 + vec2(uTime * 0.0045, uTime * 0.003);
  float n1 = texture2D(uNoise, fuv).r;
  float n2 = texture2D(uNoise, p * 0.09 - vec2(uTime * 0.002, uTime * 0.0055)).r;
  float n3 = texture2D(uNoise, p * 0.21 + vec2(-uTime * 0.006, uTime * 0.004)).r;
  float flow = n1 * 0.6 + n2 * 0.3 + n3 * 0.1;
  float channel = smoothstep(0.54, 0.66, flow + shore * 0.08);
  float hot = smoothstep(0.64, 0.76, flow + shore * 0.08);
  float pulse = 0.82 + 0.18 * uPulse;
  vec3 crust = uLavaDark * (0.45 + 0.55 * n2) * (0.8 + 0.2 * n3);
  vec3 lavaBody = mix(crust, uLavaBright * 0.6, channel);
  // dim red heat seeping through the crust so the dark areas still read as lava, plus the bright channels
  vec3 emis = uLavaGlow * 0.08 * (0.4 + 0.6 * n1)
    + (uLavaGlow * channel * 0.5 + uLavaBright * hot * 0.75) * pulse * (1.0 + 0.35 * shore);
  vec3 lava = lavaBody * 0.45 + emis;

  if (uGlowPass > 0.5) {
    gl_FragColor = vec4(emis * uMix * 0.55, 1.0);
    return;
  }
  vec3 color = mix(water, lava, uMix);
  float alpha = mix(waterAlpha, 1.0, uMix);
  float dist = length(uCameraPos - vWorldPos);
  float f = dist * uFogDensity;
  float fog = 1.0 - clamp(1.0 / exp(f * f), 0.0, 1.0);
  // keep lava glow punching through the ash a little
  color = mix(color, uFogColor, fog * mix(1.0, 0.8, uMix));
  gl_FragColor = vec4(color, alpha);
}`;

const SKY_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vDir;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vDir = position;
  gl_Position = (viewProjection * wp).xyww;
}`;

const SKY_FRAGMENT = `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uHaze;
uniform float uMoon;
uniform float uStars;
float hash13(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 up = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  vec3 down = mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.45));
  vec3 col = h >= 0.0 ? up : down;
  float s = dot(d, -uSunDir);
  float sunward = pow(max(s, 0.0), 3.0);
  vec3 hazeCol = mix(uHorizon, uSunColor, 0.35 + 0.35 * sunward);
  float haze = exp(-abs(h) * 7.0) * uHaze;
  col = mix(col, hazeCol, haze);
  float disc = smoothstep(uSunSize, uSunSize + 0.0015, s);
  float glow = pow(max(s, 0.0), 28.0) * 0.6 + pow(max(s, 0.0), 6.0) * 0.14;
  vec3 sunTerm = uSunColor * (disc * 5.0 + glow);
  // moon: a pale disc with faint maria (cell noise) and a soft halo; stars: sparse cells above the horizon
  float maria = 0.75 + 0.25 * hash13(floor(d * 90.0));
  vec3 moonTerm = uSunColor * (disc * 1.6 * maria + glow * 0.35);
  col += mix(sunTerm, moonTerm, uMoon);
  if (uStars > 0.001 && h > 0.0) {
    vec3 cell = floor(d * 140.0);
    float r = hash13(cell);
    float star = step(0.985, r) * (0.5 + 0.5 * hash13(cell + 7.0));
    vec3 cen = (cell + 0.5) / 140.0;
    float dist = length(d * 140.0 - cell - 0.5);
    star *= smoothstep(0.5, 0.1, dist) * smoothstep(0.0, 0.25, h) * (1.0 - disc);
    col += vec3(0.9, 0.93, 1.0) * star * uStars * 1.6;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const CLOUD_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec2 vUv;
varying vec3 vWorldPos;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vUv = uv;
  vWorldPos = wp.xyz;
  gl_Position = viewProjection * wp;
}`;

const CLOUD_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying vec3 vWorldPos;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uCover;
uniform vec3 uCloudColor;
uniform vec3 uUnderGlow;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform float uFogDensity;
uniform vec3 uFogColor;
void main() {
  vec2 uv1 = vUv * 3.0 + vec2(uTime * 0.0035, uTime * 0.0012);
  vec2 uv2 = vUv * 7.0 - vec2(uTime * 0.0021, -uTime * 0.0027);
  float n = texture2D(uNoise, uv1).r * 0.7 + texture2D(uNoise, uv2).r * 0.3;
  float thr = 1.0 - uCover;
  float cover = smoothstep(thr - 0.12, thr + 0.18, n);
  float thick = smoothstep(thr, thr + 0.3, n);
  // lit from the sun side on thin edges, from below (underglow) where thick
  vec3 col = mix(uUnderGlow, uCloudColor, thick * 0.85);
  float dist = length(uCameraPos - vWorldPos);
  float f = dist * uFogDensity * 0.6;
  float fog = 1.0 - clamp(1.0 / exp(f * f), 0.0, 1.0);
  col = mix(col, uFogColor, fog);
  // fade at the edges of the sheet
  vec2 e = abs(vUv - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.6, 1.0, max(e.x, e.y));
  gl_FragColor = vec4(col, cover * edge * 0.85);
}`;

export type Materials = ReturnType<typeof createMaterials>;

export function createMaterials(scene: Scene) {
  const playerCache = new Map<string, StandardMaterial>();
  const shared = {
    stoneTop: mat(scene, 'stoneTop', PALETTE.stoneTop),
    stoneSide: mat(scene, 'stoneSide', PALETTE.stoneSide),
    stoneRim: mat(scene, 'stoneRim', PALETTE.stoneRim),
    stoneDark: mat(scene, 'stoneDark', PALETTE.stoneDark),
    grass: mat(scene, 'grass', PALETTE.grass, { specular: 0.03 }),
    grassDark: mat(scene, 'grassDark', PALETTE.grassDark, { specular: 0.03 }),
    wood: mat(scene, 'wood', PALETTE.wood, { specular: 0.05 }),
    woodLight: mat(scene, 'woodLight', PALETTE.woodLight, { specular: 0.05 }),
    plankA: mat(scene, 'plankA', PALETTE.plankA, { specular: 0.05 }),
    plankB: mat(scene, 'plankB', PALETTE.plankB, { specular: 0.05 }),
    rope: mat(scene, 'rope', PALETTE.rope),
    trunk: mat(scene, 'trunk', PALETTE.trunk),
    leaves: mat(scene, 'leaves', PALETTE.leaves),
    leavesDark: mat(scene, 'leavesDark', PALETTE.leavesDark),
    bush: mat(scene, 'bush', PALETTE.bush),
    rock: mat(scene, 'rock', PALETTE.rock, { specular: 0.15 }),
    lanternPost: mat(scene, 'lanternPost', PALETTE.lanternPost),
    lanternGlow: mat(scene, 'lanternGlow', PALETTE.lanternGlow, { emissive: PALETTE.lanternGlow.scale(0.75) }),
    relic: mat(scene, 'relic', PALETTE.relic, { emissive: PALETTE.relic.scale(0.55), specular: 0.7 }),
    relicHalo: mat(scene, 'relicHalo', PALETTE.relicHalo, { emissive: PALETTE.relicHalo, alpha: 0.22, unlit: true }),
    gateLocked: mat(scene, 'gateLocked', PALETTE.gateLocked),
    gateUnlocked: mat(scene, 'gateUnlocked', PALETTE.gateUnlocked, { emissive: PALETTE.amberBright.scale(0.7), specular: 0.4 }),
    gateCone: mat(scene, 'gateCone', PALETTE.amberBright, { emissive: PALETTE.amberBright, alpha: 0.0, unlit: true }),
    hat: mat(scene, 'hat', PALETTE.amber),
    halo: mat(scene, 'halo', PALETTE.amberBright, { emissive: PALETTE.amberBright.scale(0.6) }),
    playerBase: mat(scene, 'playerBase', PALETTE.stoneDark.scale(0.6), { specular: 0.2 }),
    underShadow: mat(scene, 'underShadow', PALETTE.shadow, { alpha: 0.38, unlit: true, twoSided: true }),
    crust: mat(scene, 'crust', PALETTE.lavaDeep, { emissive: Color3.FromHexString('#e0561a'), alpha: 0, unlit: true }),
  };
  shared.gateCone.backFaceCulling = false;
  shared.crust.backFaceCulling = false;

  // runtime textures (shared by hazard, clouds)
  const NOISE_SIZE = 256;
  const height = valueNoise(NOISE_SIZE, 11);
  const noise = makeHeightTexture(scene, 'tex:noise', height, NOISE_SIZE);
  const normal = makeNormalTexture(scene, 'tex:normal', height, NOISE_SIZE, 9);

  // ---- hazard (water <-> lava) ----
  const hazard = new ShaderMaterial('hazard', scene, { vertexSource: HAZARD_VERTEX, fragmentSource: HAZARD_FRAGMENT }, {
    attributes: ['position'],
    uniforms: ['world', 'viewProjection', 'uTime', 'uMix', 'uGlowPass', 'uPulse', 'uCameraPos', 'uSunDir', 'uSunColor', 'uSkyZenith', 'uSkyHorizon',
      'uFogColor', 'uFogDensity', 'uWaterShallow', 'uWaterDeep', 'uLavaDark', 'uLavaBright', 'uLavaGlow', 'uIslands', 'uIslandCount'],
    samplers: ['uNoise', 'uNormal'],
    needAlphaBlending: true,
  });
  hazard.backFaceCulling = true;
  hazard.setTexture('uNoise', noise);
  hazard.setTexture('uNormal', normal);
  hazard.setFloat('uTime', 0);
  hazard.setFloat('uMix', 0);
  hazard.setFloat('uGlowPass', 0);
  hazard.setFloat('uPulse', 0);
  hazard.setVector3('uCameraPos', Vector3.Zero());
  hazard.setVector3('uSunDir', new Vector3(-0.42, -0.78, 0.46));
  hazard.setColor3('uSunColor', new Color3(1, 0.95, 0.85));
  hazard.setColor3('uSkyZenith', new Color3(0.2, 0.45, 0.8));
  hazard.setColor3('uSkyHorizon', new Color3(0.65, 0.85, 0.92));
  hazard.setColor3('uFogColor', new Color3(0.65, 0.85, 0.92));
  hazard.setFloat('uFogDensity', 0.007);
  hazard.setColor3('uWaterShallow', Color3.FromHexString('#4fc3e8'));
  hazard.setColor3('uWaterDeep', Color3.FromHexString('#0f4f7c'));
  hazard.setColor3('uLavaDark', Color3.FromHexString('#3a0e07'));
  hazard.setColor3('uLavaBright', Color3.FromHexString('#ff5214'));
  hazard.setColor3('uLavaGlow', Color3.FromHexString('#ff7a1e'));
  const islandArr = new Array<number>(MAX_ISLANDS * 4).fill(0);
  hazard.setArray4('uIslands', islandArr);
  hazard.setInt('uIslandCount', 0);

  // ---- sky dome ----
  const sky = new ShaderMaterial('sky', scene, { vertexSource: SKY_VERTEX, fragmentSource: SKY_FRAGMENT }, {
    attributes: ['position'],
    uniforms: ['world', 'viewProjection', 'uZenith', 'uHorizon', 'uGround', 'uSunColor', 'uSunDir', 'uSunSize', 'uHaze', 'uMoon', 'uStars'],
  });
  sky.backFaceCulling = false;
  sky.disableDepthWrite = true;
  sky.setColor3('uZenith', new Color3(0.2, 0.45, 0.8));
  sky.setColor3('uHorizon', new Color3(0.65, 0.85, 0.92));
  sky.setColor3('uGround', new Color3(0.3, 0.5, 0.6));
  sky.setColor3('uSunColor', new Color3(1, 0.95, 0.85));
  sky.setVector3('uSunDir', new Vector3(-0.42, -0.78, 0.46));
  sky.setFloat('uSunSize', 0.9975);
  sky.setFloat('uHaze', 0.5);
  sky.setFloat('uMoon', 0);
  sky.setFloat('uStars', 0);

  // ---- cloud sheet ----
  const clouds = new ShaderMaterial('clouds', scene, { vertexSource: CLOUD_VERTEX, fragmentSource: CLOUD_FRAGMENT }, {
    attributes: ['position', 'uv'],
    uniforms: ['world', 'viewProjection', 'uTime', 'uCover', 'uCloudColor', 'uUnderGlow', 'uSunDir', 'uCameraPos', 'uFogDensity', 'uFogColor'],
    samplers: ['uNoise'],
    needAlphaBlending: true,
  });
  clouds.backFaceCulling = false;
  clouds.disableDepthWrite = true;
  clouds.setTexture('uNoise', noise);
  clouds.setFloat('uTime', 0);
  clouds.setFloat('uCover', 0.3);
  clouds.setColor3('uCloudColor', new Color3(1, 1, 1));
  clouds.setColor3('uUnderGlow', new Color3(0.9, 0.93, 0.96));
  clouds.setVector3('uSunDir', new Vector3(-0.42, -0.78, 0.46));
  clouds.setVector3('uCameraPos', Vector3.Zero());
  clouds.setFloat('uFogDensity', 0.007);
  clouds.setColor3('uFogColor', new Color3(0.65, 0.85, 0.92));

  // ---- hazard state ----
  let currentKind: HazardKind = 'water';
  let mix = 0;        // 0 = water, 1 = lava (driven by the environment blend)
  const BLEND_MS = 2000;
  let blendFrom = 0; let blendStart = -1; let blendTarget = 0;

  /** Compatibility entry point: starts a 2 s blend toward the kind. The environment normally drives setHazardMix. */
  function setHazardKind(kind: HazardKind, now: number) {
    if (kind === currentKind) return;
    currentKind = kind;
    blendFrom = mix; blendTarget = kind === 'lava' ? 1 : 0; blendStart = now;
  }
  /** Direct control of the water/lava mix (0..1). Cancels any kind-driven blend. */
  function setHazardMix(m: number) {
    mix = Math.max(0, Math.min(1, m));
    blendStart = -1;
    currentKind = mix >= 0.5 ? 'lava' : 'water';
    hazard.setFloat('uMix', mix);
    shared.crust.alpha = 0.4 * mix;
  }

  /** Islands feed the shore tint; called from applyWorld. */
  function setHazardIslands(spec: WorldSpec) {
    const n = Math.min(MAX_ISLANDS, spec.islands.length);
    islandArr.fill(0);
    for (let i = 0; i < n; i++) {
      const isl = spec.islands[i];
      islandArr[i * 4] = isl.center.x; islandArr[i * 4 + 1] = isl.center.z; islandArr[i * 4 + 2] = isl.radius; islandArr[i * 4 + 3] = 0;
    }
    hazard.setArray4('uIslands', islandArr);
    hazard.setInt('uIslandCount', n);
  }

  /** Per-frame lighting/sky parameters shared by the hazard, sky and cloud shaders (set by the environment). */
  function setSceneUniforms(p: {
    cameraPos: Vector3; sunDir: Vector3; sunColor: Color3; skyZenith: Color3; skyHorizon: Color3; skyGround: Color3;
    fogColor: Color3; fogDensity: number; sunSize: number; haze: number; cloudColor: Color3; cloudUnderGlow: Color3; cloudCover: number;
    waterShallow?: Color3; waterDeep?: Color3; moon?: number; stars?: number;
  }) {
    if (p.waterShallow) hazard.setColor3('uWaterShallow', p.waterShallow);
    if (p.waterDeep) hazard.setColor3('uWaterDeep', p.waterDeep);
    sky.setFloat('uMoon', p.moon ?? 0);
    sky.setFloat('uStars', p.stars ?? 0);
    hazard.setVector3('uCameraPos', p.cameraPos);
    hazard.setVector3('uSunDir', p.sunDir);
    hazard.setColor3('uSunColor', p.sunColor);
    hazard.setColor3('uSkyZenith', p.skyZenith);
    hazard.setColor3('uSkyHorizon', p.skyHorizon);
    hazard.setColor3('uFogColor', p.fogColor);
    hazard.setFloat('uFogDensity', p.fogDensity);
    sky.setColor3('uZenith', p.skyZenith);
    sky.setColor3('uHorizon', p.skyHorizon);
    sky.setColor3('uGround', p.skyGround);
    sky.setColor3('uSunColor', p.sunColor);
    sky.setVector3('uSunDir', p.sunDir);
    sky.setFloat('uSunSize', p.sunSize);
    sky.setFloat('uHaze', p.haze);
    clouds.setFloat('uCover', p.cloudCover);
    clouds.setColor3('uCloudColor', p.cloudColor);
    clouds.setColor3('uUnderGlow', p.cloudUnderGlow);
    clouds.setVector3('uSunDir', p.sunDir);
    clouds.setVector3('uCameraPos', p.cameraPos);
    clouds.setFloat('uFogDensity', p.fogDensity);
    clouds.setColor3('uFogColor', p.fogColor);
  }

  /** Called every frame: time, blend progress and the lava pulse. */
  function animateHazard(now: number) {
    if (blendStart >= 0) {
      const b = Math.min(1, (now - blendStart) / BLEND_MS);
      const e = b * b * (3 - 2 * b);
      mix = blendFrom + (blendTarget - blendFrom) * e;
      hazard.setFloat('uMix', mix);
      shared.crust.alpha = 0.8 * mix;
      if (b >= 1) blendStart = -1;
    }
    const t = now * 0.001;
    hazard.setFloat('uTime', t);
    clouds.setFloat('uTime', t);
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.3) * 0.6 + 0.2 * Math.sin(t * 3.7);
    hazard.setFloat('uPulse', pulse);
    if (mix > 0.01) shared.crust.alpha = mix * (0.3 + 0.15 * pulse);
  }

  /** The GlowLayer renders the hazard with its own material; flip to the emissive-only branch for that pass. */
  function setGlowPass(on: boolean) { hazard.setFloat('uGlowPass', on ? 1 : 0); }

  function playerMaterial(color: string): StandardMaterial {
    let m = playerCache.get(color);
    if (!m) {
      let c: Color3;
      try { c = Color3.FromHexString(/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#9fb7b3'); } catch { c = PALETTE.stoneSide; }
      m = mat(scene, `player:${color}`, c, { emissive: c.scale(0.14), specular: 0.35 });
      playerCache.set(color, m);
    }
    return m;
  }

  return {
    ...shared, hazard, sky, clouds, noise, normal,
    setHazardKind, setHazardMix, setHazardIslands, setSceneUniforms, animateHazard, setGlowPass, playerMaterial,
    get hazardKind() { return currentKind; },
    get hazardMix() { return mix; },
  };
}
