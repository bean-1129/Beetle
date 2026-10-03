// Authoritative session state: players, invites, controller tokens, relic tombstones, score.
import { randomBytes } from 'node:crypto';
import {
  GAME_MODES, PLAYER_COLORS, PLAYER_LABELS, type GameMode, type ObjectiveState, type PlayerState, type SessionState, type Vec2,
} from '@beetle/contracts';
import { hex32 } from './clock.ts';

export const INVITE_TTL_MS = 5 * 60 * 1000;

export type HeldButtons = { sprint: boolean; slow: boolean; ping: boolean; emote: boolean };
export const NO_BUTTONS: Readonly<HeldButtons> = Object.freeze({ sprint: false, slow: false, ping: false, emote: false });

export type PlayerRuntime = {
  axes: { x: number; z: number };
  interact: boolean;
  interactPrev: boolean;
  /** Buttons held with the last input (older clients send none: all false). */
  buttons: HeldButtons;
  pingPrev: boolean;
  emotePrev: boolean;
  lastPingAtMs: number;
  emoteUntilMs: number;
  statusSinceMs: number;
  windowStartMs: number;
  windowCount: number;
  droppedInputs: number;
};

export type Invite = { code: string; slot: 0 | 1; createdAt: number; expiresAt: number; used: boolean };

export type JoinResult =
  | { ok: true; controllerToken: string; playerId: string; label: string; color: string; slot: 0 | 1 }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

export function playerIdForSlot(slot: 0 | 1): string {
  return `player-${slot}`;
}

export class SessionStore {
  readonly state: SessionState;
  readonly runtime = new Map<string, PlayerRuntime>();
  readonly invites = new Map<string, Invite>();
  /** controllerToken -> playerId. Re-inviting a slot replaces the slot's token. */
  readonly controllerTokens = new Map<string, string>();

  constructor(sessionId: string = `session-${randomBytes(4).toString('hex')}`) {
    this.state = {
      sessionId,
      worldId: '',
      worldVersion: 0,
      tick: 0,
      elapsedMs: 0,
      players: [],
      collectedRelicIds: [],
      relicTombstones: {},
      gateUnlocked: false,
      won: false,
      score: 0,
    };
  }

  player(id: string): PlayerState | undefined {
    return this.state.players.find((p) => p.id === id);
  }

  playerForSlot(slot: 0 | 1): PlayerState | undefined {
    return this.state.players.find((p) => p.slot === slot);
  }

  /** Players in slot order so ties in the same tick resolve deterministically. */
  playersInSlotOrder(): PlayerState[] {
    return [...this.state.players].sort((a, b) => a.slot - b.slot);
  }

  runtimeOf(player: PlayerState, now: number): PlayerRuntime {
    let rt = this.runtime.get(player.id);
    if (!rt) {
      rt = {
        axes: { x: 0, z: 0 }, interact: false, interactPrev: false, buttons: { ...NO_BUTTONS }, pingPrev: false, emotePrev: false, lastPingAtMs: 0, emoteUntilMs: 0,
        statusSinceMs: now, windowStartMs: now, windowCount: 0, droppedInputs: 0,
      };
      this.runtime.set(player.id, rt);
    }
    return rt;
  }

  ensurePlayer(slot: 0 | 1, now: number): PlayerState {
    const existing = this.playerForSlot(slot);
    if (existing) return existing;
    const player: PlayerState = {
      id: playerIdForSlot(slot),
      slot,
      label: PLAYER_LABELS[slot],
      color: PLAYER_COLORS[slot],
      x: 0, z: 0, y: 0,
      vx: 0, vz: 0,
      facingDeg: 0,
      status: 'disconnected',
      connected: false,
      lastInputSeq: 0,
      lastInputAtMs: 0,
      supportId: null,
      respawns: 0,
      lavaFalls: 0,
    };
    this.state.players.push(player);
    this.state.players.sort((a, b) => a.slot - b.slot);
    this.runtimeOf(player, now);
    return player;
  }

  /** Slot for the next invite: first slot nobody joined, then first slot not connected, else slot 0. */
  pickSlot(): 0 | 1 {
    for (const slot of [0, 1] as const) if (!this.playerForSlot(slot)) return slot;
    for (const slot of [0, 1] as const) if (!this.playerForSlot(slot)?.connected) return slot;
    return 0;
  }

  createInvite(slot: 0 | 1 | undefined, now: number): Invite {
    this.pruneInvites(now);
    const invite: Invite = {
      code: randomBytes(6).toString('hex'),
      slot: slot ?? this.pickSlot(),
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
      used: false,
    };
    this.invites.set(invite.code, invite);
    return invite;
  }

  pruneInvites(now: number): void {
    for (const [code, inv] of this.invites) {
      if (inv.expiresAt <= now || inv.used) this.invites.delete(code);
    }
  }

  join(code: string, now: number): JoinResult {
    const invite = this.invites.get(code);
    if (!invite) return { ok: false, reason: 'unknown' };
    if (invite.used) return { ok: false, reason: 'used' };
    if (invite.expiresAt <= now) {
      this.invites.delete(code);
      return { ok: false, reason: 'expired' };
    }
    invite.used = true;
    this.invites.delete(code);
    const player = this.ensurePlayer(invite.slot, now);
    // Replace any older token for this slot so a re-invited phone takes over cleanly.
    for (const [token, pid] of this.controllerTokens) {
      if (pid === player.id) this.controllerTokens.delete(token);
    }
    const controllerToken = hex32();
    this.controllerTokens.set(controllerToken, player.id);
    return { ok: true, controllerToken, playerId: player.id, label: player.label, color: player.color, slot: player.slot };
  }

