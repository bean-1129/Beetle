import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';

// One cohesive palette: pale stone, teal-leaning greens (hue ~140), teal-blue water (~195-205): an analogous
// family within ~65 degrees, with amber (hue ~40) reserved for interactive focus (lanterns, relics, gates, players).
export const PALETTE = {
  clear: new Color4(0.34, 0.55, 0.6, 1), // kept for compatibility; the live clear colour comes from the active theme
  stoneTop: Color3.FromHexString('#ebe5d6'),
  stoneSide: Color3.FromHexString('#bfb49b'),
  stoneRim: Color3.FromHexString('#a89d84'),
  stoneDark: Color3.FromHexString('#857c67'),
  grass: Color3.FromHexString('#6fba86'),
  grassDark: Color3.FromHexString('#4f9c6a'),
  wood: Color3.FromHexString('#8c5a2b'),
  woodLight: Color3.FromHexString('#b8783a'),
  plankA: Color3.FromHexString('#a3672f'),
  plankB: Color3.FromHexString('#8e5727'),
  rope: Color3.FromHexString('#e2d2ad'),
  trunk: Color3.FromHexString('#6b4423'),
  leaves: Color3.FromHexString('#3f9d62'),
  leavesDark: Color3.FromHexString('#2f7a4c'),
  bush: Color3.FromHexString('#4fae72'),
  rock: Color3.FromHexString('#8a8f8c'),
  lanternPost: Color3.FromHexString('#4a3a2a'),
  lanternGlow: Color3.FromHexString('#ffd27f'),
  amber: Color3.FromHexString('#f0b45a'),
  amberBright: Color3.FromHexString('#ffd27f'),
  relic: Color3.FromHexString('#ffc85c'),
  relicHalo: Color3.FromHexString('#ffd98a'),
  gateLocked: Color3.FromHexString('#7a7467'),
  gateUnlocked: Color3.FromHexString('#f0b45a'),
  water: Color3.FromHexString('#4aa6cf'),
  waterDeep: Color3.FromHexString('#1f6a94'),
  lava: Color3.FromHexString('#ff5a36'),
  lavaDeep: Color3.FromHexString('#a3260f'),
  lavaGlow: Color3.FromHexString('#ff7a3a'),
  lavaCrust: Color3.FromHexString('#ffb050'),
  shadow: Color3.FromHexString('#0b1a1c'),
  label: '#f4f7f5',
} as const;

/**
 * A theme is a biome preset with an optional lava hazard overlay. 'serene' / 'volcanic' are the garden biome with a
 * water / lava hazard (the original pair); the other biomes carry their lava variant as '<biome>_lava'.
 */
export type BiomeName = 'garden' | 'volcanic' | 'frost' | 'desert' | 'night';
export type ThemeName = 'serene' | 'volcanic' | 'frost' | 'desert' | 'night' | 'frost_lava' | 'desert_lava' | 'night_lava';
export const THEME_NAMES: readonly ThemeName[] = ['serene', 'volcanic', 'frost', 'desert', 'night', 'frost_lava', 'desert_lava', 'night_lava'];

/**
 * Everything the environment blends between themes. Colours are linear-ish sRGB values picked for ACES tone
 * mapping (slightly brighter than they would be for a plain clear colour).
 */
export type ThemeParams = {
  name: ThemeName;
  /** Biome the preset derives from (drives geometry material looks). */
  biome: BiomeName;
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
  moon: number;             // 0..1: the sun disc is drawn as a moon (pale disc, faint craters), glow damped
  stars: number;            // 0..1 star field strength in the sky shader
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
  // hazard surface: 0 = water shader, 1 = lava shader; water tints per biome
  hazardMix: number;
  waterShallow: Color3;
  waterDeep: Color3;
  /** Emissive multiplier for lanterns, relics and other small lights (night: stronger). */
  lightBoost: number;
  // particles
  fireflies: number; // 0..1 weight
  pollen: number;
  embers: number;
  ash: number;
  snow: number;
  shimmer: number;
};

const hex = (h: string) => Color3.FromHexString(h);

const serene: ThemeParams = {
  name: 'serene',
  biome: 'garden',
  skyZenith: hex('#3a7db5'),
  skyHorizon: hex('#8cc6e3'),
  skyGround: hex('#3f7f9c'),
  sunColor: hex('#fff1cf'),
  sunDiscSize: 0.9975,
  hazeStrength: 0.4,
  cloudColor: hex('#f7f9fb'),
  cloudUnderGlow: hex('#d9e4ee'),
  cloudCover: 0.3,
  envIntensity: 0.7,
  moon: 0,
  stars: 0,
  sunDir: { x: 0.46, y: -0.76, z: 0.42 },
  sunIntensity: 1.4,
  hemiColor: hex('#bcd4ec'),
  hemiGround: hex('#345259'),
  hemiIntensity: 0.7,
  ambient: new Color3(0.16, 0.2, 0.23),
  clearColor: hex('#78b7cf'),
  fogColor: hex('#93c6dc'),
  fogDensity: 0.0052,
  exposure: 1.05,
  contrast: 1.12,
  bloomWeight: 0.16,
  glowIntensity: 0.55,
  vignetteWeight: 1.2,
  godRayDensity: 0.45,
  godRayWeight: 0.25,
  godRayColor: hex('#ffe9bf'),
  ssaoStrength: 0.9,
  hazardMix: 0,
  waterShallow: hex('#5cbfdd'),
  waterDeep: hex('#1a5577'),
  lightBoost: 1,
  fireflies: 1,
  pollen: 1,
  embers: 0,
  ash: 0,
  snow: 0,
  shimmer: 0,
};

