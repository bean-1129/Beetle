// Authoritative 30 Hz simulation: movement, relics, gate, win, game modes, the commit queue and tick broadcasts.
import {
  EMOTE_DURATION_MS, GEOMETRY, MODE_LIMITS, MOVEMENT_SCALES, PING_LIFETIME_MS, SCORING, SIMULATION, dist, effectiveMode, effectiveSpeed,
  type CommitResult, type GameMode, type MarkerMessage, type ObjectiveState, type PlayerState, type PlayerView, type TickMessage, type Vec2, type WorldMessage, type WorldSpec,
} from '@beetle/contracts';
import { compileWorld, stepMover, type CompiledWorld, type Mover } from '@beetle/world';
import type { EventLog } from '@beetle/observability';
import type { Candidate, CandidateStore } from './candidates.ts';
import { isFakeClock, type Clock } from './clock.ts';
import type { Persistence } from './persistence.ts';
import type { PlayerRuntime, SessionStore } from './session.ts';
import type { WorldStore } from './world-store.ts';

export const TICK_MS = 1000 / SIMULATION.tickHz;
const SESSION_SNAPSHOT_EVERY_MS = 5000;
/** A controller may place at most one beacon per second. */
export const PING_MIN_INTERVAL_MS = 1000;
/** Survival: a bridge deck (Y = 0) is submerged once the hazard plane is within 1.0 m below it. */
export const SUBMERGE_PLANE_ELEVATION = -1.0;

export type PendingCommit = {
  candidate: Candidate;
  proofId: string;
  reason: 'commit' | 'undo';
  enqueuedAt: number;
  deferredSince: number | null;
  blockers: string[];
  resolve: (result: CommitResult) => void;
};

export type SimulationHooks = {
  onTick(message: TickMessage): void;
  onWorld(message: WorldMessage): void;
  /** A controller pressed ping: the beacon goes to display and director sockets. */
  onMarker?(message: MarkerMessage): void;
  onRelicCollected?(relicId: string, playerId: string): void;
  onGateUnlocked?(): void;
  onWin?(playerId: string): void;
  onCommitDeferred?(pending: PendingCommit): void;
  onCommitResolved?(pending: PendingCommit, result: CommitResult): void;
};

export type SimulationOptions = {
  session: SessionStore;
  world: WorldStore;
  candidates: CandidateStore;
  clock: Clock;
  events: EventLog;
  persistence: Persistence;
  hooks: SimulationHooks;
  /** 'interval' runs setInterval at tickHz; 'manual' only ticks when tick() is called (tests). */
  mode: 'interval' | 'manual';
};

/** Effective mode plus the server's per-mode defaults (survival needs one relic unless the spec says otherwise). */
export type ResolvedMode = {
  kind: GameMode;
  timeLimitSec: number | null;
  holdSeconds: number;
  relicsRequired: number;
  orderedCheckpoints: boolean;
};

export function resolveMode(spec: WorldSpec): ResolvedMode {
  const m = effectiveMode(spec);
  const relicsRequired = m.kind === 'survival' && spec.mode?.relicsRequired === undefined ? Math.min(1, spec.relics.length) || 1 : m.relicsRequired;
  return { kind: m.kind, timeLimitSec: m.timeLimitSec, holdSeconds: m.holdSeconds, relicsRequired, orderedCheckpoints: m.orderedCheckpoints };
}

/** Per-world mode runtime. Reset on a world commit and on a set_mode patch; players, relics and score live in SessionState. */
type ModeRuntime = ResolvedMode & {
  /** Relic ids in spec order (checkpoint order). */
  relicOrder: string[];
  activatedAtMs: number;
  timerStarted: boolean;
  elapsedMs: number;
  lost: boolean;
  holdMs: Map<string, number>;
  hazardElevation: number;
  submergedBridgeIds: Set<string>;
  /** compiled world whose supportAt is filtered through submergedBridgeIds (never recompiled). */
  flooded: { base: CompiledWorld; world: CompiledWorld; key: string } | null;
};

export class Simulation {
  readonly queue: PendingCommit[] = [];
  private timer: NodeJS.Timeout | null = null;
  private expectedAt = 0;
  private lastSessionSnapshotAt = 0;
  private cache: { version: number; worldId: string; relics: { id: string; pos: Vec2 }[]; gate: Vec2 | null; spawns: Map<string, { spawnId: string; pos: Vec2 }> } | null = null;
  private modeRt: ModeRuntime | null = null;
  running = false;
  ticksBehind = 0;