  playerForToken(token: string): PlayerState | null {
    const id = this.controllerTokens.get(token);
    return id ? this.player(id) ?? null : null;
  }

  place(player: PlayerState, pos: Vec2, supportId: string | null, now: number): void {
    player.x = pos.x;
    player.z = pos.z;
    player.y = 0;
    player.vx = 0;
    player.vz = 0;
    player.supportId = supportId;
    if (player.status !== 'disconnected') player.status = 'active';
    this.runtimeOf(player, now).statusSinceMs = now;
  }

  markConnected(player: PlayerState, now: number): void {
    player.connected = true;
    if (player.status === 'disconnected') {
      player.status = 'active';
      this.runtimeOf(player, now).statusSinceMs = now;
    }
  }

  markDisconnected(player: PlayerState, now: number): void {
    player.connected = false;
    player.vx = 0;
    player.vz = 0;
    const rt = this.runtimeOf(player, now);
    rt.axes = { x: 0, z: 0 };
    rt.interact = false;
    rt.interactPrev = false;
    rt.buttons = { ...NO_BUTTONS };
    if (player.status === 'active') {
      player.status = 'disconnected';
      rt.statusSinceMs = now;
    }
  }

  connectedControllers(): number {
    return this.state.players.filter((p) => p.connected).length;
  }

  collectRelic(relicId: string, byPlayerId: string): boolean {
    if (this.state.collectedRelicIds.includes(relicId)) return false;
    this.state.collectedRelicIds.push(relicId);
    this.state.relicTombstones[relicId] = { byPlayerId, atTick: this.state.tick, worldVersion: this.state.worldVersion };
    return true;
  }

  /** New world: relics, gate, win and score start over. Players keep ids and connections. */
  resetForNewWorld(): void {
    this.state.collectedRelicIds = [];
    this.state.relicTombstones = {};
    this.state.gateUnlocked = false;
    this.state.won = false;
    this.state.score = 0;
    delete this.state.objective;
    for (const p of this.state.players) {
      p.respawns = 0;
      p.lavaFalls = 0;
    }
  }

  /**
   * Restores gameplay progress from a persisted session snapshot (restart): collected relics, tombstones, score, gate,
   * win, tick and per-player stats. Players come back disconnected (controller tokens are not persisted); unknown relic
   * ids are dropped. Returns false when the snapshot belongs to another world.
   */
  restore(saved: SessionState, worldId: string, knownRelicIds: string[]): boolean {
    if (saved.worldId !== worldId) return false;
    const known = new Set(knownRelicIds);
    const collected = [...new Set(saved.collectedRelicIds.filter((id) => typeof id === 'string' && known.has(id)))];
    this.state.collectedRelicIds = collected;
    this.state.relicTombstones = {};
    for (const id of collected) {
      const t = saved.relicTombstones?.[id];
      if (t && typeof t.byPlayerId === 'string') this.state.relicTombstones[id] = { byPlayerId: t.byPlayerId, atTick: Number(t.atTick) || 0, worldVersion: Number(t.worldVersion) || 0 };
    }
    this.state.score = Number.isFinite(saved.score) ? Math.max(0, Math.floor(saved.score)) : 0;
    this.state.gateUnlocked = saved.gateUnlocked === true;
    this.state.won = saved.won === true;
    this.state.tick = Number.isInteger(saved.tick) && saved.tick > 0 ? saved.tick : 0;
    this.state.elapsedMs = Number.isFinite(saved.elapsedMs) && saved.elapsedMs > 0 ? saved.elapsedMs : 0;
    const objective = sanitizeObjective(saved.objective);
    if (objective) this.state.objective = objective;
    else delete this.state.objective;
    for (const p of saved.players) {
      if (!p || (p.slot !== 0 && p.slot !== 1)) continue;
      const player = this.ensurePlayer(p.slot, 0);
      player.respawns = Number.isInteger(p.respawns) ? p.respawns : 0;
      player.lavaFalls = Number.isInteger(p.lavaFalls) ? p.lavaFalls : 0;
      player.connected = false;
      player.status = 'disconnected';
      player.lastInputSeq = 0;
      player.lastInputAtMs = 0;
    }
    return true;
  }

  snapshot(): SessionState {
    return JSON.parse(JSON.stringify(this.state)) as SessionState;
  }
}

/** Objective state from a snapshot file: unknown kinds or malformed fields are dropped, never trusted. */
export function sanitizeObjective(raw: unknown): ObjectiveState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ObjectiveState>;
  if (typeof o.kind !== 'string' || !(GAME_MODES as readonly string[]).includes(o.kind)) return null;
  const out: ObjectiveState = { kind: o.kind as GameMode };
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const remainingSec = num(o.remainingSec);
  if (remainingSec !== undefined) out.remainingSec = Math.max(0, remainingSec);
  if (o.lost === true) out.lost = true;
  else if (o.lost === false) out.lost = false;
  if (o.holdSec && typeof o.holdSec === 'object') {
    const hold: Record<string, number> = {};
    for (const [id, v] of Object.entries(o.holdSec)) {
      const n = num(v);
      if (typeof id === 'string' && n !== undefined && n >= 0) hold[id] = n;
    }
    out.holdSec = hold;
  }
  const holdTarget = num(o.holdTarget);
  if (holdTarget !== undefined) out.holdTarget = holdTarget;
  if (o.nextCheckpointId === null || typeof o.nextCheckpointId === 'string') out.nextCheckpointId = o.nextCheckpointId;
  const relicsRequired = num(o.relicsRequired);
  if (relicsRequired !== undefined) out.relicsRequired = relicsRequired;
  const hazardElevation = num(o.hazardElevation);
  if (hazardElevation !== undefined) out.hazardElevation = hazardElevation;
  return out;
}
