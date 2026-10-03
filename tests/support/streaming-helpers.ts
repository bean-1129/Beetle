// Helpers for the streaming-generation tests (tests/integration/streaming.test.ts) and the unattended acceptance run
// (scripts/acceptance-streaming.ts). Streaming: when a connected active player comes within STREAMING.frontierMeters
// of its island's rim on a side with no crossing within 45 degrees, the server itself queues an `edit` director request
// (auto true, autoReason { islandId, direction, playerId }) asking for new islands in that direction.
//
// World: the packages/world fixture seed2 when present (two islands, one bridge, streaming true), else an inline spec
// with the same layout. Requests are observed only through the director HTTP API (activity + request by id), so no
// agent worker is needed to see that a request exists.
import {
  GEOMETRY, MOVEMENT_RULES_VERSION, ROUTES, SCHEMA_VERSION, STREAMING, WORLD_LIMITS,
  type DirectorRequest, type Island, type PlayerView, type TickMessage, type Vec2, type WorldSpec,
} from '@beetle/contracts';
import { FIXTURE_NAMES, fixtureWorld } from '@beetle/world';
import {
  WsClient, agentFetch, anonFetch, awaitTicks, directorFetch, joinController, playerIn, sleep,
  type Controller, type ServerHandle,
} from './server-harness.ts';
import { bridgeTouchesIsland, bridgesTouching, dist, endpointOn, islandOf, islandRoute } from './world-geom.ts';

// ---------------------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------------------

export type StreamingWorld = { spec: WorldSpec; source: 'fixture-seed2' | 'inline-two-island'; note: string };

/** Two islands, one bridge to the north, streaming on (same layout as the seed2 fixture). */
export function inlineTwoIslandWorld(): WorldSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    worldId: 'stream2',
    worldVersion: 0,
    seed: 20202,
    title: 'Two-island streaming seed (inline)',
    biome: 'garden',
    bounds: { halfExtent: WORLD_LIMITS.bounds.halfExtent },
    movementRulesVersion: MOVEMENT_RULES_VERSION,
    islands: [
      { id: 'haven', name: 'Spawn Haven', center: { x: 0, z: 0 }, radius: 9, topElevation: 0 },
      { id: 'grove', name: 'Whisper Grove', center: { x: 0, z: 24 }, radius: 8, topElevation: 0 },
    ],
    bridges: [
      { id: 'bridge-grove', endpoints: [{ islandId: 'haven', point: { x: 0, z: 9 } }, { islandId: 'grove', point: { x: 0, z: 16 } }], width: 2.4 },
    ],
    spawns: [
      { id: 'spawn-0', supportingSurfaceId: 'haven', localPosition: { x: -2, z: -2 }, playerSlot: 0 },
      { id: 'spawn-1', supportingSurfaceId: 'haven', localPosition: { x: 2, z: -2 }, playerSlot: 1 },
    ],
    relics: [
      { id: 'relic-haven', name: 'Seed Relic', supportingSurfaceId: 'haven', localPosition: { x: 0, z: -5 } },
      { id: 'relic-grove-w', name: 'Leaf Relic', supportingSurfaceId: 'grove', localPosition: { x: -4, z: 0 } },
      { id: 'relic-grove-e', name: 'Bark Relic', supportingSurfaceId: 'grove', localPosition: { x: 4, z: 0 } },
    ],
    gate: { id: 'gate', supportingSurfaceId: 'grove', localPosition: { x: 0, z: 4 }, requiredRelicIds: ['relic-haven', 'relic-grove-w', 'relic-grove-e'] },
    hazard: { kind: 'water', planeElevation: GEOMETRY.hazardPlaneElevation, policy: { onContact: 'respawn', scorePenalty: 0 } },
    decorations: [
      { id: 'tree-haven', type: 'tree', supportingSurfaceId: 'haven', localPosition: { x: -5, z: 3 }, rotationDeg: 0, scale: 1 },
    ],
    objectiveRules: ['collect_all_relics_then_enter_gate'],
    streaming: true,
  };
}

export function seed2Available(): boolean {
  if (!(FIXTURE_NAMES as readonly string[]).includes('seed2')) return false;
  try {
    const s = fixtureWorld('seed2' as never) as WorldSpec;
    return s.worldId === 'seed2' && s.streaming === true;
  } catch {
    return false;
  }
}

