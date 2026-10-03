import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { Constants } from '@babylonjs/core/Engines/constants';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { SphericalHarmonics, SphericalPolynomial } from '@babylonjs/core/Maths/sphericalPolynomial';
import { CubeMapToSphericalPolynomialTools } from '@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import type { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import * as geo from './geometry-materials.ts';
import { THEMES, THEME_NAMES, type BiomeName, type ThemeName, type ThemeParams, themeForHazard, themeFor, lavaOf, biomeOf } from './palette.ts';
import type { Materials } from './materials.ts';

export { themeForHazard, themeFor, lavaOf, biomeOf, THEME_NAMES };
export type { ThemeName, ThemeParams, BiomeName };

export const THEME_BLEND_MS = 2200; // smoothstep-eased (see update): 2 to 2.5 s reads as a scene change, not a cut

const COLOR_KEYS = [
  'skyZenith', 'skyHorizon', 'skyGround', 'sunColor', 'cloudColor', 'cloudUnderGlow', 'hemiColor', 'hemiGround', 'ambient', 'clearColor',
  'fogColor', 'godRayColor', 'waterShallow', 'waterDeep',
] as const;
const NUM_KEYS = [
  'sunDiscSize', 'hazeStrength', 'cloudCover', 'envIntensity', 'sunIntensity', 'hemiIntensity', 'fogDensity', 'exposure', 'contrast',
  'bloomWeight', 'glowIntensity', 'vignetteWeight', 'godRayDensity', 'godRayWeight', 'ssaoStrength', 'hazardMix', 'fireflies', 'pollen',
  'embers', 'ash', 'moon', 'stars', 'lightBoost', 'snow', 'shimmer',
] as const;

function cloneParams(p: ThemeParams): ThemeParams {
  const out = { ...p, sunDir: { ...p.sunDir } } as ThemeParams;
  for (const k of COLOR_KEYS) (out as unknown as Record<string, Color3>)[k] = p[k].clone();
  return out;
}

function lerpParams(out: ThemeParams, a: ThemeParams, b: ThemeParams, t: number) {
  for (const k of COLOR_KEYS) Color3.LerpToRef(a[k], b[k], t, out[k]);
  const o = out as unknown as Record<string, number>;
  for (const k of NUM_KEYS) o[k] = a[k] + (b[k] - a[k]) * t;
  const dx = a.sunDir.x + (b.sunDir.x - a.sunDir.x) * t;
  const dy = a.sunDir.y + (b.sunDir.y - a.sunDir.y) * t;
  const dz = a.sunDir.z + (b.sunDir.z - a.sunDir.z) * t;
  const len = Math.hypot(dx, dy, dz) || 1;
  out.sunDir.x = dx / len; out.sunDir.y = dy / len; out.sunDir.z = dz / len;
}

// ---------------------------------------------------------------------------------------------------------
// Procedural sky evaluated on the CPU for the IBL cube (same model as the dome shader, minus clouds).
// ---------------------------------------------------------------------------------------------------------
const IBL_SIZE = 32;
const FACE_BYTES = IBL_SIZE * IBL_SIZE * 4;

function skyColor(p: ThemeParams, dx: number, dy: number, dz: number, out: Color3) {
  const h = dy;
  if (h >= 0) {
    Color3.LerpToRef(p.skyHorizon, p.skyZenith, Math.pow(Math.min(1, h), 0.5), out);
  } else {
    Color3.LerpToRef(p.skyHorizon, p.skyGround, Math.pow(Math.min(1, -h), 0.45), out);
  }
  const s = -(dx * p.sunDir.x + dy * p.sunDir.y + dz * p.sunDir.z);
  const sp = Math.max(0, s);
  const haze = Math.exp(-Math.abs(h) * 7) * p.hazeStrength;
  const hz = 0.35 + 0.35 * sp * sp * sp;
  out.r += (p.skyHorizon.r + (p.sunColor.r - p.skyHorizon.r) * hz - out.r) * haze;
  out.g += (p.skyHorizon.g + (p.sunColor.g - p.skyHorizon.g) * hz - out.g) * haze;
  out.b += (p.skyHorizon.b + (p.sunColor.b - p.skyHorizon.b) * hz - out.b) * haze;
  const glow = Math.pow(sp, 28) * 0.6 + Math.pow(sp, 6) * 0.14 + (s > p.sunDiscSize ? 1.5 : 0);
  out.r += p.sunColor.r * glow; out.g += p.sunColor.g * glow; out.b += p.sunColor.b * glow;
}

