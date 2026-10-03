// World compiler: WorldSpec to surfaces, obstacles, support/blocking queries, nav grid, render hints and digest.
// Deterministic for identical spec + COMPILER_VERSION. Render hints come from a separate seeded stream and never touch colliders.
import {
  COMPILER_VERSION, DECORATION_RADIUS, GEOMETRY, canonicalJson, compassName, type Vec2, type WorldSpec,
} from '@beetle/contracts';
import type { BridgeSurface, CompiledWorld, IslandSurface, Obstacle, Surface } from './types.ts';
import { buildNavGrid } from './nav.ts';
import { seededRandom } from './prng.ts';
import { sha256Hex } from './digest.ts';

const PR = GEOMETRY.playerRadius;
// A bridge rectangle is extended by the socket tolerance at both ends so a tolerated endpoint gap never leaves an unsupported sliver.
const BRIDGE_END_EXTENSION = GEOMETRY.socketTolerance;

export function islandDisplayName(spec: WorldSpec, index: number): string {
  const island = spec.islands[index];
  if (island.name && island.name.trim().length > 0) return island.name;
  return `${compassName(island.center)} island ${index}`;
}

export function compileWorld(spec: WorldSpec): CompiledWorld {
  const islands: IslandSurface[] = spec.islands.map((is, i) => ({
    id: is.id,
    kind: 'island',
    center: { x: is.center.x, z: is.center.z },
    radius: is.radius,
    name: islandDisplayName(spec, i),
    compass: compassName(is.center),
  }));
  const islandById = new Map<string, IslandSurface>();
  for (const is of islands) if (!islandById.has(is.id)) islandById.set(is.id, is);

  const bridges: BridgeSurface[] = spec.bridges.map((b) => {
    const a = { x: b.endpoints[0].point.x, z: b.endpoints[0].point.z };
    const bb = { x: b.endpoints[1].point.x, z: b.endpoints[1].point.z };
    return {
      id: b.id,
      kind: 'bridge',
      a,
      b: bb,
      width: b.width,
      length: Math.hypot(bb.x - a.x, bb.z - a.z),
      islandIds: [b.endpoints[0].islandId, b.endpoints[1].islandId],
    };
  });
  const surfaces: Surface[] = [...islands, ...bridges];

  function worldPos(surfaceId: string, local: Vec2): Vec2 | null {
    const is = islandById.get(surfaceId);
    if (!is) return null;
    return { x: is.center.x + local.x, z: is.center.z + local.z };
  }

  const obstacles: Obstacle[] = [];
  for (const d of spec.decorations) {
    const p = worldPos(d.supportingSurfaceId, d.localPosition);
    if (!p) continue; // unknown surface: reported by the validator as INVALID_REFERENCE, not a collider
    obstacles.push({ id: d.id, kind: 'decoration', x: p.x, z: p.z, r: DECORATION_RADIUS[d.type] * d.scale, type: d.type });
  }
  const gatePos = worldPos(spec.gate.supportingSurfaceId, spec.gate.localPosition);
  if (gatePos) obstacles.push({ id: spec.gate.id, kind: 'gate', x: gatePos.x, z: gatePos.z, r: GEOMETRY.gateBlockRadius });
  const gateId = gatePos ? spec.gate.id : null;

  // Precomputed bridge frames for fast point-in-rectangle tests.
  const bridgeFrames = bridges.map((b) => {
    const dx = b.b.x - b.a.x;
    const dz = b.b.z - b.a.z;
    const L = b.length;
    const ux = L === 0 ? 1 : dx / L;
    const uz = L === 0 ? 0 : dz / L;
    const half = b.width / 2;
    const reach = Math.max(Math.abs(dx), Math.abs(dz)) / 2 + half + BRIDGE_END_EXTENSION;
    return { id: b.id, ax: b.a.x, az: b.a.z, ux, uz, L, half, midX: (b.a.x + b.b.x) / 2, midZ: (b.a.z + b.b.z) / 2, reach };
  });

  function supportAt(x: number, z: number): string | null {
    for (const is of islands) {
      const dx = x - is.center.x;
      if (dx > is.radius || dx < -is.radius) continue;
      const dz = z - is.center.z;
      if (dz > is.radius || dz < -is.radius) continue;
      if (dx * dx + dz * dz <= is.radius * is.radius) return is.id;
    }
    for (const f of bridgeFrames) {
      if (Math.abs(x - f.midX) > f.reach || Math.abs(z - f.midZ) > f.reach) continue;
      const px = x - f.ax;
      const pz = z - f.az;
      const along = px * f.ux + pz * f.uz;
      if (along < -BRIDGE_END_EXTENSION || along > f.L + BRIDGE_END_EXTENSION) continue;
      const across = Math.abs(px * f.uz - pz * f.ux);
      if (across <= f.half) return f.id;
    }
    return null;
  }

  function blockedAt(x: number, z: number, opts: { gateOpen: boolean }): string | null {
    for (const o of obstacles) {
      if (o.kind === 'gate' && opts.gateOpen) continue;
      const rr = o.r + PR;
      const dx = x - o.x;
      if (dx > rr || dx < -rr) continue;
      const dz = z - o.z;
      if (dz > rr || dz < -rr) continue;
      if (dx * dx + dz * dz < rr * rr) return o.id;
    }
    return null;
  }

  function fits(x: number, z: number, opts: { gateOpen: boolean }): boolean {
    if (blockedAt(x, z, opts) !== null) return false;
    return (
      supportAt(x, z) !== null &&
      supportAt(x + PR, z) !== null &&
      supportAt(x - PR, z) !== null &&
      supportAt(x, z + PR) !== null &&
      supportAt(x, z - PR) !== null
    );
  }

  const nav = buildNavGrid(fits, blockedAt, gateId);

  const structuralDigest = sha256Hex(canonicalJson({ compilerVersion: COMPILER_VERSION, surfaces, obstacles }));

  return {
    spec,
    compilerVersion: COMPILER_VERSION,
    surfaces,
    obstacles,
    worldPos,
    supportAt,
    blockedAt,
    fits,
    nav,
    renderHints: buildRenderHints(spec),
    structuralDigest,
  };
}

/** Cosmetic only. Separate mulberry32 stream over spec.seed; consumed in a fixed order so hints are deterministic. */
function buildRenderHints(spec: WorldSpec): Record<string, unknown> {
  const rng = seededRandom(spec.seed);
  const islands: Record<string, { hueShift: number; grassDensity: number; rimWear: number }> = {};
  for (const is of spec.islands) {
    islands[is.id] = { hueShift: r3(rng() * 20 - 10), grassDensity: r3(0.4 + rng() * 0.6), rimWear: r3(rng()) };
  }
  const decorations: Record<string, { jitterDeg: number; tiltDeg: number; variant: number; sway: number }> = {};
  for (const d of spec.decorations) {
    decorations[d.id] = { jitterDeg: r3(rng() * 360), tiltDeg: r3(rng() * 6 - 3), variant: Math.floor(rng() * 4), sway: r3(0.5 + rng() * 0.5) };
  }
  const bridges: Record<string, { plankVariant: number; wear: number }> = {};
  for (const b of spec.bridges) {
    bridges[b.id] = { plankVariant: Math.floor(rng() * 3), wear: r3(rng()) };
  }
  return { seed: spec.seed, islands, decorations, bridges, hazardRipplePhase: r3(rng() * Math.PI * 2) };
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
