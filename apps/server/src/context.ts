// Shared server context passed to the HTTP routes and the WebSocket hub.
import type { SessionSummary } from '@beetle/contracts';
import type { EventLog } from '@beetle/observability';
import type { LiveContext } from '@beetle/world';
import type { CandidateStore } from './candidates.ts';
import type { Clock } from './clock.ts';
import type { ExpansionScheduler } from './expansion.ts';
import type { ServerConfig } from './config.ts';
import type { Persistence } from './persistence.ts';
import type { RequestStore } from './requests.ts';
import type { Secrets } from './secrets.ts';
import type { SessionStore } from './session.ts';
import type { Simulation } from './simulation.ts';
import type { WorldStore } from './world-store.ts';
import type { WsHub } from './ws.ts';

export type ModelStatus = { name: string; reachable: boolean; present: boolean };

export type ServerContext = {
  config: ServerConfig;
  secrets: Secrets;
  clock: Clock;
  events: EventLog;
  persistence: Persistence;
  session: SessionStore;
  world: WorldStore;
  candidates: CandidateStore;
  requests: RequestStore;
  sim: Simulation;
  hub: WsHub;
  /** Streaming generation: automatic add_island requests near island rims. */
  expansion: ExpansionScheduler;
  startedAt: number;
  publicUrl(): string;
  modelStatus(): Promise<ModelStatus>;
  liveContext(): LiveContext;
  summary(): SessionSummary | null;
  /** Places a player at the spawn of their slot when a world exists. */
  placeAtSpawn(playerId: string): void;
};