/** faces in Babylon order: +X, -X, +Y, -Y, +Z, -Z */
function bakeSkyFaces(p: ThemeParams, faces: Uint8Array[]) {
  const tmp = new Color3();
  for (let f = 0; f < 6; f++) {
    const data = faces[f];
    for (let y = 0; y < IBL_SIZE; y++) {
      const v = ((y + 0.5) / IBL_SIZE) * 2 - 1;
      for (let x = 0; x < IBL_SIZE; x++) {
        const u = ((x + 0.5) / IBL_SIZE) * 2 - 1;
        let dx = 0; let dy = 0; let dz = 0;
        switch (f) {
          case 0: dx = 1; dy = -v; dz = -u; break;
          case 1: dx = -1; dy = -v; dz = u; break;
          case 2: dx = u; dy = 1; dz = v; break;
          case 3: dx = u; dy = -1; dz = -v; break;
          case 4: dx = u; dy = -v; dz = 1; break;
          default: dx = -u; dy = -v; dz = -1; break;
        }
        const len = Math.hypot(dx, dy, dz);
        skyColor(p, dx / len, dy / len, dz / len, tmp);
        const i = (y * IBL_SIZE + x) * 4;
        data[i] = Math.round(Math.min(1, tmp.r) * 255);
        data[i + 1] = Math.round(Math.min(1, tmp.g) * 255);
        data[i + 2] = Math.round(Math.min(1, tmp.b) * 255);
        data[i + 3] = 255;
      }
    }
  }
}

function harmonicsFor(faces: Uint8Array[]): SphericalHarmonics {
  const sp = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
    right: faces[0], left: faces[1], up: faces[2], down: faces[3], front: faces[4], back: faces[5],
    size: IBL_SIZE, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_INT, gammaSpace: true,
  });
  return SphericalHarmonics.FromPolynomial(sp);
}

const SH_KEYS = ['l00', 'l1_1', 'l10', 'l11', 'l2_2', 'l2_1', 'l20', 'l21', 'l22'] as const;

export type Environment = ReturnType<typeof createEnvironment>;

