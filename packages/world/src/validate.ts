// Full validator pipeline from docs/ARCHITECTURE.md. Order matters; only INVALID_SCHEMA short-circuits.
import {
  DECORATION_RADIUS, GEOMETRY, WORLD_LIMITS, WorldSpecSchema, dist,
  type ValidationIssue, type Vec2, type WorldSpec,
} from '@beetle/contracts';
import type { CompiledWorld, LiveContext, ValidationOutcome } from './types.ts';
import { compileWorld } from './compile.ts';
import { pointSegment, round3 } from './geom.ts';
import { flood, nearestWalkable, reachedGoal, type Flood } from './nav.ts';

const PR = GEOMETRY.playerRadius;
const ISLAND_MIN_GAP = 1.0;
const SNAP_RADIUS = 1.0;
const MIN_BRIDGE_WIDTH = 2 * PR + 0.2;
// Derived endpoints are rounded to 3 decimals, so a bridge between islands exactly ISLAND_MIN_GAP apart can measure
// 0.9996 m on a diagonal. Length limits are compared with this slack so rounding never flips a valid bridge.
const LENGTH_EPS = 0.005;
const H = WORLD_LIMITS.bounds.halfExtent;

export function issue(code: ValidationIssue['code'], message: string, objectIds: string[] = [], evidence?: Record<string, unknown>): ValidationIssue {
  const out: ValidationIssue = { code, message: message.slice(0, 400), objectIds: objectIds.slice(0, 32).map((s) => s.slice(0, 64)) };
  if (evidence) out.evidence = evidence;
  return out;
}

export function zodIssuesToValidation(error: { issues: { path: (string | number)[]; message: string; code: string }[] }, limit = 32): ValidationIssue[] {
  return error.issues.slice(0, limit).map((zi) => {
    const path = zi.path.join('.');
    return issue('INVALID_SCHEMA', `${path || '(root)'}: ${zi.message}`, path ? [path] : [], { path: zi.path, zodCode: zi.code });
  });
}

