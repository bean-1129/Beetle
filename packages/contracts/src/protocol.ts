import { z } from 'zod';
import { SIMULATION } from './limits.ts';
import type { WorldSpec } from './world.ts';
import type { PlayerStatus, ObjectiveState } from './session.ts';
import type { ValidationCode } from './validation.ts';

// ---------- WebSocket: client -> server (validated server-side with these schemas) ----------
export const HelloSchema = z.discriminatedUnion('role', [
  z.object({ type: z.literal('hello'), role: z.literal('controller'), token: z.string().min(8).max(128), lastSeq: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('hello'), role: z.literal('display'), worldVersion: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('hello'), role: z.literal('director'), token: z.string().min(8).max(128) }).strict(),
]);
/** Controller buttons. interact = collect/open (cross), sprint = hold to run (circle or R2), slow = precision walk (L2),
 *  ping = drop a team beacon on the shared screen (triangle), emote = wave (square). All optional for older clients. */
export const ButtonsSchema = z.object({
  sprint: z.boolean().optional(),
  slow: z.boolean().optional(),
  ping: z.boolean().optional(),
  emote: z.boolean().optional(),
}).strict();
export const InputSchema = z.object({
  type: z.literal('input'),
  seq: z.number().int().min(0).max(2 ** 31),
  axes: z.object({ x: z.number().finite().min(-1).max(1), z: z.number().finite().min(-1).max(1) }).strict(),
  interact: z.boolean(),
  buttons: ButtonsSchema.optional(),
  t: z.number().finite().optional(), // client clock, echoed in ack for RTT only
}).strict();
export const MOVEMENT_SCALES = { sprint: 1.35, slow: 0.5 } as const;
export const PING_LIFETIME_MS = 3000;
export const EMOTE_DURATION_MS = 1500;
export const PingSchema = z.object({ type: z.literal('ping'), t: z.number().finite() }).strict();
export const AckSchema = z.object({ type: z.literal('ack'), worldVersion: z.number().int().min(0) }).strict();
export const ResyncSchema = z.object({ type: z.literal('resync'), haveVersion: z.number().int().min(0) }).strict();
export const ClientMessageSchema = z.union([HelloSchema, InputSchema, PingSchema, AckSchema, ResyncSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HelloMessage = z.infer<typeof HelloSchema>;
export type InputMessage = z.infer<typeof InputSchema>;
export const MAX_MESSAGE_BYTES = SIMULATION.maxMessageBytes;

// ---------- WebSocket: server -> client ----------
export type PlayerView = {
  id: string; slot: 0 | 1; label: string; color: string;
  x: number; z: number; y: number; vx: number; vz: number; facingDeg: number;
  status: PlayerStatus; connected: boolean; supportId: string | null;
  sprinting?: boolean; slow?: boolean;
  emote?: 'wave' | null; // set for EMOTE_DURATION_MS after a square press
};
/** Raw phone pad state relayed to display and director sockets (at most 30 per second per player), so pages
 *  other than the 3D simulation (the 2D studio) can drive their own games with the same phones. */
export type PadMessage = {
  type: 'pad';
  playerId: string;
  slot: 0 | 1;
  seq: number;
  axes: { x: number; z: number };
  interact: boolean;
  buttons: { sprint: boolean; slow: boolean; ping: boolean; emote: boolean };
};
/** A team beacon placed by a player (triangle); shown on the shared screen for PING_LIFETIME_MS. */
export type MarkerMessage = { type: 'marker'; playerId: string; color: string; x: number; z: number; until: number };
export type TickMessage = {
  type: 'tick';
  tick: number;
  worldVersion: number;
  serverMs: number;
  players: PlayerView[];
  relics: Record<string, 'present' | 'collected'>;
  gate: { unlocked: boolean; won: boolean };
  score: number;
  objective?: ObjectiveState; // mode-dependent objective state (timer, hold, next checkpoint, hazard elevation)
  lastInputSeq?: number; // for controllers: last seq the server applied for this player
};
export type WorldMessage = {
  type: 'world';
  reason: 'snapshot' | 'commit' | 'resync';
  version: number;
  spec: WorldSpec;
  patchSummary?: string;
  changedIds?: string[];
};
export type WelcomeMessage = {
  type: 'welcome';
  role: 'controller' | 'display' | 'director';
  protocolVersion: number;
  playerId?: string;
  playerLabel?: string;
  playerColor?: string;
  worldVersion: number;
  tick: number;
  tickHz: number;
};
export type ActivityMessage = { type: 'activity'; entries: AgentActivity[] };
export type ErrorMessage = { type: 'error'; code: string; message: string };
export type PongMessage = { type: 'pong'; t: number; serverMs: number };
export type ControllerStatusMessage = { type: 'controllers'; players: { id: string; label: string; connected: boolean; lastInputAgeMs: number | null }[] };
export type ServerMessage = TickMessage | WorldMessage | WelcomeMessage | ActivityMessage | ErrorMessage | PongMessage | ControllerStatusMessage | MarkerMessage | PadMessage;

// ---------- Agent activity / requests / reports ----------
export const AGENT_PHASES = ['queued', 'planning', 'validating', 'repairing', 'awaiting_safe_commit', 'committed', 'failed', 'cancelled'] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];
export type AgentActivity = {
  id: string;
  requestId: string;
  phase: AgentPhase;
  message: string; // concise, product copy; no chain-of-thought
  at: number; // wall clock ms
  elapsedMs: number; // since request creation
  worldVersion?: number;
  tool?: string;
  codes?: ValidationCode[];
  objectIds?: string[];
};
export const REQUEST_KINDS = ['brief', 'edit'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type DirectorRequest = {
  id: string;
  kind: RequestKind;
  prompt: string;
  /** true when Beetle created the request itself (streaming extension ahead of a player). */
  auto?: boolean;
  autoReason?: { islandId: string; direction: string; playerId: string };
  createdAt: number;
  worldVersionAtRequest: number;
  status: AgentPhase;
  claimedBy?: string;
  finishedAt?: number;
  resultWorldVersion?: number;
  reportId?: string;
  error?: { code: string; message: string };
};
export type BuildReport = {
  reportId: string;
  requestId: string;
  mode: 'openclaw' | 'direct';
  model: string;
  outcome: 'committed' | 'failed' | 'cancelled';
  worldVersion: number;
  baseWorldVersion: number;
  summary: string;
  validation: { attempts: number; failedCodes: ValidationCode[] };
  playability?: { ok: boolean; checks: number; failed: number };
  timings: { requestedAt: number; firstModelResponseMs?: number; validatedMs?: number; committedMs?: number; totalMs: number };
  toolCalls: { tool: string; ok: boolean; ms: number }[];
  preserved?: { players: number; collectedRelics: number; connections: number };
  createdAt: number;
};

// ---------- HTTP DTOs ----------
export const JoinRequestSchema = z.object({ inviteCode: z.string().min(4).max(64) }).strict();
export const DirectorSettingsBodySchema = z.object({ autoExpand: z.boolean().optional() }).strict();
export const DirectorRequestBodySchema = z.object({
  kind: z.enum(REQUEST_KINDS),
  prompt: z.string().min(1).max(1000).regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/),
  authorizeNewWorld: z.boolean().optional(),
}).strict();
export const ProposeWorldBodySchema = z.object({ requestId: z.string().max(64), spec: z.unknown() }).strict();
export const ProposePatchBodySchema = z.object({ requestId: z.string().max(64), patch: z.unknown() }).strict();
export const CommitBodySchema = z.object({ proofId: z.string().min(16).max(64) }).strict();
export const AgentStatusBodySchema = z.object({
  phase: z.enum(AGENT_PHASES), message: z.string().max(400), tool: z.string().max(64).optional(),
  codes: z.array(z.string().max(40)).max(16).optional(), objectIds: z.array(z.string().max(64)).max(32).optional(),
}).strict();
export const ReportBodySchema = z.object({
  requestId: z.string().max(64), mode: z.enum(['openclaw', 'direct']), model: z.string().max(80),
  outcome: z.enum(['committed', 'failed', 'cancelled']), worldVersion: z.number().int().min(0), baseWorldVersion: z.number().int().min(0),
  summary: z.string().max(600),
  validation: z.object({ attempts: z.number().int().min(0), failedCodes: z.array(z.string().max(40)).max(32) }).strict(),
  playability: z.object({ ok: z.boolean(), checks: z.number().int(), failed: z.number().int() }).strict().optional(),
  timings: z.object({ requestedAt: z.number(), firstModelResponseMs: z.number().optional(), validatedMs: z.number().optional(), committedMs: z.number().optional(), totalMs: z.number() }).strict(),
  toolCalls: z.array(z.object({ tool: z.string().max(64), ok: z.boolean(), ms: z.number() }).strict()).max(64),
  preserved: z.object({ players: z.number().int(), collectedRelics: z.number().int(), connections: z.number().int() }).strict().optional(),
}).strict();

/** HTTP routes. Agent routes are loopback-only and require the agent token. Director routes require the director token. */
export const ROUTES = {
  health: '/api/health',
  world: '/api/world',
  directorInvite: '/api/director/invite',
  directorRequest: '/api/director/requests',
  directorRequestById: '/api/director/requests/:id',
  directorActivity: '/api/director/activity',
  directorReports: '/api/director/reports',
  directorUndo: '/api/director/undo',
  directorSettings: '/api/director/settings',
  /** Returns the director token only to requests that come from this machine (loopback or one of its own addresses). */
  directorBootstrap: '/api/director/bootstrap',
  join: '/api/join',
  agentWorld: '/api/agent/world',
  agentRequestsClaim: '/api/agent/requests/claim',
  agentRequestStatus: '/api/agent/requests/:id/status',
  agentRequestFinish: '/api/agent/requests/:id/finish',
  agentProposeWorld: '/api/agent/candidates/world',
  agentProposePatch: '/api/agent/candidates/patch',
  agentValidate: '/api/agent/candidates/:id/validate',
  agentPlayability: '/api/agent/candidates/:id/playability',
  agentCommit: '/api/agent/candidates/:id/commit',
  agentReports: '/api/agent/reports',
  ws: '/ws',
} as const;
