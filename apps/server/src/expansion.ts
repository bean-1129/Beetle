// Streaming generation: detects players nearing an island rim with no crossing beyond and queues one automatic
// edit request (add_island) at a time. Pure helpers (findFrontier, shouldRequest) plus a throttled scheduler.
import { STREAMING, compassName, type AgentActivity, type DirectorRequest } from '@beetle/contracts';
import type { EventLog } from '@beetle/observability';
import type { CompiledWorld } from '@beetle/world';
import type { RequestStore } from './requests.ts';
import type { SessionStore } from './session.ts';
import type { WorldStore } from './world-store.ts';

/** Angular half-width (degrees) around the rim direction in which an existing bridge endpoint counts as a crossing. */
export const CROSSING_HALF_ANGLE_DEG = 45;
/** The scheduler looks at players at most this often (not every tick). */
export const EXPANSION_POLL_MS = 1000;

export type ExpansionState = {
  /** Clock ms of the last automatic request (creation or settle); 0 = never. */
  lastRequestAt: number;
  /** The automatic request currently queued or being worked on, if any. */
  inFlightRequestId: string | null;
};

export type ExpansionSettings = { autoExpand: boolean };
export const DEFAULT_EXPANSION_SETTINGS: Readonly<ExpansionSettings> = Object.freeze({ autoExpand: true });

export type FrontierPlayer = { id: string; x: number; z: number; supportId: string | null; status: string };
export type Frontier = { islandId: string; direction: string; playerId: string };

export function createExpansionState(): ExpansionState {
  return { lastRequestAt: 0, inFlightRequestId: null };
}

export function resetExpansionState(state: ExpansionState): void {
  state.lastRequestAt = 0;
  state.inFlightRequestId = null;
}

