// Pure 2D helpers on the X/Z walk plane. No I/O, no state.
import type { Vec2 } from '@beetle/contracts';

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function len(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

export function unit(v: Vec2): Vec2 {
  const l = len(v);
  return l === 0 ? { x: 0, z: 0 } : { x: v.x / l, z: v.z / l };
}

/** Distance from point p to segment ab, plus the clamped parameter t in [0, 1]. */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2): { dist: number; t: number } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  if (l2 === 0) return { dist: Math.hypot(p.x - a.x, p.z - a.z), t: 0 };
  let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + abx * t;
  const cz = a.z + abz * t;
  return { dist: Math.hypot(p.x - cx, p.z - cz), t };
}

/** Rim point of a disc (centre c, radius r) in the direction of target. */
export function rimPointToward(c: Vec2, r: number, target: Vec2): Vec2 {
  const u = unit(sub(target, c));
  return { x: c.x + u.x * r, z: c.z + u.z * r };
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
