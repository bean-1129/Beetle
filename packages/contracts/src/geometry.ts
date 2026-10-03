// Pure helpers shared by generator, validator, server and client. No I/O.
export type Vec2 = { x: number; z: number };

export const COORDINATES = {
  walkPlane: 'XZ',
  up: 'Y',
  north: '+Z',
  east: '+X',
  units: 'metres',
  origin: 'world centre',
} as const;

export type CompassName =
  | 'centre' | 'north' | 'north-east' | 'east' | 'south-east'
  | 'south' | 'south-west' | 'west' | 'north-west';

/** Compass octant of a point relative to a reference (default: world origin). Published naming convention. */
export function compassName(p: Vec2, ref: Vec2 = { x: 0, z: 0 }, centreRadius = 6): CompassName {
  const dx = p.x - ref.x;
  const dz = p.z - ref.z;
  if (Math.hypot(dx, dz) < centreRadius) return 'centre';
  // angle measured from +X (east) toward +Z (north)
  const a = ((Math.atan2(dz, dx) * 180) / Math.PI + 360) % 360;
  const names: CompassName[] = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return names[Math.round(a / 45) % 8];
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Deterministic canonical JSON (sorted keys) for digests and snapshot comparison. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