const volcanic: ThemeParams = {
  name: 'volcanic',
  biome: 'volcanic',
  skyZenith: hex('#1c0f0c'),
  skyHorizon: hex('#6e331a'),
  skyGround: hex('#24110c'),
  sunColor: hex('#ff8a30'),
  sunDiscSize: 0.996,
  hazeStrength: 0.7,
  cloudColor: hex('#1e1310'),
  cloudUnderGlow: hex('#c9501a'),
  cloudCover: 0.6,
  envIntensity: 0.5,
  moon: 0,
  stars: 0,
  sunDir: { x: 0.6, y: -0.4, z: 0.68 },
  sunIntensity: 1.1,
  hemiColor: hex('#4e3c4a'),
  hemiGround: hex('#6e2810'),
  hemiIntensity: 0.55,
  ambient: new Color3(0.2, 0.11, 0.08),
  clearColor: hex('#2c1510'),
  fogColor: hex('#4a2416'),
  fogDensity: 0.0052,
  exposure: 1.1,
  contrast: 1.16,
  bloomWeight: 0.2,
  glowIntensity: 0.5,
  vignetteWeight: 1.4,
  godRayDensity: 0.55,
  godRayWeight: 0.32,
  godRayColor: hex('#ff7a2a'),
  ssaoStrength: 1.1,
  hazardMix: 1,
  waterShallow: hex('#5cbfdd'),
  waterDeep: hex('#1a5577'),
  lightBoost: 1.1,
  fireflies: 0,
  pollen: 0,
  embers: 1,
  ash: 1,
  snow: 0,
  shimmer: 0,
};

// pale blue-white sky, low cold sun, dense cool fog, icy water, falling snow
const frost: ThemeParams = {
  name: 'frost',
  biome: 'frost',
  skyZenith: hex('#7fa7cf'),
  skyHorizon: hex('#dfe9f2'),
  skyGround: hex('#8ea6b8'),
  sunColor: hex('#f4f0e6'),
  sunDiscSize: 0.997,
  hazeStrength: 0.75,
  cloudColor: hex('#e9eef4'),
  cloudUnderGlow: hex('#c2cfdc'),
  cloudCover: 0.5,
  envIntensity: 0.8,
  moon: 0,
  stars: 0,
  sunDir: { x: 0.66, y: -0.36, z: 0.66 },
  sunIntensity: 1.1,
  hemiColor: hex('#d4e2f0'),
  hemiGround: hex('#6f8597'),
  hemiIntensity: 0.55,
  ambient: new Color3(0.2, 0.23, 0.27),
  clearColor: hex('#c5d6e3'),
  fogColor: hex('#cfdde8'),
  fogDensity: 0.0072,
  exposure: 1.0,
  contrast: 1.06,
  bloomWeight: 0.12,
  glowIntensity: 0.45,
  vignetteWeight: 1.1,
  godRayDensity: 0.4,
  godRayWeight: 0.18,
  godRayColor: hex('#eef2f8'),
  ssaoStrength: 0.8,
  hazardMix: 0,
  waterShallow: hex('#9fd6e6'),
  waterDeep: hex('#1f5f80'),
  lightBoost: 1.05,
  fireflies: 0,
  pollen: 0,
  embers: 0,
  ash: 0,
  snow: 1,
  shimmer: 0,
};

// warm sand sky, hot high sun, thin dusty haze, turquoise water, sparse heat shimmer
const desert: ThemeParams = {
  name: 'desert',
  biome: 'desert',
  skyZenith: hex('#7fa3b4'),
  skyHorizon: hex('#ead8b0'),
  skyGround: hex('#b08a5a'),
  sunColor: hex('#fff6dc'),
  sunDiscSize: 0.998,
  hazeStrength: 0.55,
  cloudColor: hex('#fbf6ec'),
  cloudUnderGlow: hex('#e8d2ad'),
  cloudCover: 0.12,
  envIntensity: 0.85,
  moon: 0,
  stars: 0,
  sunDir: { x: 0.4, y: -0.82, z: 0.4 },
  sunIntensity: 1.7,
  hemiColor: hex('#cfd9e0'),
  hemiGround: hex('#8a6a42'),
  hemiIntensity: 0.85,
  ambient: new Color3(0.24, 0.21, 0.17),
  clearColor: hex('#d9c9a4'),
  fogColor: hex('#e3d2ad'),
  fogDensity: 0.004,
  exposure: 1.08,
  contrast: 1.14,
  bloomWeight: 0.14,
  glowIntensity: 0.45,
  vignetteWeight: 1.1,
  godRayDensity: 0.4,
  godRayWeight: 0.2,
  godRayColor: hex('#fff0cc'),
  ssaoStrength: 0.9,
  hazardMix: 0,
  waterShallow: hex('#66cfc0'),
  waterDeep: hex('#1f6e78'),
  lightBoost: 0.9,
  fireflies: 0,
  pollen: 0.4,
  embers: 0,
  ash: 0,
  snow: 0,
  shimmer: 1,
};

