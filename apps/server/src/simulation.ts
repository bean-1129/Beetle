// Authoritative 30 Hz simulation: movement, relics, gate, win, the commit queue and tick broadcasts.
import {
  GEOMETRY, SCORING, SIMULATION, dist,
  type CommitResult, type PlayerView, type TickMessage, type Vec2, type WorldMessage, type WorldSpec,
} from '@beetle/contracts';
import { compileWorld, stepMover, type CompiledWorld, type Mover } from '@beetle/world';
import type { EventLog } from '@beetle/observability';
import type { Candidate, CandidateStore } from './candidates.ts';
import { isFakeClock, type Clock } from './clock.ts';
import type { Persistence } from './persistence.ts';
import type { SessionStore } from './session.ts';
import type { WorldStore } from './world-store.ts';

export const TICK_MS = 1000 / SIMULATION.tickHz;
const SESSION_SNAPSHOT_EVERY_MS = 5000;

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

export class Simulation {
  readonly queue: PendingCommit[] = [];
  private timer: NodeJS.Timeout | null = null;
  private expectedAt = 0;
  private lastSessionSnapshotAt = 0;
  private cache: { version: number; worldId: string; relics: { id: string; pos: Vec2 }[]; gate: Vec2 | null; spawns: Map<string, { spawnId: string; pos: Vec2 }> } | null = null;
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
      this.movePlayers(active.compiled, now);
      this.handleInteractions(now);
      this.updateGate(active.spec);
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

  private movePlayers(compiled: CompiledWorld, now: number): void {
    const { session, world } = this.o;
    const state = session.state;
    for (const player of session.playersInSlotOrder()) {
      const rt = session.runtimeOf(player, now);
      const fresh = player.connected && player.lastInputAtMs > 0 && now - player.lastInputAtMs <= SIMULATION.inputTimeoutMs;
      const mover: Mover = {
        x: player.x, z: player.z, vx: player.vx, vz: player.vz, facingDeg: player.facingDeg,
        status: player.status, statusSinceMs: rt.statusSinceMs, supportId: player.supportId,
      };
      const spawn = this.spawnFor(player.slot);
      let result;
      try {
        result = stepMover(compiled, mover, { axes: fresh ? rt.axes : { x: 0, z: 0 }, active: fresh }, TICK_MS, now, { gateOpen: state.gateUnlocked, spawn: spawn.pos });
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
            state.score -= world.hazardPenalty();
          }
          this.o.events.emit({ name: 'player.hazard', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId: player.id, hazard: kind } });
        } else if (ev === 'fell') {
          this.o.events.emit({ name: 'player.fell', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId: player.id, supportId: player.supportId } });
        }
      }
      // Cosmetic height: sink while falling, back to the platform otherwise.
      if (player.status === 'falling') {
        const t = Math.min(1, Math.max(0, (now - rt.statusSinceMs) / GEOMETRY.fallDurationMs));
        player.y = world.hazardElevation() * t;
      } else {
        player.y = 0;
      }
    }
  }

  private handleInteractions(now: number): void {
    const { session } = this.o;
    const state = session.state;
    const relics = this.cache?.relics ?? [];
    for (const player of session.playersInSlotOrder()) {
      const rt = session.runtimeOf(player, now);
      const fresh = player.connected && now - player.lastInputAtMs <= SIMULATION.inputTimeoutMs;
      const held = fresh && rt.interact;
      const pressed = held && !rt.interactPrev;
      rt.interactPrev = held;
      if (!pressed || player.status !== 'active') continue;
      let best: { id: string; d: number } | null = null;
      for (const relic of relics) {
        if (state.collectedRelicIds.includes(relic.id)) continue;
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

  private updateGate(spec: WorldSpec): void {
    const { session } = this.o;
    const state = session.state;
    const required = spec.gate.requiredRelicIds;
    const unlocked = required.length > 0 && required.every((id) => state.collectedRelicIds.includes(id));
    if (unlocked && !state.gateUnlocked) {
      state.gateUnlocked = true;
      this.o.events.emit({ name: 'gate.unlocked', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { tick: state.tick } });
      this.o.hooks.onGateUnlocked?.();
    } else if (!unlocked && state.gateUnlocked) {
      state.gateUnlocked = false;
    }
    if (state.gateUnlocked && !state.won && this.cache?.gate) {
      const gate = this.cache.gate;
      for (const player of session.playersInSlotOrder()) {
        if (player.status !== 'active' || !player.connected) continue;
        if (dist({ x: player.x, z: player.z }, gate) <= GEOMETRY.gateTriggerRadius) {
          state.won = true;
          state.score += SCORING.win;
          this.o.events.emit({ name: 'session.won', sessionId: state.sessionId, worldVersion: state.worldVersion, data: { playerId: player.id, score: state.score } });
          this.o.hooks.onWin?.(player.id);
          break;
        }
      }
    }
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
    world.swap(spec, newVersion, newCompiled);
    if (pending.reason === 'undo') world.consumeHistory();
    state.worldVersion = newVersion;
    state.worldId = spec.worldId;
    this.ensureCache(newVersion, spec, newCompiled);

    if (cand.kind === 'world') {
      session.resetForNewWorld();
      for (const player of state.players) {
        const spawn = this.spawnFor(player.slot);
        session.place(player, spawn.pos, newCompiled.supportAt(spawn.pos.x, spawn.pos.z), now);
      }
    } else {
      for (const player of state.players) {
        player.supportId = newCompiled.supportAt(player.x, player.z);
      }
    }

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
  playerViews(): PlayerView[] {
    return this.o.session.playersInSlotOrder().map((p) => ({
      id: p.id, slot: p.slot, label: p.label, color: p.color,
      x: round3(p.x), z: round3(p.z), y: round3(p.y), vx: round3(p.vx), vz: round3(p.vz), facingDeg: Math.round(p.facingDeg),
      status: p.status, connected: p.connected, supportId: p.supportId,
    }));
  }

  buildTickMessage(now: number): TickMessage {
    const state = this.o.session.state;
    const relics: Record<string, 'present' | 'collected'> = {};
    for (const r of this.o.world.current?.spec.relics ?? []) {
      relics[r.id] = state.collectedRelicIds.includes(r.id) ? 'collected' : 'present';
    }
    return {
      type: 'tick',
      tick: state.tick,
      worldVersion: this.o.world.version,
      serverMs: now,
      players: this.playerViews(),
      relics,
      gate: { unlocked: state.gateUnlocked, won: state.won },
      score: state.score,
    };
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
