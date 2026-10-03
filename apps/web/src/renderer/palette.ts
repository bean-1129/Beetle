import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';

// One cohesive palette: pale stone, soft greens, clear teal-blue water, warm amber accents.
export const PALETTE = {
  clear: new Color4(0.34, 0.55, 0.6, 1), // kept for compatibility; the live clear colour comes from the active theme
  stoneTop: Color3.FromHexString('#ebe5d6'),
  stoneSide: Color3.FromHexString('#bfb49b'),
  stoneRim: Color3.FromHexString('#a89d84'),
  stoneDark: Color3.FromHexString('#857c67'),
  grass: Color3.FromHexString('#7cbf6a'),
  grassDark: Color3.FromHexString('#5fa352'),
  wood: Color3.FromHexString('#8c5a2b'),
  woodLight: Color3.FromHexString('#b8783a'),
  plankA: Color3.FromHexString('#a3672f'),
  plankB: Color3.FromHexString('#8e5727'),
  rope: Color3.FromHexString('#e2d2ad'),
  trunk: Color3.FromHexString('#6b4423'),
  leaves: Color3.FromHexString('#3f9d4f'),
  leavesDark: Color3.FromHexString('#2f7a3c'),
  bush: Color3.FromHexString('#4fae5c'),
  rock: Color3.FromHexString('#8a8f8c'),
  lanternPost: Color3.FromHexString('#4a3a2a'),
  lanternGlow: Color3.FromHexString('#ffd27f'),
  amber: Color3.FromHexString('#f0b45a'),
  amberBright: Color3.FromHexString('#ffd27f'),
  relic: Color3.FromHexString('#ffc85c'),
  relicHalo: Color3.FromHexString('#ffd98a'),
  gateLocked: Color3.FromHexString('#7a7467'),
  gateUnlocked: Color3.FromHexString('#f0b45a'),
  water: Color3.FromHexString('#3aa6dc'),
  waterDeep: Color3.FromHexString('#1f78a8'),
  lava: Color3.FromHexString('#ff5a36'),
  lavaDeep: Color3.FromHexString('#a3260f'),
  lavaGlow: Color3.FromHexString('#ff7a3a'),
  lavaCrust: Color3.FromHexString('#ffb050'),
  shadow: Color3.FromHexString('#0b1a1c'),
  label: '#f4f7f5',
} as const;

export type ThemeName = 'serene' | 'volcanic';

/**
 * Everything the environment blends between themes. Colours are linear-ish sRGB values picked for ACES tone
 * mapping (slightly brighter than they would be for a plain clear colour).
 */
export type ThemeParams = {
  name: ThemeName;
  // sky / IBL
  skyZenith: Color3;
  skyHorizon: Color3;
  skyGround: Color3;
  sunColor: Color3;
  sunDiscSize: number;      // angular radius of the soft sun disc (cos space, ~0.995 small)
  hazeStrength: number;     // horizon haze band intensity 0..1
  cloudColor: Color3;       // cloud tint (volcanic: dark ash)
  cloudUnderGlow: Color3;   // light from below (volcanic: orange)
  cloudCover: number;       // 0..1 density of the cloud layer
  envIntensity: number;     // scene.environmentIntensity for PBR IBL
  // lights
  sunDir: { x: number; y: number; z: number };
  sunIntensity: number;
  hemiColor: Color3;
  hemiGround: Color3;
  hemiIntensity: number;
  ambient: Color3;
  clearColor: Color3;
  // fog
  fogColor: Color3;
  fogDensity: number;
  // post
  exposure: number;
  contrast: number;
  bloomWeight: number;
  glowIntensity: number;
  vignetteWeight: number;
  godRayDensity: number;
  godRayWeight: number;
  godRayColor: Color3;
  ssaoStrength: number;
  // hazard surface: 0 = water shader, 1 = lava shader
  hazardMix: number;
  // particles
  fireflies: number; // 0..1 weight
  pollen: number;
  embers: number;
  ash: number;
};

export const THEMES: Record<ThemeName, ThemeParams> = {
  serene: {
    name: 'serene',
    skyZenith: Color3.FromHexString('#2a6fbf'),
    skyHorizon: Color3.FromHexString('#8cc6e3'),
    skyGround: Color3.FromHexString('#3f7f9c'),
    sunColor: Color3.FromHexString('#fff1cf'),
    sunDiscSize: 0.9975,
    hazeStrength: 0.4,
    cloudColor: Color3.FromHexString('#f7f9fb'),
    cloudUnderGlow: Color3.FromHexString('#d9e4ee'),
    cloudCover: 0.3,
    envIntensity: 0.7,
    sunDir: { x: -0.42, y: -0.78, z: 0.46 },
    sunIntensity: 1.45,
    hemiColor: Color3.FromHexString('#bcd4ec'),
    hemiGround: Color3.FromHexString('#345259'),
    hemiIntensity: 0.5,
    ambient: new Color3(0.16, 0.2, 0.23),
    clearColor: Color3.FromHexString('#78b7cf'),
    fogColor: Color3.FromHexString('#93c6dc'),
    fogDensity: 0.0038,
    exposure: 1.05,
    contrast: 1.12,
    bloomWeight: 0.16,
    glowIntensity: 0.55,
    vignetteWeight: 1.2,
    godRayDensity: 0.45,
    godRayWeight: 0.25,
    godRayColor: Color3.FromHexString('#ffe9bf'),
    ssaoStrength: 0.9,
    hazardMix: 0,
    fireflies: 1,
    pollen: 1,
    embers: 0,
    ash: 0,
  },
  volcanic: {
    name: 'volcanic',
    skyZenith: Color3.FromHexString('#1c0f0c'),
    skyHorizon: Color3.FromHexString('#6e331a'),
    skyGround: Color3.FromHexString('#24110c'),
    sunColor: Color3.FromHexString('#ff8a30'),
    sunDiscSize: 0.996,
    hazeStrength: 0.7,
    cloudColor: Color3.FromHexString('#1e1310'),
    cloudUnderGlow: Color3.FromHexString('#c9501a'),
    cloudCover: 0.6,
    envIntensity: 0.5,
    sunDir: { x: -0.62, y: -0.36, z: 0.7 },
    sunIntensity: 1.15,
    hemiColor: Color3.FromHexString('#5a3028'),
    hemiGround: Color3.FromHexString('#6e2810'),
    hemiIntensity: 0.45,
    ambient: new Color3(0.2, 0.11, 0.08),
    clearColor: Color3.FromHexString('#2c1510'),
    fogColor: Color3.FromHexString('#4a2416'),
    fogDensity: 0.0042,
    exposure: 1.1,
    contrast: 1.16,
    bloomWeight: 0.2,
    glowIntensity: 0.5,
    vignetteWeight: 1.5,
    godRayDensity: 0.55,
    godRayWeight: 0.32,
    godRayColor: Color3.FromHexString('#ff7a2a'),
    ssaoStrength: 1.1,
    hazardMix: 1,
    fireflies: 0,
    pollen: 0,
    embers: 1,
    ash: 1,
  },
};

export function themeForHazard(kind: string): ThemeName {
  return kind === 'lava' ? 'volcanic' : 'serene';
}

/** Deterministic small hash for cosmetic variation (never affects anything authoritative). */
export function hash01(s: string, seed = 0): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Seeded PRNG (mulberry32) over a string id, so cosmetic scatter is stable between rebuilds. */
export function seededRandom(s: string, seed = 0): () => number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