// deep indigo sky with a moon and stars, cool rim light, dense fireflies, stronger lantern/relic glow
const night: ThemeParams = {
  name: 'night',
  biome: 'night',
  skyZenith: hex('#07091f'),
  skyHorizon: hex('#1c2550'),
  skyGround: hex('#0a0e22'),
  sunColor: hex('#cfdcf5'),
  sunDiscSize: 0.9985,
  hazeStrength: 0.35,
  cloudColor: hex('#141a33'),
  cloudUnderGlow: hex('#263258'),
  cloudCover: 0.22,
  envIntensity: 0.35,
  moon: 1,
  stars: 1,
  sunDir: { x: 0.5, y: -0.62, z: 0.6 },
  sunIntensity: 0.6,
  hemiColor: hex('#3a4a7a'),
  hemiGround: hex('#141a2c'),
  hemiIntensity: 0.3,
  ambient: new Color3(0.08, 0.1, 0.16),
  clearColor: hex('#0c1026'),
  fogColor: hex('#141c3a'),
  fogDensity: 0.0055,
  exposure: 1.0,
  contrast: 1.18,
  bloomWeight: 0.3,
  glowIntensity: 0.85,
  vignetteWeight: 1.4,
  godRayDensity: 0.35,
  godRayWeight: 0.14,
  godRayColor: hex('#aebcec'),
  ssaoStrength: 1.0,
  hazardMix: 0,
  waterShallow: hex('#1b3b5a'),
  waterDeep: hex('#050c1a'),
  lightBoost: 1.8,
  fireflies: 1,
  pollen: 0,
  embers: 0,
  ash: 0,
  snow: 0,
  shimmer: 0,
};

/** Lava hazard overlay on top of a biome: lava surface, crust rings, embers, warm fog and under-lit clouds. */
export function withLava(base: ThemeParams, name: ThemeName): ThemeParams {
  const warmFog = hex('#5a2a18');
  const L = (a: Color3, b: Color3, t: number) => Color3.Lerp(a, b, t);
  return {
    ...base,
    name,
    skyHorizon: L(base.skyHorizon, hex('#8a4020'), 0.3),
    skyGround: L(base.skyGround, hex('#24110c'), 0.5),
    cloudUnderGlow: L(base.cloudUnderGlow, hex('#c9501a'), 0.6),
    cloudCover: Math.min(1, base.cloudCover + 0.15),
    hemiGround: L(base.hemiGround, hex('#6e2810'), 0.6),
    ambient: L(base.ambient, new Color3(0.2, 0.11, 0.08), 0.5),
    clearColor: L(base.clearColor, warmFog, 0.4),
    fogColor: L(base.fogColor, warmFog, 0.45),
    fogDensity: base.fogDensity * 1.1,
    bloomWeight: base.bloomWeight + 0.04,
    glowIntensity: base.glowIntensity + 0.05,
    vignetteWeight: Math.min(1.4, base.vignetteWeight + 0.15),
    godRayColor: L(base.godRayColor, hex('#ff7a2a'), 0.5),
    ssaoStrength: base.ssaoStrength + 0.1,
    hazardMix: 1,
    lightBoost: base.lightBoost * 1.05,
    pollen: 0,
    embers: 1,
    ash: 0.5,
    snow: base.snow * 0.4,
    shimmer: Math.max(base.shimmer, 0.5),
  };
}

export const THEMES: Record<ThemeName, ThemeParams> = {
  serene,
  volcanic,
  frost,
  desert,
  night,
  frost_lava: withLava(frost, 'frost_lava'),
  desert_lava: withLava(desert, 'desert_lava'),
  night_lava: withLava(night, 'night_lava'),
};

export function themeForHazard(kind: string): ThemeName {
  return kind === 'lava' ? 'volcanic' : 'serene';
}

/** Theme for a biome + hazard pair. Unknown biomes fall back to the garden pair. */
export function themeFor(biome: string | undefined, hazardKind: string): ThemeName {
  const lava = hazardKind === 'lava';
  switch (biome) {
    case 'frost': return lava ? 'frost_lava' : 'frost';
    case 'desert': return lava ? 'desert_lava' : 'desert';
    case 'night': return lava ? 'night_lava' : 'night';
    case 'volcanic': return 'volcanic';
    default: return lava ? 'volcanic' : 'serene';
  }
}

/** 1 when the theme carries the lava hazard overlay. */
export function lavaOf(theme: ThemeName): number {
  return theme === 'volcanic' || theme.endsWith('_lava') ? 1 : 0;
}

/** Biome a theme derives from. */
export function biomeOf(theme: ThemeName): BiomeName {
  return THEMES[theme]?.biome ?? 'garden';
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