  constructor(private readonly o: SimulationOptions) {}

  get mode(): 'interval' | 'manual' {
    return this.o.mode;
  }

  start(): void {
    if (this.o.mode !== 'interval' || this.timer) return;
    this.running = true;
    this.expectedAt = this.o.clock.now() + TICK_MS;
    this.timer = setInterval(() => this.onInterval(), TICK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const pending of this.queue.splice(0)) {
      pending.resolve({ ok: false, code: 'INTERNAL', message: 'server stopping', objectIds: [], retryable: true });
    }
  }

  /** Drift-corrected: runs as many fixed steps as wall time owes, capped so a stall never spirals. */
  private onInterval(): void {
    const now = this.o.clock.now();
    let steps = 0;
    while (now >= this.expectedAt && steps < 4) {
      this.step();
      this.expectedAt += TICK_MS;
      steps += 1;
    }
    if (now - this.expectedAt > TICK_MS * 4) {
      this.ticksBehind += Math.floor((now - this.expectedAt) / TICK_MS);
      this.expectedAt = now + TICK_MS;
    }
  }

  /** One manual tick. With a fake clock the clock advances by one tick first so timers progress. */
  tick(): void {
    if (this.o.mode === 'manual' && isFakeClock(this.o.clock)) this.o.clock.advance(TICK_MS);
    this.step();
  }

  // ---- per tick ----
  private step(): void {
    const { session, world } = this.o;
    const now = this.o.clock.now();
    const state = session.state;
    state.tick += 1;
    state.elapsedMs += TICK_MS;

    const active = world.current;
    if (active) {
      this.ensureCache(active.version, active.spec, active.compiled);
      const rt = this.ensureMode(now);
      this.updateTimer(rt, now);
      this.updateHazard(rt, active.spec, active.compiled);
      this.movePlayers(this.movementWorld(rt, active.compiled), now);
      this.handleInteractions(rt, now);
      this.updateGate(rt, active.spec);
      state.objective = this.buildObjective(rt);
    } else {
      for (const p of state.players) {
        p.vx = 0;
        p.vz = 0;
      }
    }

    this.processCommitQueue(now);

    if (now - this.lastSessionSnapshotAt >= SESSION_SNAPSHOT_EVERY_MS) {
      this.lastSessionSnapshotAt = now;
      void this.o.persistence.writeSession(session.snapshot());
    }

    this.o.hooks.onTick(this.buildTickMessage(now));
  }

  ensureCache(version: number, spec: WorldSpec, compiled: CompiledWorld): void {
    if (this.cache && this.cache.version === version && this.cache.worldId === spec.worldId) return;
    const spawns = new Map<string, { spawnId: string; pos: Vec2 }>();
    for (const s of spec.spawns) {
      const pos = compiled.worldPos(s.supportingSurfaceId, s.localPosition);
      if (pos) spawns.set(String(s.playerSlot), { spawnId: s.id, pos });
    }
    const relics: { id: string; pos: Vec2 }[] = [];
    for (const r of spec.relics) {
      const pos = compiled.worldPos(r.supportingSurfaceId, r.localPosition);
      if (pos) relics.push({ id: r.id, pos });
    }
    this.cache = { version, worldId: spec.worldId, relics, gate: compiled.worldPos(spec.gate.supportingSurfaceId, spec.gate.localPosition), spawns };
  }

  spawnFor(slot: 0 | 1): { spawnId: string; pos: Vec2 } {
    return this.cache?.spawns.get(String(slot)) ?? { spawnId: `spawn-${slot}`, pos: { x: 0, z: 0 } };
  }

  // ---- game modes ----
  /** The resolved mode of the active world, or null without a world. */
  currentMode(): ResolvedMode | null {
    const rt = this.modeRt;
    if (!rt) return null;
    return { kind: rt.kind, timeLimitSec: rt.timeLimitSec, holdSeconds: rt.holdSeconds, relicsRequired: rt.relicsRequired, orderedCheckpoints: rt.orderedCheckpoints };
  }

  /** Mode state for the active world; initialised lazily (seeded from a restored session objective when kinds match). */
  ensureMode(now: number): ModeRuntime {
    if (this.modeRt) return this.modeRt;
    const active = this.o.world.current;
    if (!active) throw new Error('ensureMode without an active world');
    return this.resetMode(active.spec, active.compiled, now, this.o.session.state.objective);
  }

