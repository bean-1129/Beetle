import { z } from 'zod';
import type { CompassName } from './geometry.ts';
import type { GameMode } from './limits.ts';

export const PLAYER_STATUSES = ['active', 'falling', 'respawning', 'disconnected'] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

/** Authoritative per-player state. Only the server writes it. */
export type PlayerState = {
  id: string;
  slot: 0 | 1;
  label: string;
  color: string;
  x: number; z: number; y: number;
  vx: number; vz: number;
  facingDeg: number;
  status: PlayerStatus;
  connected: boolean;
  lastInputSeq: number;
  lastInputAtMs: number; // server monotonic ms
  supportId: string | null; // island or bridge id currently under the player
  respawns: number;
  lavaFalls: number;
};

export type RelicTombstone = { byPlayerId: string; atTick: number; worldVersion: number };

/** Authoritative gameplay state, separate from WorldSpec (structure) and PresentationState (client-only). */
export type SessionState = {
  sessionId: string;
  worldId: string;
  worldVersion: number;
  tick: number;
  elapsedMs: number;
  players: PlayerState[];
  collectedRelicIds: string[];
  relicTombstones: Record<string, RelicTombstone>;
  gateUnlocked: boolean;
  won: boolean;
  score: number;
  /** Mode-dependent objective state; absent fields mean not applicable. */
  objective?: ObjectiveState;
};

export type ObjectiveState = {
  kind: GameMode;
  remainingSec?: number;      // time_trial, survival
  lost?: boolean;             // timer expired (time_trial, survival)
  holdSec?: Record<string, number>; // king_of_the_hill: seconds each player has held the zone
  holdTarget?: number;        // king_of_the_hill
  nextCheckpointId?: string | null; // checkpoint_race
  relicsRequired?: number;    // relic_hunt
  hazardElevation?: number;   // survival: current plane elevation
};

/** Compact summary the agent reads. Never includes tokens or raw positions beyond a surface id. */
export type SessionSummary = {
  worldVersion: number;
  worldTitle: string;
  elapsedSec: number;
  players: { id: string; label: string; onSurfaceId: string | null; status: PlayerStatus; connected: boolean }[];
  collectedRelicIds: string[];
  remainingRelicIds: string[];
  gateUnlocked: boolean;
  won: boolean;
  score: number;
  mode?: { kind: GameMode; timeLimitSec?: number | null; holdSeconds?: number; relicsRequired?: number };
  biome?: string;
  islands: { id: string; name: string; compass: CompassName; bridgeIds: string[] }[];
};

export const SessionSummarySchema = z.object({
  worldVersion: z.number().int(),
  worldTitle: z.string(),
  elapsedSec: z.number(),
  players: z.array(z.object({ id: z.string(), label: z.string(), onSurfaceId: z.string().nullable(), status: z.enum(PLAYER_STATUSES), connected: z.boolean() })),
  collectedRelicIds: z.array(z.string()),
  remainingRelicIds: z.array(z.string()),
  gateUnlocked: z.boolean(),
  won: z.boolean(),
  score: z.number(),
  islands: z.array(z.object({ id: z.string(), name: z.string(), compass: z.string(), bridgeIds: z.array(z.string()) })),
});
