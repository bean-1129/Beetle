// Pure helpers over a WorldSpec for integration tests: world positions, island graph, bridge routing.
// Mirrors the published coordinate convention (X/Z walk plane, islands are discs, bridges are rectangles
// between rim points). No dependency on packages/world so the tests stay independent of its internals.
import type { Bridge, Island, Relic, Vec2, WorldSpec } from '@beetle/contracts';

export function islandOf(spec: WorldSpec, id: string): Island {
  const island = spec.islands.find((i) => i.id === id);
  if (!island) throw new Error(`island ${id} not in spec`);
  return island;
}

export function bridgeOf(spec: WorldSpec, id: string): Bridge {
  const bridge = spec.bridges.find((b) => b.id === id);
  if (!bridge) throw new Error(`bridge ${id} not in spec`);
  return bridge;
}

/** Island centre + local offset (only islands support objects in v1). */
export function worldPos(spec: WorldSpec, surfaceId: string, local: Vec2): Vec2 {
  const island = islandOf(spec, surfaceId);
  return { x: island.center.x + local.x, z: island.center.z + local.z };
}

export function spawnFor(spec: WorldSpec, slot: 0 | 1) {
  const spawn = spec.spawns.find((s) => s.playerSlot === slot) ?? spec.spawns[slot];
  if (!spawn) throw new Error(`no spawn for slot ${slot}`);
  return { spawn, pos: worldPos(spec, spawn.supportingSurfaceId, spawn.localPosition), island: islandOf(spec, spawn.supportingSurfaceId) };
}

export function relicPos(spec: WorldSpec, relicId: string): Vec2 {
  const relic = spec.relics.find((r) => r.id === relicId);
  if (!relic) throw new Error(`relic ${relicId} not in spec`);
  return worldPos(spec, relic.supportingSurfaceId, relic.localPosition);
}

export function relicIsland(spec: WorldSpec, relic: Relic): Island {
  return islandOf(spec, relic.supportingSurfaceId);
}

export function gatePos(spec: WorldSpec): Vec2 {
  return worldPos(spec, spec.gate.supportingSurfaceId, spec.gate.localPosition);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function islandContains(island: Island, p: Vec2, margin = 0): boolean {
  return dist(island.center, p) <= island.radius - margin;
}

/** The island whose disc contains p, else the island with the smallest distance to its rim. */
export function islandNear(spec: WorldSpec, p: Vec2): Island {
  let best: Island | null = null;
  let bestGap = Infinity;
  for (const island of spec.islands) {
    const gap = dist(island.center, p) - island.radius;
    if (gap < bestGap) {
      bestGap = gap;
      best = island;
    }
  }
  if (!best) throw new Error('spec has no islands');
  return best;
}

export function bridgesTouching(spec: WorldSpec, islandId: string): Bridge[] {
  return spec.bridges.filter((b) => b.endpoints[0].islandId === islandId || b.endpoints[1].islandId === islandId);
}

export function otherEnd(bridge: Bridge, islandId: string): string {
  return bridge.endpoints[0].islandId === islandId ? bridge.endpoints[1].islandId : bridge.endpoints[0].islandId;
}

export function endpointOn(bridge: Bridge, islandId: string): Vec2 {
  const ep = bridge.endpoints.find((e) => e.islandId === islandId);
  if (!ep) throw new Error(`bridge ${bridge.id} does not touch island ${islandId}`);
  return ep.point;
}

export function bridgeMidpoint(bridge: Bridge): Vec2 {
  const [a, b] = bridge.endpoints;
  return { x: (a.point.x + b.point.x) / 2, z: (a.point.z + b.point.z) / 2 };
}

export function bridgeLength(bridge: Bridge): number {
  return dist(bridge.endpoints[0].point, bridge.endpoints[1].point);
}

/** Point moved `by` metres from p toward `toward`. */
export function moveToward(p: Vec2, toward: Vec2, by: number): Vec2 {
  const d = dist(p, toward);
  if (d < 1e-9) return { ...p };
  return { x: p.x + ((toward.x - p.x) / d) * by, z: p.z + ((toward.z - p.z) / d) * by };
}

export type RouteLeg = { bridge: Bridge; from: Island; to: Island };

/** BFS over the island graph. Returns the bridges to cross, or null when disconnected. */
export function islandRoute(spec: WorldSpec, fromId: string, toId: string, opts: { excludeBridgeIds?: string[] } = {}): RouteLeg[] | null {
  if (fromId === toId) return [];
  const excluded = new Set(opts.excludeBridgeIds ?? []);
  const prev = new Map<string, RouteLeg>();
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const bridge of bridgesTouching(spec, cur)) {
      if (excluded.has(bridge.id)) continue;
      const next = otherEnd(bridge, cur);
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, { bridge, from: islandOf(spec, cur), to: islandOf(spec, next) });
      if (next === toId) {
        const legs: RouteLeg[] = [];
        let at = toId;
        while (at !== fromId) {
          const leg = prev.get(at)!;
          legs.unshift(leg);
          at = leg.from.id;
        }
        return legs;
      }
      queue.push(next);
    }
  }
  return null;
}

/** Islands that matter for playability: spawn islands, relic islands and the gate island. */
export function importantIslandIds(spec: WorldSpec): string[] {
  const ids = new Set<string>();
  for (const s of spec.spawns) ids.add(s.supportingSurfaceId);
  for (const r of spec.relics) ids.add(r.supportingSurfaceId);
  ids.add(spec.gate.supportingSurfaceId);
  return [...ids];
}

/** True when every important island still reaches every other one without the given bridge. */
export function isBridgeRemovable(spec: WorldSpec, bridgeId: string): boolean {
  const ids = importantIslandIds(spec);
  for (let i = 1; i < ids.length; i++) {
    if (!islandRoute(spec, ids[0], ids[i], { excludeBridgeIds: [bridgeId] })) return false;
  }
  return true;
}

/** Bridges on the spawn island of `slot`, nearest to the spawn first. */
export function bridgesFromSpawn(spec: WorldSpec, slot: 0 | 1): Bridge[] {
  const { pos, island } = spawnFor(spec, slot);
  return bridgesTouching(spec, island.id).sort((a, b) => dist(endpointOn(a, island.id), pos) - dist(endpointOn(b, island.id), pos));
}

/** Relics not yet collected, ordered by island-hop count then straight distance from `from`. */
export function relicsByRouteLength(spec: WorldSpec, from: Vec2, collected: string[] = []): { relic: Relic; hops: number; pos: Vec2 }[] {
  const fromIsland = islandNear(spec, from);
  const out: { relic: Relic; hops: number; pos: Vec2 }[] = [];
  for (const relic of spec.relics) {
    if (collected.includes(relic.id)) continue;
    const route = islandRoute(spec, fromIsland.id, relic.supportingSurfaceId);
    if (!route) continue;
    out.push({ relic, hops: route.length, pos: relicPos(spec, relic.id) });
  }
  return out.sort((a, b) => a.hops - b.hops || dist(from, a.pos) - dist(from, b.pos));
}

/** Compass octant name of a point (same convention as contracts.compassName). */
export function isNorthern(p: Vec2): boolean {
  return p.z > 0 && Math.abs(p.z) >= Math.abs(p.x);
}

/** A bridge "touches" an island when one endpoint references it or lies within socketTolerance of its rim. */
export function bridgeTouchesIsland(bridge: Bridge, island: Island, tolerance = 0.5): boolean {
  if (bridge.endpoints.some((e) => e.islandId === island.id)) return true;
  return bridge.endpoints.some((e) => Math.abs(dist(e.point, island.center) - island.radius) <= tolerance);
}