export function validateSpec(input: unknown, ctx: LiveContext = {}): ValidationOutcome {
  const parsed = WorldSpecSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: zodIssuesToValidation(parsed.error) };
  }
  const spec = parsed.data;
  const issues: ValidationIssue[] = [];

  // 2. DUPLICATE_ID across all object ids
  const idKinds = new Map<string, string[]>();
  const noteId = (id: string, kind: string) => {
    const list = idKinds.get(id);
    if (list) list.push(kind); else idKinds.set(id, [kind]);
  };
  for (const o of spec.islands) noteId(o.id, 'island');
  for (const o of spec.bridges) noteId(o.id, 'bridge');
  for (const o of spec.spawns) noteId(o.id, 'spawn');
  for (const o of spec.relics) noteId(o.id, 'relic');
  noteId(spec.gate.id, 'gate');
  for (const o of spec.decorations) noteId(o.id, 'decoration');
  for (const [id, kinds] of idKinds) {
    if (kinds.length > 1) issues.push(issue('DUPLICATE_ID', `id "${id}" is used ${kinds.length} times (${kinds.join(', ')})`, [id], { kinds }));
  }

  // 2b. INVALID_REFERENCE
  const islandIds = new Set(spec.islands.map((i) => i.id));
  const bridgeIds = new Set(spec.bridges.map((b) => b.id));
  const relicIds = new Set(spec.relics.map((r) => r.id));
  const surfaceKnown = (id: string) => islandIds.has(id) || bridgeIds.has(id);
  const badSurfaceRef = (ownerId: string, kind: string, surfaceId: string) => {
    issues.push(issue('INVALID_REFERENCE', `${kind} "${ownerId}" references unknown surface "${surfaceId}"`, [ownerId, surfaceId], { kind, surfaceId }));
  };
  const placed = new Set<string>(); // object ids whose surface reference resolves
  for (const s of spec.spawns) { if (surfaceKnown(s.supportingSurfaceId)) placed.add(s.id); else badSurfaceRef(s.id, 'spawn', s.supportingSurfaceId); }
  for (const r of spec.relics) { if (surfaceKnown(r.supportingSurfaceId)) placed.add(r.id); else badSurfaceRef(r.id, 'relic', r.supportingSurfaceId); }
  if (surfaceKnown(spec.gate.supportingSurfaceId)) placed.add(spec.gate.id); else badSurfaceRef(spec.gate.id, 'gate', spec.gate.supportingSurfaceId);
  for (const d of spec.decorations) { if (surfaceKnown(d.supportingSurfaceId)) placed.add(d.id); else badSurfaceRef(d.id, 'decoration', d.supportingSurfaceId); }
  for (const rid of spec.gate.requiredRelicIds) {
    if (!relicIds.has(rid)) issues.push(issue('INVALID_REFERENCE', `gate "${spec.gate.id}" requires unknown relic "${rid}"`, [spec.gate.id, rid], { relicId: rid }));
  }
  const bridgeRefsOk = new Set<string>();
  for (const b of spec.bridges) {
    let ok = true;
    for (const ep of b.endpoints) {
      if (!islandIds.has(ep.islandId)) {
        ok = false;
        issues.push(issue('INVALID_REFERENCE', `bridge "${b.id}" endpoint references unknown island "${ep.islandId}"`, [b.id, ep.islandId], { islandId: ep.islandId }));
      }
    }
    if (ok) bridgeRefsOk.add(b.id);
  }

  const islandById = new Map(spec.islands.map((i) => [i.id, i] as const));

  // 3b. OUT_OF_BOUNDS: island discs and placed objects must lie inside the world bounds (the nav grid covers only ±H).
  for (const is of spec.islands) {
    const over = Math.max(Math.abs(is.center.x), Math.abs(is.center.z)) + is.radius - H;
    if (over > 0) {
      issues.push(issue('OUT_OF_BOUNDS', `island "${is.id}" extends ${round3(over)} m beyond the world bounds (±${H} m)`, [is.id], { overshoot: round3(over), halfExtent: H }));
    }
  }
  const checkInBounds = (id: string, kind: string, surfaceId: string, local: Vec2, radius: number) => {
    const island = islandById.get(surfaceId);
    if (!island) return;
    const x = island.center.x + local.x;
    const z = island.center.z + local.z;
    const over = Math.max(Math.abs(x), Math.abs(z)) + radius - H;
    if (over > 0) {
      issues.push(issue('OUT_OF_BOUNDS', `${kind} "${id}" extends ${round3(over)} m beyond the world bounds (±${H} m)`, [id, surfaceId], { overshoot: round3(over), position: { x: round3(x), z: round3(z) }, halfExtent: H }));
    }
  };
  for (const s of spec.spawns) checkInBounds(s.id, 'spawn', s.supportingSurfaceId, s.localPosition, PR);
  for (const r of spec.relics) checkInBounds(r.id, 'relic', r.supportingSurfaceId, r.localPosition, PR);
  checkInBounds(spec.gate.id, 'gate', spec.gate.supportingSurfaceId, spec.gate.localPosition, PR);
  for (const d of spec.decorations) checkInBounds(d.id, 'decoration', d.supportingSurfaceId, d.localPosition, DECORATION_RADIUS[d.type] * d.scale);

  // 4. ISLAND_OVERLAP
  for (let i = 0; i < spec.islands.length; i++) {
    for (let j = i + 1; j < spec.islands.length; j++) {
      const a = spec.islands[i];
      const b = spec.islands[j];
      const gap = dist(a.center, b.center) - a.radius - b.radius;
      if (gap < ISLAND_MIN_GAP) {
        issues.push(issue('ISLAND_OVERLAP', `islands "${a.id}" and "${b.id}" are ${round3(gap)} m apart; need at least ${ISLAND_MIN_GAP} m`, [a.id, b.id], { gap: round3(gap), required: ISLAND_MIN_GAP }));
      }
    }
  }

  // 5. OBJECT_NOT_ON_SURFACE (only islands support objects in v1)
  const checkOnIsland = (id: string, kind: string, surfaceId: string, local: Vec2, radius: number) => {
    if (!placed.has(id)) return;
    const island = islandById.get(surfaceId);
    if (!island) {
      issues.push(issue('OBJECT_NOT_ON_SURFACE', `${kind} "${id}" sits on "${surfaceId}", which is not an island; only islands hold objects`, [id, surfaceId], { surfaceId }));
      return;
    }
    const d = Math.hypot(local.x, local.z);
    if (d + radius > island.radius) {
      issues.push(issue('OBJECT_NOT_ON_SURFACE', `${kind} "${id}" is ${round3(d)} m from the centre of "${surfaceId}" (radius ${island.radius}); it needs distance + ${radius} <= ${island.radius}`, [id, surfaceId], { distance: round3(d), objectRadius: radius, islandRadius: island.radius, overshoot: round3(d + radius - island.radius) }));
    }
  };
  for (const s of spec.spawns) checkOnIsland(s.id, 'spawn', s.supportingSurfaceId, s.localPosition, PR);
  for (const r of spec.relics) checkOnIsland(r.id, 'relic', r.supportingSurfaceId, r.localPosition, PR);
  checkOnIsland(spec.gate.id, 'gate', spec.gate.supportingSurfaceId, spec.gate.localPosition, PR);
  for (const d of spec.decorations) checkOnIsland(d.id, 'decoration', d.supportingSurfaceId, d.localPosition, DECORATION_RADIUS[d.type] * d.scale);

  // 6. Bridge geometry
  for (const b of spec.bridges) {
    if (!bridgeRefsOk.has(b.id)) continue;
    const [e0, e1] = b.endpoints;
    if (e0.islandId === e1.islandId) {
      issues.push(issue('BRIDGE_ENDPOINT_GAP', `bridge "${b.id}" has both endpoints on island "${e0.islandId}"`, [b.id, e0.islandId], { sameIsland: e0.islandId }));
    }
    for (const ep of b.endpoints) {
      const island = islandById.get(ep.islandId)!;
      const gap = Math.abs(dist(island.center, ep.point) - island.radius);
      if (gap > GEOMETRY.socketTolerance) {
        issues.push(issue('BRIDGE_ENDPOINT_GAP', `bridge "${b.id}" endpoint is ${round3(gap)} m off the rim of island "${ep.islandId}" (tolerance ${GEOMETRY.socketTolerance} m)`, [b.id, ep.islandId], { gap: round3(gap), tolerance: GEOMETRY.socketTolerance, point: ep.point }));
      }
    }
    const length = dist(e0.point, e1.point);
    if (length < WORLD_LIMITS.bridge.minLength - LENGTH_EPS || length > WORLD_LIMITS.bridge.maxLength + LENGTH_EPS) {
      issues.push(issue('BRIDGE_LENGTH', `bridge "${b.id}" is ${round3(length)} m long; allowed ${WORLD_LIMITS.bridge.minLength} to ${WORLD_LIMITS.bridge.maxLength} m`, [b.id], { length: round3(length), min: WORLD_LIMITS.bridge.minLength, max: WORLD_LIMITS.bridge.maxLength }));
    }
    for (const island of spec.islands) {
      if (island.id === e0.islandId || island.id === e1.islandId) continue;
      const { dist: d } = pointSegment(island.center, e0.point, e1.point);
      if (d < island.radius) {
        issues.push(issue('BRIDGE_CROSSES_ISLAND', `bridge "${b.id}" passes through island "${island.id}" (${round3(d)} m from its centre, radius ${island.radius})`, [b.id, island.id], { distance: round3(d), radius: island.radius }));
      }
    }
    if (b.width < MIN_BRIDGE_WIDTH) {
      issues.push(issue('BRIDGE_TOO_NARROW', `bridge "${b.id}" is ${b.width} m wide; minimum ${round3(MIN_BRIDGE_WIDTH)} m`, [b.id], { width: b.width, min: round3(MIN_BRIDGE_WIDTH) }));
    }
  }

  // 7. Reachability with the gate locked
  const compiled = compileWorld(spec);
  const nav = compiled.nav;
  const collected = new Set(ctx.collectedRelicIds ?? []);
  const remainingRelics = spec.relics.filter((r) => !collected.has(r.id) && placed.has(r.id));
  const gatePos = placed.has(spec.gate.id) ? compiled.worldPos(spec.gate.supportingSurfaceId, spec.gate.localPosition) : null;
  const relicPos = new Map<string, Vec2>();
  for (const r of remainingRelics) {
    const p = compiled.worldPos(r.supportingSurfaceId, r.localPosition);
    if (p) relicPos.set(r.id, p);
  }

  type Origin = { id: string; kind: 'spawn' | 'player'; pos: Vec2; start: number };
  const spawnOrigins: Origin[] = [];
  for (const s of spec.spawns) {
    if (!placed.has(s.id)) continue;
    const p = compiled.worldPos(s.supportingSurfaceId, s.localPosition);
    if (!p) continue;
    const start = nearestWalkable(nav, p, SNAP_RADIUS, false);
    if (start < 0) {
      issues.push(issue('UNREACHABLE_SPAWN', `spawn "${s.id}" has no walkable cell within ${SNAP_RADIUS} m`, [s.id, s.supportingSurfaceId], { position: p, snapRadius: SNAP_RADIUS }));
      continue;
    }
    spawnOrigins.push({ id: s.id, kind: 'spawn', pos: p, start });
  }

  const lockedFloods = new Map<string, Flood>();
  const openFloods = new Map<string, Flood>();
  const lockedFlood = (o: Origin) => { let f = lockedFloods.get(o.id); if (!f) { f = flood(nav, o.start, false); lockedFloods.set(o.id, f); } return f; };
  const openFlood = (o: Origin) => {
    let f = openFloods.get(o.id);
    if (!f) {
      const start = nearestWalkable(nav, o.pos, SNAP_RADIUS, true);
      f = flood(nav, start, true);
      openFloods.set(o.id, f);
    }
    return f;
  };

  for (const r of remainingRelics) {
    const p = relicPos.get(r.id);
    if (!p) continue;
    const blockedFrom: string[] = [];
    const hiddenFrom: string[] = [];
    for (const o of spawnOrigins) {
      if (reachedGoal(nav, lockedFlood(o), p, GEOMETRY.relicPickupRadius, false) >= 0) continue;
      if (reachedGoal(nav, openFlood(o), p, GEOMETRY.relicPickupRadius, true) >= 0) hiddenFrom.push(o.id);
      else blockedFrom.push(o.id);
    }
    if (blockedFrom.length > 0) {
      issues.push(issue('UNREACHABLE_RELIC', `relic "${r.id}" on "${r.supportingSurfaceId}" cannot be reached from ${blockedFrom.join(', ')} with the gate locked`, [r.id, r.supportingSurfaceId, ...blockedFrom], { fromSpawnIds: blockedFrom, islandId: r.supportingSurfaceId }));
    }
    if (hiddenFrom.length > 0) {
      issues.push(issue('GATE_HIDES_RELIC', `relic "${r.id}" on "${r.supportingSurfaceId}" is reachable only after the gate "${spec.gate.id}" opens, from ${hiddenFrom.join(', ')}`, [r.id, spec.gate.id, ...hiddenFrom], { fromSpawnIds: hiddenFrom, islandId: r.supportingSurfaceId }));
    }
  }

  if (gatePos) {
    const blockedFrom: string[] = [];
    for (const o of spawnOrigins) {
      if (reachedGoal(nav, lockedFlood(o), gatePos, GEOMETRY.gateTriggerRadius, false) < 0) blockedFrom.push(o.id);
    }
    if (blockedFrom.length > 0) {
      issues.push(issue('DISCONNECTED_GOAL', `gate "${spec.gate.id}" on "${spec.gate.supportingSurfaceId}" cannot be reached from ${blockedFrom.join(', ')}`, [spec.gate.id, spec.gate.supportingSurfaceId, ...blockedFrom], { fromSpawnIds: blockedFrom, islandId: spec.gate.supportingSurfaceId }));
    }
  }

  // 8. Live context: PLAYER_CUT_OFF
  const spawnById = new Map(spec.spawns.map((s) => [s.id, s] as const));
  for (const pl of ctx.players ?? []) {
    let pos: Vec2 | null = null;
    let via = 'position';
    if (pl.status === 'active') {
      pos = { x: pl.x, z: pl.z };
    } else {
      const s = spawnById.get(pl.spawnId);
      pos = s && placed.has(s.id) ? compiled.worldPos(s.supportingSurfaceId, s.localPosition) : null;
      via = 'spawn';
      if (!pos) pos = { x: pl.x, z: pl.z };
    }
    const start = nearestWalkable(nav, pos, SNAP_RADIUS, false);
    if (start < 0) {
      issues.push(issue('PLAYER_CUT_OFF', `player "${pl.id}" has no walkable cell within ${SNAP_RADIUS} m of their ${via}`, [pl.id], { position: pos, via, snapRadius: SNAP_RADIUS }));
      continue;
    }
    const o: Origin = { id: `player:${pl.id}`, kind: 'player', pos, start };
    const f = lockedFlood(o);
    const unreachable: string[] = [];
    for (const r of remainingRelics) {
      const p = relicPos.get(r.id);
      if (p && reachedGoal(nav, f, p, GEOMETRY.relicPickupRadius, false) < 0) unreachable.push(r.id);
    }
    if (gatePos && reachedGoal(nav, f, gatePos, GEOMETRY.gateTriggerRadius, false) < 0) unreachable.push(spec.gate.id);
    if (unreachable.length > 0) {
      issues.push(issue('PLAYER_CUT_OFF', `player "${pl.id}" (${via}, on "${compiled.supportAt(pos.x, pos.z) ?? 'no surface'}") could no longer reach ${unreachable.join(', ')}`, [pl.id, ...unreachable], { via, position: pos, supportId: compiled.supportAt(pos.x, pos.z), unreachableIds: unreachable }));
    }
  }

  return issues.length === 0 ? { ok: true, issues, compiled } : { ok: false, issues, compiled };
}

export type { CompiledWorld };