/** The seed2 fixture when the world owner has added it (and it has streaming on), else the inline two-island world. */
export function streamingWorld(): StreamingWorld {
  if (seed2Available()) {
    const spec = fixtureWorld('seed2' as never) as WorldSpec;
    return { spec: JSON.parse(JSON.stringify(spec)), source: 'fixture-seed2', note: `fixture seed2: ${spec.islands.length} islands, ${spec.bridges.length} bridges` };
  }
  return { spec: inlineTwoIslandWorld(), source: 'inline-two-island', note: 'seed2 fixture missing; inline two-island world (seed2 layout)' };
}

// ---------------------------------------------------------------------------------------------------------
// Frontier geometry
// ---------------------------------------------------------------------------------------------------------

/** Angle (degrees, 0 = east, 90 = north) of `p` seen from `from`. */
export function angleDeg(from: Vec2, p: Vec2): number {
  return ((Math.atan2(p.z - from.z, p.x - from.x) * 180) / Math.PI + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Angles (degrees) of every crossing endpoint on the island, seen from the island centre. */
export function crossingAngles(spec: WorldSpec, islandId: string): number[] {
  const island = islandOf(spec, islandId);
  return bridgesTouching(spec, islandId).map((b) => angleDeg(island.center, endpointOn(b, islandId)));
}

const COMPASS: Record<string, number> = {
  east: 0, e: 0, '+x': 0, 'north-east': 45, northeast: 45, ne: 45, north: 90, n: 90, '+z': 90, 'north-west': 135, northwest: 135, nw: 135,
  west: 180, w: 180, '-x': 180, 'south-west': 225, southwest: 225, sw: 225, south: 270, s: 270, '-z': 270, 'south-east': 315, southeast: 315, se: 315,
};

/** Parses a server direction string (compass word, abbreviation, axis or degrees) into degrees, or null. */
export function directionDegrees(direction: string): number | null {
  const s = direction.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  if (s in COMPASS) return COMPASS[s];
  const n = Number.parseFloat(s.replace(/deg(rees)?$/, ''));
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
}

/** True when the direction string names a heading within `toleranceDeg` of the expected angle. */
export function directionMatches(direction: string, expectedDeg: number, toleranceDeg = 45): boolean {
  const d = directionDegrees(direction);
  return d !== null && angleDiff(d, expectedDeg) <= toleranceDeg + 1e-6;
}

/**
 * The open side of an island: the compass heading (multiple of 45 degrees) furthest from every crossing, among those
 * at least 60 degrees from any crossing, preferring headings with room for a new island inside the world bounds.
 */
export function openHeading(spec: WorldSpec, islandId: string, avoidDeg: number[] = []): number {
  const island = islandOf(spec, islandId);
  const crossings = crossingAngles(spec, islandId);
  const H = WORLD_LIMITS.bounds.halfExtent;
  let best: { a: number; score: number } | null = null;
  for (let a = 0; a < 360; a += 45) {
    const minCross = crossings.length ? Math.min(...crossings.map((c) => angleDiff(a, c))) : 180;
    if (minCross < 60) continue;
    const rad = (a * Math.PI) / 180;
    // Room for a radius-7 island 9 m past the rim.
    const reach = island.radius + 9 + 7;
    const fx = island.center.x + Math.cos(rad) * reach;
    const fz = island.center.z + Math.sin(rad) * reach;
    const inBounds = Math.abs(fx) <= H - 1 && Math.abs(fz) <= H - 1;
    // Keep away from other islands in that direction (the new island would collide).
    const crowded = spec.islands.some((o) => o.id !== islandId && dist(o.center, { x: fx, z: fz }) < o.radius + 8);
    const avoid = avoidDeg.some((v) => angleDiff(a, v) < 45);
    const score = minCross + (inBounds ? 1000 : 0) + (crowded ? 0 : 500) + (avoid ? -2000 : 0) + (a === 270 ? 1 : 0);
    if (!best || score > best.score) best = { a, score };
  }
  if (!best) throw new Error(`island ${islandId} has no open side (crossings at ${crossings.map((c) => c.toFixed(0)).join(', ')})`);
  return best.a;
}

/** Point on the island along `headingDeg`, `insetM` metres inside the rim (inside the frontier band when < frontierMeters). */
export function rimPoint(island: Island, headingDeg: number, insetM = 1.5, lateralM = 0): Vec2 {
  const rad = (headingDeg * Math.PI) / 180;
  const r = island.radius - insetM;
  // lateral offset perpendicular to the heading (keeps the path off relics sitting on the axis)
  return {
    x: island.center.x + Math.cos(rad) * r - Math.sin(rad) * lateralM,
    z: island.center.z + Math.sin(rad) * r + Math.cos(rad) * lateralM,
  };
}

/** Distance from a point to the island rim (positive inside). */
export function rimDistance(island: Island, p: Vec2): number {
  return island.radius - dist(island.center, p);
}

// ---------------------------------------------------------------------------------------------------------
// Director / agent HTTP
// ---------------------------------------------------------------------------------------------------------

export type SettingsResult = { status: number; autoExpand: boolean | null; text: string };

/** POST /api/director/settings { autoExpand }; tolerant of a bare or nested response body. */
export async function setAutoExpand(server: ServerHandle, autoExpand: boolean): Promise<SettingsResult> {
  const res = await directorFetch(server, ROUTES.directorSettings, { method: 'POST', body: { autoExpand } });
  const j = (res.json ?? {}) as Record<string, any>;
  const v = typeof j.autoExpand === 'boolean' ? j.autoExpand : typeof j.settings?.autoExpand === 'boolean' ? j.settings.autoExpand : null;
  return { status: res.status, autoExpand: v, text: res.text.slice(0, 300) };
}

/** All request ids the director activity feed mentions, oldest first. */
export async function activityRequestIds(server: ServerHandle): Promise<string[]> {
  const res = await directorFetch<{ entries: { requestId?: string }[] }>(server, `${ROUTES.directorActivity}?limit=500`);
  if (res.status !== 200) throw new Error(`GET ${ROUTES.directorActivity} -> HTTP ${res.status} ${res.text.slice(0, 200)}`);
  const ids: string[] = [];
  for (const e of res.json.entries ?? []) if (e.requestId && !ids.includes(e.requestId)) ids.push(e.requestId);
  return ids;
}

export async function getRequest(server: ServerHandle, id: string): Promise<DirectorRequest | null> {
  const res = await directorFetch<{ request: DirectorRequest }>(server, ROUTES.directorRequestById.replace(':id', encodeURIComponent(id)));
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`GET ${ROUTES.directorRequestById} -> HTTP ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.request ?? null;
}

/** Every automatic (auto true) request the server has announced through the activity feed. */
export async function autoRequests(server: ServerHandle): Promise<DirectorRequest[]> {
  const out: DirectorRequest[] = [];
  for (const id of await activityRequestIds(server)) {
    const r = await getRequest(server, id);
    if (r && r.auto === true) out.push(r);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Polls until an automatic request not in `known` exists; null on timeout. */
export async function waitForNewAutoRequest(server: ServerHandle, known: string[], timeoutMs: number, pollMs = 250): Promise<DirectorRequest | null> {
  const t0 = Date.now();
  for (;;) {
    const fresh = (await autoRequests(server)).filter((r) => !known.includes(r.id));
    if (fresh.length) return fresh[0];
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

/**
 * Takes an open request off the queue as a fake agent (claim + finish cancelled) so it no longer counts as in flight.
 * Claims until the wanted request comes back; other claimed requests are released as cancelled too and returned.
 */
export async function claimAndCancel(server: ServerHandle, requestId: string): Promise<{ cancelled: string[] }> {
  const cancelled: string[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await agentFetch<{ request?: DirectorRequest }>(server, ROUTES.agentRequestsClaim, { method: 'POST', body: { workerId: 'streaming-test' }, timeoutMs: 30_000 });
    const r = res.status === 200 ? res.json.request : undefined;
    if (!r) break;
    const fin = await agentFetch(server, ROUTES.agentRequestFinish.replace(':id', encodeURIComponent(r.id)), { method: 'POST', body: { outcome: 'cancelled' } });
    if (fin.status !== 200) throw new Error(`finish ${r.id} -> HTTP ${fin.status} ${fin.text.slice(0, 200)}`);
    cancelled.push(r.id);
    if (r.id === requestId) return { cancelled };
  }
  throw new Error(`request ${requestId} could not be claimed (claimed and cancelled: ${cancelled.join(', ') || 'none'})`);
}

export async function publicWorld(server: ServerHandle): Promise<{ spec: WorldSpec; version: number }> {
  const res = await anonFetch<{ spec: WorldSpec; version: number }>(server, ROUTES.world);
  if (res.status !== 200 || !res.json?.spec) throw new Error(`GET ${ROUTES.world} -> HTTP ${res.status} ${res.text.slice(0, 200)}`);
  return { spec: res.json.spec, version: res.json.version };
}

// ---------------------------------------------------------------------------------------------------------
// Reachability and preservation
// ---------------------------------------------------------------------------------------------------------

export type Reachability = { islandId: string; ok: boolean; bridges: string[]; route: string[] | null; detail: string };

/** A new island is reachable when a bridge touches its rim, the far end touches another island, and a route exists. */
export function islandReachable(spec: WorldSpec, islandId: string, fromIslandId: string): Reachability {
  const island = spec.islands.find((i) => i.id === islandId);
  if (!island) return { islandId, ok: false, bridges: [], route: null, detail: `island ${islandId} missing from /api/world` };
  const touching = spec.bridges.filter((b) => b.endpoints.some((e) => e.islandId === islandId) && bridgeTouchesIsland(b, island, GEOMETRY.socketTolerance + 0.15));
  const rimOk = touching.filter((b) => {
    const mine = b.endpoints.find((e) => e.islandId === islandId)!;
    const other = b.endpoints.find((e) => e !== mine)!;
    const otherIsland = spec.islands.find((i) => i.id === other.islandId);
    return Math.abs(dist(mine.point, island.center) - island.radius) <= GEOMETRY.socketTolerance + 0.15
      && !!otherIsland && Math.abs(dist(other.point, otherIsland.center) - otherIsland.radius) <= GEOMETRY.socketTolerance + 0.15;
  });
  const route = islandRoute(spec, fromIslandId, islandId);
  const ok = rimOk.length > 0 && route !== null;
  return {
    islandId, ok, bridges: rimOk.map((b) => b.id), route: route ? [fromIslandId, ...route.map((l) => l.to.id)] : null,
    detail: `${touching.length} bridge(s) reference ${islandId}, ${rimOk.length} sit on both rims; route from ${fromIslandId}: ${route ? route.map((l) => l.bridge.id).join(' > ') || '(same island)' : 'none'}`,
  };
}

export type PlayerSnap = { id: string; x: number; z: number; status: string; connected: boolean; supportId: string | null };
export function snapPlayers(t: TickMessage): PlayerSnap[] {
  return t.players.map((p: PlayerView) => ({ id: p.id, x: p.x, z: p.z, status: p.status, connected: p.connected, supportId: p.supportId ?? null }));
}
export function collectedOf(t: TickMessage): string[] {
  return Object.entries(t.relics).filter(([, s]) => s === 'collected').map(([id]) => id).sort();
}

/** Last tick before and first tick at `version` from a client's message log (both null when not seen). */
export function ticksAroundVersion(ws: WsClient, since: number, version: number): { before: TickMessage | null; after: TickMessage | null } {
  const ticks = ws.ticksSince(since);
  let before: TickMessage | null = null;
  for (const t of ticks) {
    if (t.worldVersion >= version) return { before, after: t };
    before = t;
  }
  return { before, after: null };
}

// ---------------------------------------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------------------------------------

export type Solo = { c: Controller; ws: WsClient };

/** One controller joined over HTTP and connected over WebSocket, reported connected, axes calibrated. */
export async function joinSolo(server: ServerHandle, name = 'p1'): Promise<Solo> {
  const c = await joinController(server);
  const ws = await WsClient.connect(server, { name });
  const w = await ws.helloController(c.controllerToken);
  if (w.playerId !== c.playerId) throw new Error('welcome playerId mismatch');
  await ws.waitForTick((t) => Boolean(playerIn(t, c.playerId)?.connected && playerIn(t, c.playerId)?.status === 'active'), 10_000, 'player connected and active');
  await ws.calibrateAxes(c.playerId);
  await awaitTicks(ws, 2);
  return { c, ws };
}

/**
 * Walks back and forth between two points until stop(); used to keep a player moving across a commit.
 * Uses raw axes toward the current target so it never blocks the caller.
 */
export function patrol(ws: WsClient, playerId: string, a: Vec2, b: Vec2, intervalMs = 50): { stop(): void; legs(): number } {
  let target = b;
  let legs = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !ws.isOpen) return;
    const t = ws.lastTick();
    const p = t ? playerIn(t, playerId) : undefined;
    if (!p) return;
    let dx = target.x - p.x;
    let dz = target.z - p.z;
    let d = Math.hypot(dx, dz);
    if (d < 0.4) {
      target = target === b ? a : b;
      legs++;
      dx = target.x - p.x; dz = target.z - p.z; d = Math.hypot(dx, dz) || 1;
    }
    ws.input(ws.axesFor({ x: dx / d, z: dz / d }), false);
  }, intervalMs);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (ws.isOpen) ws.input({ x: 0, z: 0 }, false);
    },
    legs: () => legs,
  };
}

export { STREAMING };