function angleDeg(dx: number, dz: number): number {
  return ((Math.atan2(dz, dx) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The frontier a player stands at, or null. Fires when the player is active, supported by an island, within
 * STREAMING.frontierMeters of its rim, and no bridge endpoint on that island lies within 45 degrees of the rim
 * direction (angle from the island centre to the player). `now` and `state` are accepted for call-site symmetry.
 */
export function findFrontier(compiled: CompiledWorld, player: FrontierPlayer, _now?: number, _state?: ExpansionState): Frontier | null {
  if (player.status !== 'active' || !player.supportId) return null;
  const island = compiled.surfaces.find((s) => s.kind === 'island' && s.id === player.supportId);
  if (!island || island.kind !== 'island') return null;
  const dx = player.x - island.center.x;
  const dz = player.z - island.center.z;
  const d = Math.hypot(dx, dz);
  if (!Number.isFinite(d) || d < 1e-6) return null;
  if (island.radius - d > STREAMING.frontierMeters) return null;
  const rim = angleDeg(dx, dz);
  for (const s of compiled.surfaces) {
    if (s.kind !== 'bridge' || !s.islandIds.includes(island.id)) continue;
    // The endpoint on this island is the one nearer its centre.
    const da = Math.hypot(s.a.x - island.center.x, s.a.z - island.center.z);
    const db = Math.hypot(s.b.x - island.center.x, s.b.z - island.center.z);
    const end = da <= db ? s.a : s.b;
    const ex = end.x - island.center.x;
    const ez = end.z - island.center.z;
    if (Math.hypot(ex, ez) < 1e-6) return null; // degenerate: treat as covered
    if (angleDiff(angleDeg(ex, ez), rim) <= CROSSING_HALF_ANGLE_DEG) return null;
  }
  const direction = compassName({ x: player.x, z: player.z }, island.center, 0);
  return { islandId: island.id, direction, playerId: player.id };
}

export type ExpansionGate = { streaming: boolean; islandCount: number; autoExpand: boolean };

/** True when a new automatic request may be created now. */
export function shouldRequest(state: ExpansionState, now: number, gate: ExpansionGate = { streaming: true, islandCount: 0, autoExpand: true }): boolean {
  if (!gate.streaming || !gate.autoExpand) return false;
  if (gate.islandCount >= STREAMING.maxIslands) return false;
  if (state.inFlightRequestId) return false;
  if (state.lastRequestAt > 0 && now - state.lastRequestAt < STREAMING.cooldownMs) return false;
  return true;
}

export function expansionPrompt(f: Frontier): string {
  return `Extend the world: add one or two new islands beyond island "${f.islandId}" toward the ${f.direction}, each 5 to 9 m radius, with a crossing from "${f.islandId}" (use add_island with bridgeFrom "${f.islandId}"), one decoration on each, keep everything else unchanged.`;
}

export type ExpansionDeps = {
  session: SessionStore;
  world: WorldStore;
  requests: RequestStore;
  events: EventLog;
  now: () => number;
  onActivity?: (entries: AgentActivity[]) => void;
};

/** Throttled driver: poll() from the simulation tick; settle() when a request finishes; reset() on a world commit. */
export class ExpansionScheduler {
  readonly state: ExpansionState = createExpansionState();
  private lastPollAt = -Infinity;

  constructor(private readonly d: ExpansionDeps) {}

  get settings(): ExpansionSettings {
    return this.d.session.settings;
  }

  /** Called every tick; does work at most once per EXPANSION_POLL_MS. Returns the created request, if any. */
  poll(now: number = this.d.now()): DirectorRequest | null {
    if (now - this.lastPollAt < EXPANSION_POLL_MS) return null;
    this.lastPollAt = now;
    return this.check(now);
  }

  /** Unthrottled check (tests and poll). */
  check(now: number = this.d.now()): DirectorRequest | null {
    const active = this.d.world.current;
    if (!active) return null;
    // A request that finished without going through settle() (store eviction, cancel) must not block forever.
    if (this.state.inFlightRequestId) {
      const r = this.d.requests.get(this.state.inFlightRequestId);
      if (!r) this.settle(this.state.inFlightRequestId, 'failed', now);
      else if (r.status === 'committed' || r.status === 'failed' || r.status === 'cancelled') this.settle(r.id, r.status, now);
    }
    const gate: ExpansionGate = {
      streaming: active.spec.streaming === true,
      islandCount: active.spec.islands.length,
      autoExpand: this.d.session.settings.autoExpand,
    };
    if (!shouldRequest(this.state, now, gate)) return null;
    for (const p of this.d.session.playersInSlotOrder()) {
      if (!p.connected) continue;
      const f = findFrontier(active.compiled, p, now, this.state);
      if (!f) continue;
      return this.request(f, now);
    }
    return null;
  }

  private request(f: Frontier, now: number): DirectorRequest {
    const version = this.d.world.version;
    const request = this.d.requests.create('edit', expansionPrompt(f), version, false, { auto: true, autoReason: f });
    this.state.inFlightRequestId = request.id;
    this.state.lastRequestAt = now;
    this.d.events.emit({ name: 'expansion.requested', requestId: request.id, worldVersion: version, data: { ...f } });
    const entry = this.d.requests.addActivity(request.id, { phase: 'queued', message: `Extend the world to the ${f.direction} beyond island "${f.islandId}" (queued)` }, version);
    this.d.onActivity?.([entry]);
    return request;
  }

  /** A request finished. Only the in-flight automatic request matters. */
  settle(requestId: string, outcome: string, now: number = this.d.now()): void {
    if (this.state.inFlightRequestId !== requestId) return;
    this.state.inFlightRequestId = null;
    this.state.lastRequestAt = now;
    this.d.events.emit({ name: 'expansion.settled', requestId, worldVersion: this.d.world.version, outcome: outcome === 'committed' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'fail', data: { outcome } });
  }

  /** A whole new world was committed: forget cooldown and in-flight bookkeeping. */
  reset(): void {
    resetExpansionState(this.state);
  }

  setSettings(patch: Partial<ExpansionSettings>): ExpansionSettings {
    if (typeof patch.autoExpand === 'boolean') this.d.session.settings.autoExpand = patch.autoExpand;
    return { ...this.d.session.settings };
  }
}