export function createEnvironment(scene: Scene, mats: Materials, sun: DirectionalLight, hemi: HemisphericLight) {
  // ---- meshes: sky dome, cloud sheet, sun disc (god-ray source) ----
  const skyDome = CreateSphere('sky', { diameter: 900, segments: 24 }, scene);
  skyDome.material = mats.sky;
  skyDome.infiniteDistance = true;
  skyDome.isPickable = false;
  skyDome.applyFog = false;
  skyDome.alwaysSelectAsActiveMesh = true;
  skyDome.receiveShadows = false;
  skyDome.freezeWorldMatrix();

  const cloudSheet = CreateGround('clouds', { width: 1400, height: 1400, subdivisions: 1 }, scene);
  cloudSheet.material = mats.clouds;
  cloudSheet.position.y = 75;
  cloudSheet.isPickable = false;
  cloudSheet.applyFog = false;
  cloudSheet.alwaysSelectAsActiveMesh = true;
  cloudSheet.receiveShadows = false;
  cloudSheet.freezeWorldMatrix();

  const sunMat = new StandardMaterial('sunDisc', scene);
  sunMat.disableLighting = true;
  sunMat.emissiveColor = new Color3(1, 0.95, 0.8);
  sunMat.fogEnabled = false;
  const sunDisc = CreateSphere('sunDisc', { diameter: 56, segments: 12 }, scene);
  sunDisc.material = sunMat;
  sunDisc.isPickable = false;
  sunDisc.applyFog = false;
  sunDisc.alwaysSelectAsActiveMesh = true;
  sunDisc.receiveShadows = false;
  const SUN_DISTANCE = 420;

  // ---- IBL cube: baked once per theme, blended on the GPU-side texture while a theme change runs ----
  const faceSets = {} as Record<ThemeName, Uint8Array[]>;
  const shSets = {} as Record<ThemeName, SphericalHarmonics>;
  for (const name of THEME_NAMES) {
    faceSets[name] = Array.from({ length: 6 }, () => new Uint8Array(FACE_BYTES));
    bakeSkyFaces(THEMES[name], faceSets[name]);
    shSets[name] = harmonicsFor(faceSets[name]);
  }
  const liveFaces = Array.from({ length: 6 }, (_, i) => new Uint8Array(faceSets.serene[i]));
  const liveSH = new SphericalHarmonics();
  const liveSP = new SphericalPolynomial();
  const envCube = new RawCubeTexture(scene, liveFaces, IBL_SIZE, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  envCube.name = 'env:sky';
  envCube.gammaSpace = true;
  function setSH(a: SphericalHarmonics, b: SphericalHarmonics, t: number) {
    for (const k of SH_KEYS) Vector3.LerpToRef(a[k], b[k], t, liveSH[k]);
    liveSH.preScaled = false;
    liveSP.updateFromHarmonics(liveSH);
    envCube.sphericalPolynomial = liveSP;
  }
  setSH(shSets.serene, shSets.serene, 0);
  scene.environmentTexture = envCube;

  // ---- theme state ----
  let current: ThemeName = 'serene';
  let from: ThemeParams = cloneParams(THEMES.serene);
  let fromFaces: Uint8Array[] = faceSets.serene;
  let fromSH: SphericalHarmonics = shSets.serene;
  const live: ThemeParams = cloneParams(THEMES.serene);
  let blendStart = -1;
  let blendT = 1;
  let dirty = true;
  // short sun/hemi pulse (world commit)
  let pulseStart = -1;
  const PULSE_MS = 400;
  const PULSE_AMPLITUDE = 0.1; // key light pulse capped at +10 % (half-sine, no overshoot)

  const sunDirV = new Vector3();
  const sunPos = new Vector3();
  const tmpCam = new Vector3();

  function snapshotFromLive() {
    from = cloneParams(live);
    // snapshot the cube/SH at the current blend too, so a mid-blend switch continues smoothly
    const snapFaces = liveFaces.map((f) => new Uint8Array(f));
    fromFaces = snapFaces;
    const sh = new SphericalHarmonics();
    for (const k of SH_KEYS) sh[k].copyFrom(liveSH[k]);
    fromSH = sh;
  }

  function setTheme(name: ThemeName, now: number) {
    if (name === current) return;
    snapshotFromLive();
    current = name;
    blendStart = now;
    blendT = 0;
    dirty = true;
  }

  function blendCube(t: number) {
    const tgt = faceSets[current];
    for (let f = 0; f < 6; f++) {
      const a = fromFaces[f]; const b = tgt[f]; const o = liveFaces[f];
      for (let i = 0; i < FACE_BYTES; i++) o[i] = a[i] + (b[i] - a[i]) * t;
    }
    envCube.update(liveFaces, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT, false);
    setSH(fromSH, shSets[current], t);
  }

  function applyLive(cameraPos: Vector3) {
    // scene & fog
    scene.clearColor.set(live.clearColor.r, live.clearColor.g, live.clearColor.b, 1);
    scene.ambientColor.copyFrom(live.ambient);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor.copyFrom(live.fogColor);
    scene.fogDensity = live.fogDensity * (ground ? 1.15 : 1);
    scene.environmentIntensity = live.envIntensity;
    // lights
    sunDirV.set(live.sunDir.x, live.sunDir.y, live.sunDir.z);
    sun.direction.copyFrom(sunDirV);
    sunPos.copyFrom(sunDirV).scaleInPlace(-90);
    sun.position.copyFrom(sunPos);
    let pulse = 0;
    if (pulseStart >= 0) {
      const f = (performance.now() - pulseStart) / PULSE_MS;
      if (f >= 1) pulseStart = -1; else pulse = Math.sin(f * Math.PI) * PULSE_AMPLITUDE;
    }
    sun.intensity = live.sunIntensity * (1 + pulse);
    sun.diffuse.copyFrom(live.sunColor);
    sun.specular.copyFrom(live.sunColor);
    hemi.intensity = live.hemiIntensity * (1 + pulse * 0.6);
    hemi.diffuse.copyFrom(live.hemiColor);
    hemi.groundColor.copyFrom(live.hemiGround);
    // shader uniforms (hazard / sky / clouds)
    mats.setSceneUniforms({
      cameraPos, sunDir: sunDirV, sunColor: live.sunColor, skyZenith: live.skyZenith, skyHorizon: live.skyHorizon, skyGround: live.skyGround,
      fogColor: live.fogColor, fogDensity: live.fogDensity, sunSize: live.sunDiscSize, haze: live.hazeStrength,
      cloudColor: live.cloudColor, cloudUnderGlow: live.cloudUnderGlow, cloudCover: live.cloudCover,
      waterShallow: live.waterShallow, waterDeep: live.waterDeep, moon: live.moon, stars: live.stars,
    });
    // ground worlds have no hazard: no lava/water material swap
    mats.setHazardMix(ground ? 0 : live.hazardMix);
    sunMat.emissiveColor.copyFrom(live.sunColor);
    // god-ray source follows the camera so the sun keeps its direction
    tmpCam.copyFrom(cameraPos);
    sunDisc.position.copyFrom(sunDirV).scaleInPlace(-SUN_DISTANCE).addInPlace(tmpCam);
  }

  /**
   * Per frame. Returns true when any blended value changed this frame (the pipeline owner re-applies its
   * per-theme settings only then).
   */
  function update(now: number, cameraPos: Vector3): boolean {
    let changed = dirty;
    if (blendStart >= 0) {
      const b = Math.min(1, (now - blendStart) / THEME_BLEND_MS);
      blendT = b * b * (3 - 2 * b);
      lerpParams(live, from, THEMES[current], blendT);
      blendCube(blendT);
      geo.setGeometryTheme?.(current, blendT);
      if (b >= 1) blendStart = -1;
      changed = true;
    } else if (dirty) {
      lerpParams(live, from, THEMES[current], blendT);
      blendCube(blendT);
      geo.setGeometryTheme?.(current, blendT);
    }
    if (pulseStart >= 0) changed = true;
    // uniforms that depend on the camera are refreshed every frame regardless
    applyLive(cameraPos);
    dirty = false;
    return changed;
  }

  /** Manual blend control: render `theme` at blend amount t (0 = fully the other theme, 1 = fully `theme`). */
  function applyTheme(theme: ThemeName, t: number) {
    const other: ThemeName = theme === 'serene' ? 'volcanic' : 'serene';
    from = cloneParams(THEMES[other]);
    fromFaces = faceSets[other];
    fromSH = shSets[other];
    current = theme;
    blendStart = -1;
    blendT = Math.max(0, Math.min(1, t));
    dirty = true;
  }

  function pulseLight(now: number) { pulseStart = now; }

  // terrain 'ground': skip the hazard material swap, thicken the fog so the far field fades out
  let ground = false;
  function setGround(on: boolean) { if (on !== ground) { ground = on; dirty = true; } }

  function dispose() {
    skyDome.dispose(); cloudSheet.dispose(); sunDisc.dispose(); sunMat.dispose(); envCube.dispose();
  }

  const env = {
    live, setTheme, update, applyTheme, pulseLight, setGround, dispose, envCube, skyDome, cloudSheet, sunDisc,
    get theme() { return current; },
    get biome(): BiomeName { return biomeOf(current); },
    get lava() { return lavaOf(current); },
    get blend() { return blendT; },
    get blending() { return blendStart >= 0; },
  };
  activeEnvironment = env;
  return env;
}

let activeEnvironment: Environment | null = null;

/** Module-level hook: blends every environment parameter toward `theme` at amount t and forwards to the geometry owner. */
export function applyTheme(theme: ThemeName, t: number) {
  activeEnvironment?.applyTheme(theme, t);
  geo.setGeometryTheme?.(theme, t);
}

export function getEnvironment(): Environment | null { return activeEnvironment; }

export type { Mesh };
