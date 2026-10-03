import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';

export const PALETTE = {
  clear: new Color4(0.055, 0.165, 0.184, 1), // deep blue-green
  stoneTop: Color3.FromHexString('#e9e3d3'),
  stoneSide: Color3.FromHexString('#b8ae95'),
  stoneDark: Color3.FromHexString('#8f866f'),
  wood: Color3.FromHexString('#8c5a2b'),
  woodLight: Color3.FromHexString('#b8783a'),
  rope: Color3.FromHexString('#d9c7a0'),
  trunk: Color3.FromHexString('#6b4423'),
  leaves: Color3.FromHexString('#3f9d4f'),
  leavesDark: Color3.FromHexString('#2f7a3c'),
  bush: Color3.FromHexString('#4fae5c'),
  rock: Color3.FromHexString('#7f8a8c'),
  lanternPost: Color3.FromHexString('#4a3a2a'),
  lanternGlow: Color3.FromHexString('#ffd27f'),
  amber: Color3.FromHexString('#f0b45a'),
  amberBright: Color3.FromHexString('#ffd27f'),
  relic: Color3.FromHexString('#ffc85c'),
  gateLocked: Color3.FromHexString('#6f6a5e'),
  gateUnlocked: Color3.FromHexString('#f0b45a'),
  water: Color3.FromHexString('#3aa0d8'),
  waterDeep: Color3.FromHexString('#1f6f9c'),
  lava: Color3.FromHexString('#ff5a36'),
  lavaDeep: Color3.FromHexString('#a3260f'),
  lavaGlow: Color3.FromHexString('#ff7a3a'),
  label: '#eef3f1',
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
