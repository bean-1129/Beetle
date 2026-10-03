import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';

// One cohesive palette: pale stone, soft greens, clear teal-blue water, warm amber accents.
export const PALETTE = {
  clear: new Color4(0.34, 0.55, 0.6, 1), // desaturated teal-blue sky, sits between the water and the pale stone
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