  /**
   * (Re)initialises the mode runtime: timer, hold counters, hazard plane. Called on a world commit (after
   * resetForNewWorld), on a patch that changes the mode (players, relics, score and connections stay) and at startup.
   * `seed` restores timer/hold/lost from a persisted objective of the same kind.
   */
  resetMode(spec: WorldSpec, compiled: CompiledWorld, now: number, seed?: ObjectiveState): ModeRuntime {
    const mode = resolveMode(spec);
    const rt: ModeRuntime = {
      ...mode,
      relicOrder: spec.relics.map((r) => r.id),
      activatedAtMs: now,
      timerStarted: false,
      elapsedMs: 0,
      lost: false,
      holdMs: new Map(),
      hazardElevation: spec.hazard.planeElevation,
      submergedBridgeIds: new Set(),
      flooded: null,
    };
    if (seed && seed.kind === mode.kind) {
      if (rt.timeLimitSec !== null && typeof seed.remainingSec === 'number' && Number.isFinite(seed.remainingSec)) {
        const remaining = Math.min(rt.timeLimitSec, Math.max(0, seed.remainingSec));
        rt.elapsedMs = Math.round((rt.timeLimitSec - remaining) * 1000);
        rt.timerStarted = rt.elapsedMs > 0;
      }
      if (seed.lost === true && rt.timeLimitSec !== null) {
        rt.lost = true;
        rt.timerStarted = true;
        rt.elapsedMs = rt.timeLimitSec * 1000;
      }
      if (seed.holdSec && typeof seed.holdSec === 'object') {
        for (const [id, sec] of Object.entries(seed.holdSec)) {
          if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) rt.holdMs.set(id, sec * 1000);
        }
      }
    }
    // Players already moving when the mode activates start the countdown at once.
    if (!rt.timerStarted && this.anyPlayerMoving(now)) rt.timerStarted = true;
    this.modeRt = rt;
    this.updateHazard(rt, spec, compiled);
    this.o.session.state.gateUnlocked = this.gateShouldUnlock(rt, spec); // e.g. the hill has no lock from the first tick
    this.o.session.state.objective = this.buildObjective(rt);
    return rt;
  }

  private gateShouldUnlock(rt: ModeRuntime, spec: WorldSpec): boolean {
    const collected = this.o.session.state.collectedRelicIds;
    if (rt.kind === 'king_of_the_hill') return true; // the hill has no lock
    if (rt.orderedCheckpoints) return this.nextCheckpointId(rt) === null; // after the last checkpoint
    const required = spec.gate.requiredRelicIds;
    const allRequired = required.length > 0 && required.every((id) => collected.includes(id));
    return allRequired || collected.length >= rt.relicsRequired;
  }

  private anyPlayerMoving(now: number): boolean {
    return this.o.session.state.players.some((p) => p.connected && p.lastInputAtMs > 0 && now - p.lastInputAtMs <= SIMULATION.inputTimeoutMs);
  }

  private updateTimer(rt: ModeRuntime, now: number): void {
    const state = this.o.session.state;
    if (!rt.timerStarted) {
      // First player input after the world became active (or a player still moving from before).
      const started = state.players.some((p) => p.connected && p.lastInputAtMs > 0
        && (p.lastInputAtMs >= rt.activatedAtMs || now - p.lastInputAtMs <= SIMULATION.inputTimeoutMs));
      if (!started) return;
      rt.timerStarted = true;
      this.o.events.emit({ name: 'objective.started', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { kind: rt.kind, timeLimitSec: rt.timeLimitSec, tick: state.tick } });
    }
    if (rt.lost || state.won) return;
    rt.elapsedMs += TICK_MS;
    if (rt.timeLimitSec !== null && rt.elapsedMs >= rt.timeLimitSec * 1000) {
      rt.elapsedMs = rt.timeLimitSec * 1000;
      rt.lost = true;
      this.o.events.emit({ name: 'objective.lost', sessionId: state.sessionId, worldVersion: state.worldVersion, outcome: 'fail', data: { kind: rt.kind, timeLimitSec: rt.timeLimitSec, tick: state.tick, score: state.score } });
    }
  }

  /** Survival: elevation = min(maxElevation, planeElevation + metersPerSec * max(0, elapsedSec - afterSec)). */
  private updateHazard(rt: ModeRuntime, spec: WorldSpec, compiled: CompiledWorld): void {
    const rise = spec.hazard.rise;
    let elevation = spec.hazard.planeElevation;
    if (rt.kind === 'survival' && rise) {
      elevation = Math.min(rise.maxElevation, spec.hazard.planeElevation + rise.metersPerSec * Math.max(0, rt.elapsedMs / 1000 - rise.afterSec));
    }
    rt.hazardElevation = elevation;
    const submerged = rt.kind === 'survival' && elevation > SUBMERGE_PLANE_ELEVATION;
    const wasSubmerged = rt.submergedBridgeIds.size > 0;
    if (submerged) {
      // Every bridge deck sits at Y = 0, so all bridges go under together once the plane passes -1.0 m.
      const ids = compiled.surfaces.filter((s) => s.kind === 'bridge').map((s) => s.id);
      if (ids.length !== rt.submergedBridgeIds.size || ids.some((id) => !rt.submergedBridgeIds.has(id))) rt.submergedBridgeIds = new Set(ids);
    } else if (wasSubmerged) {
      rt.submergedBridgeIds = new Set();
    }
    if (submerged !== wasSubmerged) {
      const state = this.o.session.state;
      this.o.events.emit({ name: 'hazard.bridges', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { submerged, elevation: round3(elevation), bridgeIds: [...rt.submergedBridgeIds].slice(0, 32) } });
    }
  }

  /** The compiled world for movement: supportAt filtered through the submerged-bridge set (no recompilation). */
  private movementWorld(rt: ModeRuntime, compiled: CompiledWorld): CompiledWorld {
    if (rt.submergedBridgeIds.size === 0) return compiled;
    const key = [...rt.submergedBridgeIds].sort().join(',');
    if (rt.flooded && rt.flooded.base === compiled && rt.flooded.key === key) return rt.flooded.world;
    const submerged = rt.submergedBridgeIds;
    const world: CompiledWorld = {
      ...compiled,
      supportAt(x: number, z: number): string | null {
        const id = compiled.supportAt(x, z);
        return id !== null && submerged.has(id) ? null : id;
      },
    };
    rt.flooded = { base: compiled, world, key };
    return world;
  }

  /** Next relic in spec order that still has to be collected, or null once the required count is done. */
  private nextCheckpointId(rt: ModeRuntime): string | null {
    const collected = this.o.session.state.collectedRelicIds;
    if (collected.length >= rt.relicsRequired) return null;
    for (const id of rt.relicOrder) if (!collected.includes(id)) return id;
    return null;
  }

  private buildObjective(rt: ModeRuntime): ObjectiveState {
    const o: ObjectiveState = { kind: rt.kind };
    if (rt.timeLimitSec !== null) {
      o.remainingSec = round1(Math.max(0, rt.timeLimitSec - rt.elapsedMs / 1000));
      o.lost = rt.lost;
    }
    if (rt.kind === 'king_of_the_hill') {
      const holdSec: Record<string, number> = {};
      for (const p of this.o.session.playersInSlotOrder()) holdSec[p.id] = round1((rt.holdMs.get(p.id) ?? 0) / 1000);
      o.holdSec = holdSec;
      o.holdTarget = rt.holdSeconds;
    }
    if (rt.orderedCheckpoints) o.nextCheckpointId = this.nextCheckpointId(rt);
    if (rt.kind === 'relic_hunt' || rt.kind === 'time_trial' || rt.kind === 'survival') o.relicsRequired = rt.relicsRequired;
    if (rt.kind === 'survival') o.hazardElevation = round3(rt.hazardElevation);
    return o;
  }

  private movePlayers(compiled: CompiledWorld, now: number): void {
    const { session, world } = this.o;
    const state = session.state;
    const speed = effectiveSpeed(compiled.spec);
    const honoursSpeed = stepMoverHonoursSpeed(compiled);
    for (const player of session.playersInSlotOrder()) {
      const rt = session.runtimeOf(player, now);
      const fresh = isFresh(player, now);
      const speedScale = fresh ? speedScaleOf(rt) : 1;
      // Until stepMover reads compiled.spec.movement and speedScale itself, the step length carries both
      // (axes are unit-clamped there, so they cannot).
      const dtMs = honoursSpeed ? TICK_MS : TICK_MS * (speed / GEOMETRY.playerSpeed) * speedScale;
      const mover: Mover = {
        x: player.x, z: player.z, vx: player.vx, vz: player.vz, facingDeg: player.facingDeg,
        status: player.status, statusSinceMs: rt.statusSinceMs, supportId: player.supportId,
      };
      const spawn = this.spawnFor(player.slot);
      let result;
      try {
        result = stepMover(compiled, mover, { axes: fresh ? rt.axes : { x: 0, z: 0 }, active: fresh, speedScale }, dtMs, now, { gateOpen: state.gateUnlocked, spawn: spawn.pos });
      } catch (err) {
        this.o.events.emit({ name: 'sim.error', outcome: 'fail', data: { where: 'stepMover', message: err instanceof Error ? err.message : String(err) } });
        continue;
      }
      const m = result.mover;
      player.x = m.x; player.z = m.z; player.vx = m.vx; player.vz = m.vz; player.facingDeg = m.facingDeg;
      player.supportId = m.supportId;
      if (m.status !== player.status) rt.statusSinceMs = m.statusSinceMs;
      player.status = m.status;
      rt.statusSinceMs = m.statusSinceMs;
      for (const ev of result.events) {
        if (ev === 'hazard_contact') {
          player.respawns += 1;
          const kind = world.hazardKind();
          if (kind === 'lava') {
            player.lavaFalls += 1;
            state.score = Math.max(0, state.score - world.hazardPenalty()); // score floor is 0; penalties never go negative
          }
          this.o.events.emit({ name: 'player.hazard', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId: player.id, hazard: kind } });
        } else if (ev === 'fell') {
          this.o.events.emit({ name: 'player.fell', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId: player.id, supportId: player.supportId } });
        }
      }
      // Cosmetic height: sink while falling, back to the platform otherwise.
      if (player.status === 'falling') {
        const t = Math.min(1, Math.max(0, (now - rt.statusSinceMs) / GEOMETRY.fallDurationMs));
        player.y = (this.modeRt?.hazardElevation ?? world.hazardElevation()) * t;
      } else {
        player.y = 0;
      }
    }
  }

  private handleInteractions(rt: ModeRuntime, now: number): void {
    const { session } = this.o;
    const state = session.state;
    const relics = this.cache?.relics ?? [];
    const next = rt.orderedCheckpoints ? this.nextCheckpointId(rt) : null;
    for (const player of session.playersInSlotOrder()) {
      const prt = session.runtimeOf(player, now);
      const fresh = isFresh(player, now);
      this.handleButtons(player, prt, fresh, now);
      const held = fresh && prt.interact;
      const pressed = held && !prt.interactPrev;
      prt.interactPrev = held;
      if (!pressed || player.status !== 'active') continue;
      if (rt.lost) continue; // timer expired: pickups are disabled until a new world or a set_mode patch
      let best: { id: string; d: number } | null = null;
      for (const relic of relics) {
        if (state.collectedRelicIds.includes(relic.id)) continue;
        if (rt.orderedCheckpoints && relic.id !== next) continue; // only the next checkpoint can be collected
        const d = dist({ x: player.x, z: player.z }, relic.pos);
        if (d <= GEOMETRY.relicPickupRadius && (!best || d < best.d)) best = { id: relic.id, d };
      }
      if (best && session.collectRelic(best.id, player.id)) {
        state.score += SCORING.relic;
        this.o.events.emit({ name: 'relic.collected', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { relicId: best.id, playerId: player.id, tick: state.tick } });
        this.o.hooks.onRelicCollected?.(best.id, player.id);
      }
    }
  }

  /** Ping (edge, one beacon per second per player) and emote (edge, wave for EMOTE_DURATION_MS). */
  private handleButtons(player: PlayerState, prt: PlayerRuntime, fresh: boolean, now: number): void {
    const pingHeld = fresh && prt.buttons.ping;
    const pingPressed = pingHeld && !prt.pingPrev;
    prt.pingPrev = pingHeld;
    if (pingPressed && now - prt.lastPingAtMs >= PING_MIN_INTERVAL_MS) {
      prt.lastPingAtMs = now;
      const marker: MarkerMessage = { type: 'marker', playerId: player.id, color: player.color, x: round3(player.x), z: round3(player.z), until: now + PING_LIFETIME_MS };
      const state = this.o.session.state;
      this.o.events.emit({ name: 'player.ping', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId: player.id, x: marker.x, z: marker.z, tick: state.tick } });
      this.o.hooks.onMarker?.(marker);
    }
    const emoteHeld = fresh && prt.buttons.emote;
    const emotePressed = emoteHeld && !prt.emotePrev;
    prt.emotePrev = emoteHeld;
    if (emotePressed) prt.emoteUntilMs = now + EMOTE_DURATION_MS;
  }

  private updateGate(rt: ModeRuntime, spec: WorldSpec): void {
    const { session } = this.o;
    const state = session.state;
    const unlocked = this.gateShouldUnlock(rt, spec);
    if (unlocked && !state.gateUnlocked) {
      state.gateUnlocked = true;
      this.o.events.emit({ name: 'gate.unlocked', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { tick: state.tick } });
      this.o.hooks.onGateUnlocked?.();
    } else if (!unlocked && state.gateUnlocked) {
      state.gateUnlocked = false;
    }
    if (state.won || rt.lost || !this.cache?.gate) return;
    const gate = this.cache.gate;
    if (rt.kind === 'king_of_the_hill') {
      for (const player of session.playersInSlotOrder()) {
        if (player.status !== 'active' || !player.connected) continue;
        if (dist({ x: player.x, z: player.z }, gate) > GEOMETRY.gateTriggerRadius) continue;
        const held = (rt.holdMs.get(player.id) ?? 0) + TICK_MS;
        rt.holdMs.set(player.id, held);
        if (held >= rt.holdSeconds * 1000) {
          this.win(player.id);
          break;
        }
      }
      return;
    }
    if (!state.gateUnlocked) return;
    for (const player of session.playersInSlotOrder()) {
      if (player.status !== 'active' || !player.connected) continue;
      if (dist({ x: player.x, z: player.z }, gate) <= GEOMETRY.gateTriggerRadius) {
        this.win(player.id);
        break;
      }
    }
  }

  private win(playerId: string): void {
    const state = this.o.session.state;
    state.won = true;
    state.score += SCORING.win;
    this.o.events.emit({ name: 'session.won', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId, score: state.score, mode: this.modeRt?.kind } });
    this.o.hooks.onWin?.(playerId);
  }

  // ---- commits ----
  enqueueCommit(candidate: Candidate, proofId: string, reason: 'commit' | 'undo' = 'commit'): Promise<CommitResult> {
    return new Promise<CommitResult>((resolve) => {
      this.queue.push({ candidate, proofId, reason, enqueuedAt: this.o.clock.now(), deferredSince: null, blockers: [], resolve });
    });
  }

  private processCommitQueue(now: number): void {
    while (this.queue.length) {
      const pending = this.queue[0];
      const outcome = this.tryCommit(pending, now);
      if (outcome === 'deferred') return; // keep FIFO order; retry next tick
      this.queue.shift();
    }
  }

  private finishPending(pending: PendingCommit, result: CommitResult): void {
    this.o.candidates.recordCommitted(pending.candidate, result);
    this.o.hooks.onCommitResolved?.(pending, result);
    pending.resolve(result);
  }

  private tryCommit(pending: PendingCommit, now: number): 'done' | 'deferred' {
    const { session, world, candidates } = this.o;
    const cand = pending.candidate;
    const state = session.state;

    if (candidates.hasCommitted(cand)) {
      const pre = candidates.precheck(cand.candidateId, pending.proofId, world.version, now);
      this.finishPending(pending, pre.ok ? { ok: false, code: 'INTERNAL', message: 'commit state mismatch', objectIds: [], retryable: false } : pre.result);
      return 'done';
    }
    if (cand.baseWorldVersion !== world.version) {
      this.finishPending(pending, {
        ok: false, code: 'STALE_WORLD_VERSION',
        message: `candidate base version ${cand.baseWorldVersion} is not the current version ${world.version}`,
        objectIds: [cand.candidateId], retryable: false,
      });
      return 'done';
    }
    const proof = candidates.proof(pending.proofId);
    if (!proof || proof.candidateDigest !== cand.digest) {
      this.finishPending(pending, { ok: false, code: 'NOT_VALIDATED', message: 'validation proof missing at commit time', objectIds: [cand.candidateId], retryable: false });
      return 'done';
    }
    if (proof.expiresAt <= now) {
      this.finishPending(pending, { ok: false, code: 'VALIDATION_EXPIRED', message: 'validation proof expired while waiting for a safe commit', objectIds: [cand.candidateId], retryable: true });
      return 'done';
    }

    let compiled = cand.compiled;
    try {
      if (!compiled) {
        compiled = compileWorld(cand.spec);
        cand.compiled = compiled;
      }
    } catch (err) {
      this.finishPending(pending, { ok: false, code: 'INTERNAL', message: `compile failed: ${err instanceof Error ? err.message : String(err)}`, objectIds: [cand.candidateId], retryable: false });
      return 'done';
    }

    if (cand.kind === 'patch') {
      const blockers: string[] = [];
      const surfaceIds = new Set(compiled.surfaces.map((s) => s.id));
      for (const player of session.playersInSlotOrder()) {
        if (!player.connected || player.status !== 'active') continue;
        const supported = player.supportId !== null && surfaceIds.has(player.supportId);
        const fits = compiled.fits(player.x, player.z, { gateOpen: state.gateUnlocked });
        if (!supported || !fits) blockers.push(player.id);
      }
      if (blockers.length) {
        if (pending.deferredSince === null) {
          pending.deferredSince = now;
          this.o.events.emit({
            name: 'commit.deferred', requestId: cand.requestId, worldVersion: world.version, outcome: 'deferred', codes: ['OCCUPIED_SUPPORT'],
            data: { candidateId: cand.candidateId, patchId: cand.patchId, players: blockers },
          });
          pending.blockers = blockers;
          this.o.hooks.onCommitDeferred?.(pending);
        }
        pending.blockers = blockers;
        if (now - pending.deferredSince >= SIMULATION.commitDeferMaxMs) {
          const result: CommitResult = {
            ok: false, code: 'OCCUPIED_SUPPORT',
            message: `players are standing on a surface the patch removes or changes: ${blockers.join(', ')}; retry once they move`,
            objectIds: blockers, retryable: true,
          };
          this.o.events.emit({
            name: 'commit.rejected', requestId: cand.requestId, worldVersion: world.version, outcome: 'fail', codes: ['OCCUPIED_SUPPORT'],
            durationMs: now - pending.deferredSince, data: { candidateId: cand.candidateId, patchId: cand.patchId, players: blockers },
          });
          this.finishPending(pending, result);
          return 'done';
        }
        return 'deferred';
      }
    }

    // ---- swap ----
    const newVersion = cand.baseWorldVersion + 1;
    const spec: WorldSpec = { ...cand.spec, worldVersion: newVersion };
    let newCompiled: CompiledWorld;
    try {
      newCompiled = compileWorld(spec);
    } catch (err) {
      this.finishPending(pending, { ok: false, code: 'INTERNAL', message: `compile failed: ${err instanceof Error ? err.message : String(err)}`, objectIds: [cand.candidateId], retryable: false });
      return 'done';
    }
    const previousMode = JSON.stringify(world.current?.spec.mode ?? null);
    world.swap(spec, newVersion, newCompiled);
    if (pending.reason === 'undo') world.consumeHistory();
    cand.compiled = null; // the live world owns its own compile; stale candidates must not pin old geometry
    candidates.dropStaleCompiled(newVersion);
    state.worldVersion = newVersion;
    state.worldId = spec.worldId;
    this.ensureCache(newVersion, spec, newCompiled);

    if (cand.kind === 'world') {
      session.resetForNewWorld();
      for (const player of state.players) {
        const spawn = this.spawnFor(player.slot);
        session.place(player, spawn.pos, newCompiled.supportAt(spawn.pos.x, spawn.pos.z), now);
      }
      this.resetMode(spec, newCompiled, now);
    } else {
      for (const player of state.players) {
        player.supportId = newCompiled.supportAt(player.x, player.z);
      }
      // A set_mode op resets the runtime even when it restates the current mode (an agent "restart the clock" is the
      // same mode again): applyPatch notes 'mode' in changedIds for every set_mode op.
      if (cand.changedIds.includes('mode') || JSON.stringify(spec.mode ?? null) !== previousMode || !this.modeRt) {
        // set_mode: timer and hold counters start over; players, relics, score and connections stay.
        this.resetMode(spec, newCompiled, now);
      } else {
        this.modeRt.flooded = null; // new geometry: rebuild the flooded view lazily
        this.updateHazard(this.modeRt, spec, newCompiled);
      }
    }
    state.objective = this.buildObjective(this.modeRt as ModeRuntime);

    const deferredMs = pending.deferredSince === null ? 0 : Math.max(0, now - pending.deferredSince);
    const result: CommitResult = {
      ok: true, worldVersion: newVersion, committedAtTick: state.tick, deferredMs, idempotentReplay: false,
    };
    if (cand.patchId) result.patchId = cand.patchId;
    this.o.events.emit({
      name: 'commit.ok', requestId: cand.requestId, worldVersion: newVersion, outcome: 'ok', durationMs: now - pending.enqueuedAt,
      data: { candidateId: cand.candidateId, patchId: cand.patchId, kind: cand.kind, changedIds: cand.changedIds.slice(0, 32), deferredMs, reason: pending.reason },
    });
    void this.o.persistence.writeWorldSnapshot(newVersion, spec, now).then(() => {
      this.o.events.emit({ name: 'snapshot.written', worldVersion: newVersion, data: { file: `world-v${newVersion}.json` } });
    });
    this.lastSessionSnapshotAt = now;
    void this.o.persistence.writeSession(session.snapshot());

    this.finishPending(pending, result);
    const message: WorldMessage = { type: 'world', reason: 'commit', version: newVersion, spec, changedIds: cand.changedIds };
    if (cand.patchSummary) message.patchSummary = cand.patchSummary;
    this.o.hooks.onWorld(message);
    return 'done';
  }

  // ---- messages ----
  playerViews(now: number = this.o.clock.now()): PlayerView[] {
    return this.o.session.playersInSlotOrder().map((p) => {
      const rt = this.o.session.runtimeOf(p, now);
      const fresh = isFresh(p, now);
      const sprinting = fresh && rt.buttons.sprint;
      return {
        id: p.id, slot: p.slot, label: p.label, color: p.color,
        x: round3(p.x), z: round3(p.z), y: round3(p.y), vx: round3(p.vx), vz: round3(p.vz), facingDeg: Math.round(p.facingDeg),
        status: p.status, connected: p.connected, supportId: p.supportId,
        sprinting, slow: fresh && !sprinting && rt.buttons.slow,
        emote: now < rt.emoteUntilMs ? 'wave' : null,
      };
    });
  }

  buildTickMessage(now: number): TickMessage {
    const state = this.o.session.state;
    const relics: Record<string, 'present' | 'collected'> = {};
    for (const r of this.o.world.current?.spec.relics ?? []) {
      relics[r.id] = state.collectedRelicIds.includes(r.id) ? 'collected' : 'present';
    }
    const message: TickMessage = {
      type: 'tick',
      tick: state.tick,
      worldVersion: this.o.world.version,
      serverMs: now,
      players: this.playerViews(now),
      relics,
      gate: { unlocked: state.gateUnlocked, won: state.won },
      score: state.score,
    };
    if (state.objective && this.o.world.current) message.objective = state.objective;
    return message;
  }

  /** Current world as a snapshot message, or null when there is no world. */
  worldMessage(reason: WorldMessage['reason']): WorldMessage | null {
    const active = this.o.world.current;
    if (!active) return null;
    return { type: 'world', reason, version: active.version, spec: active.spec };
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Connected with an input inside the input timeout: only then do axes and buttons apply. */
function isFresh(player: { connected: boolean; lastInputAtMs: number }, now: number): boolean {
  return player.connected && player.lastInputAtMs > 0 && now - player.lastInputAtMs <= SIMULATION.inputTimeoutMs;
}

/** sprint beats slow when both are held. */
function speedScaleOf(rt: PlayerRuntime): number {
  if (rt.buttons.sprint) return MOVEMENT_SCALES.sprint;
  if (rt.buttons.slow) return MOVEMENT_SCALES.slow;
  return 1;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

let speedProbe: boolean | null = null;
/**
 * Probes once whether stepMover already applies compiled.spec.movement.speed (the world package is adopting
 * effectiveSpeed in parallel). While it does not, the simulation scales the step length instead; axes cannot carry
 * speed because stepMover clamps them to the unit circle.
 */
function stepMoverHonoursSpeed(compiled: CompiledWorld): boolean {
  if (speedProbe !== null) return speedProbe;
  try {
    const speed = MODE_LIMITS.movementSpeed.max;
    const probe: CompiledWorld = {
      ...compiled,
      spec: { ...compiled.spec, movement: { speed } },
      supportAt: () => 'probe',
      blockedAt: () => null,
    };
    const mover: Mover = { x: 0, z: 0, vx: 0, vz: 0, facingDeg: 0, status: 'active', statusSinceMs: 0, supportId: 'probe' };
    const result = stepMover(probe, mover, { axes: { x: 1, z: 0 }, active: true }, 100, 0, { gateOpen: true, spawn: { x: 0, z: 0 } });
    speedProbe = Math.abs(result.mover.x - speed * 0.1) < 1e-6;
  } catch {
    speedProbe = false;
  }
  return speedProbe;
}
