// createBeetleServer: assembles config, secrets, stores, simulation, HTTP and WebSocket for main.ts and in-process tests.
import Fastify, { type FastifyInstance } from 'fastify';
import { WORLD_LIMITS, WorldSpecSchema, type SessionState, type WorldSpec } from '@beetle/contracts';
import { createEventLog, type EventLog } from '@beetle/observability';
import { buildSessionSummary, fixtureWorld, type LiveContext } from '@beetle/world';
import { isLoopbackUrl } from './auth.ts';
import { CandidateStore } from './candidates.ts';
import { systemClock, type Clock } from './clock.ts';
import { configFromEnv, derivePublicUrl, type ServerConfig } from './config.ts';
import type { ModelStatus, ServerContext } from './context.ts';
import { registerRoutes } from './http.ts';
import { createPersistence } from './persistence.ts';
import { RequestStore } from './requests.ts';
import { loadSecrets, type Secrets } from './secrets.ts';
import { SessionStore } from './session.ts';
import { Simulation } from './simulation.ts';
import { WorldStore } from './world-store.ts';
import { createWsHub, type WsHub } from './ws.ts';

export type { ServerConfig } from './config.ts';
export type { Clock, FakeClock } from './clock.ts';
export { createFakeClock, systemClock } from './clock.ts';
export { TICK_MS } from './simulation.ts';
export type { Candidate } from './candidates.ts';

export type BeetleServerOptions = {
  host?: string;
  port?: number;
  dataDir?: string;
  publicUrl?: string | null;
  directorToken?: string;
  agentToken?: string;
  /** 'fixture' loads garden5 as version 1; a WorldSpec installs that spec; 'none' starts empty. */
  startWorld?: 'none' | 'fixture' | WorldSpec;
  /** Load data/snapshots/world-current.json when present (default true; tests usually pass false). */
  loadSnapshot?: boolean;
  tickMode?: 'interval' | 'manual';
  clock?: Clock;
  ollamaBaseUrl?: string;
  modelName?: string;
  webDistDir?: string | null;
  logRequests?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type BeetleServer = {
  app: FastifyInstance;
  config: ServerConfig;
  clock: Clock;
  tokens: { director: string; agent: string };
  secrets: Secrets;
  events: EventLog;
  session: SessionStore;
  world: WorldStore;
  candidates: CandidateStore;
  requests: RequestStore;
  sim: Simulation;
  hub: WsHub;
  start(): Promise<{ host: string; port: number; url: string; publicUrl: string }>;
  stop(): Promise<void>;
  /** Runs n simulation ticks (manual tick mode). */
  tick(n?: number): void;
  port(): number;
  publicUrl(): string;
  state: {
    session(): SessionState;
    worldVersion(): number;
    spec(): WorldSpec | null;
    liveContext(): LiveContext;
  };
  /** Non-secret startup facts for main.ts to print. */
  startupNotes(): string[];
};

const MODEL_CACHE_MS = 5000;
const MODEL_TIMEOUT_MS = 1500;

export async function createBeetleServer(opts: BeetleServerOptions = {}): Promise<BeetleServer> {
  const base = configFromEnv(opts.env ?? process.env);
  const config: ServerConfig = {
    ...base,
    host: opts.host ?? base.host,
    port: opts.port ?? base.port,
    publicUrl: opts.publicUrl === undefined ? base.publicUrl : opts.publicUrl,
    dataDir: opts.dataDir ?? base.dataDir,
    directorToken: opts.directorToken ?? base.directorToken,
    agentToken: opts.agentToken ?? base.agentToken,
    ollamaBaseUrl: opts.ollamaBaseUrl ?? base.ollamaBaseUrl,
    modelName: opts.modelName ?? base.modelName,
    webDistDir: opts.webDistDir === undefined ? base.webDistDir : opts.webDistDir,
    logRequests: opts.logRequests ?? base.logRequests,
    startWorld: typeof opts.startWorld === 'string' ? opts.startWorld : base.startWorld,
  };
  const clock = opts.clock ?? systemClock;
  const tickMode = opts.tickMode ?? 'interval';
  const startedAt = Date.now();
  const notes: string[] = [];

  const secrets = await loadSecrets({ dataDir: config.dataDir, directorToken: config.directorToken, agentToken: config.agentToken });
  const persistence = createPersistence(config.dataDir, (where, err) => {
    const message = err instanceof Error ? err.message : String(err);
    events.emit({ name: 'persistence.error', outcome: 'fail', data: { file: where, message } });
    notes.push(`persistence: ${where}: ${message}`);
  });
  const events = createEventLog({ filePath: persistence.eventsFile, source: 'server' });
  const session = new SessionStore();
  const world = new WorldStore();
  const candidates = new CandidateStore();
  const requests = new RequestStore(() => clock.now());

  // ---- initial world ----
  if (opts.startWorld && typeof opts.startWorld === 'object') {
    const parsed = WorldSpecSchema.safeParse(opts.startWorld);
    if (!parsed.success) throw new Error('startWorld is not a valid WorldSpec: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
    const version = Math.max(1, parsed.data.worldVersion);
    world.install(parsed.data, version);
    notes.push(`world: provided spec "${parsed.data.title}" as version ${version}`);
  } else if (opts.loadSnapshot !== false && (await persistence.loadCurrentWorld().then((s) => (s ? (world.install(s.spec, s.version), s) : null)))) {
    notes.push(`world: restored data/snapshots/world-current.json as version ${world.version}`);
    const saved = await persistence.loadSession();
    if (saved && world.current && session.restore(saved, world.current.spec.worldId, world.current.spec.relics.map((r) => r.id))) {
      notes.push(`session: restored ${session.state.collectedRelicIds.length} collected relic(s), score ${session.state.score} from data/snapshots/session.json`);
      events.emit({ name: 'session.restored', worldVersion: world.version, data: { collectedRelicIds: session.state.collectedRelicIds, score: session.state.score, players: session.state.players.length } });
    }
  } else if (config.startWorld === 'fixture') {
    try {
      const fixture = fixtureWorld('garden5');
      const suffix = ' (fixture)';
      const title = fixture.title.endsWith(suffix) ? fixture.title : (fixture.title.slice(0, WORLD_LIMITS.title.maxLength - suffix.length) + suffix);
      world.install({ ...fixture, title }, 1);
      notes.push('world: fixture garden5 as version 1');
    } catch (err) {
      notes.push(`world: fixture unavailable (${err instanceof Error ? err.message : String(err)}); starting without a world`);
    }
  } else {
    notes.push('world: none (send a brief from /director)');
  }
  if (world.current) {
    session.state.worldId = world.current.spec.worldId;
    session.state.worldVersion = world.version;
  }

  // ---- model reachability (GET /api/tags only, loopback only, cached) ----
  let modelCache: { at: number; value: ModelStatus } | null = null;
  async function modelStatus(): Promise<ModelStatus> {
    const now = Date.now();
    if (modelCache && now - modelCache.at < MODEL_CACHE_MS) return modelCache.value;
    const value: ModelStatus = { name: config.modelName, reachable: false, present: false };
    if (isLoopbackUrl(config.ollamaBaseUrl)) {
      try {
        const res = await fetch(`${config.ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
        if (res.ok) {
          value.reachable = true;
          const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
          const models = Array.isArray(body?.models) ? body.models : [];
          value.present = models.some((m) => m.name === config.modelName || m.model === config.modelName);
        }
      } catch {
        value.reachable = false;
      }
    }
    modelCache = { at: now, value };
    return value;
  }

  let listeningPort = config.port;
  function publicUrl(): string {
    return derivePublicUrl(config.publicUrl, listeningPort);
  }

  function liveContext(): LiveContext {
    return {
      players: session.state.players
        .filter((p) => p.connected)
        .map((p) => ({ id: p.id, x: p.x, z: p.z, status: p.status, spawnId: sim.spawnFor(p.slot).spawnId })),
      collectedRelicIds: [...session.state.collectedRelicIds],
      previousSpec: world.current?.spec,
    };
  }

  function summary() {
    const active = world.current;
    if (!active) return null;
    try {
      return buildSessionSummary(active.compiled, session.state);
    } catch {
      return null;
    }
  }

  function placeAtSpawn(playerId: string): void {
    const player = session.player(playerId);
    const active = world.current;
    if (!player || !active) return;
    const spawn = sim.spawnFor(player.slot);
    session.place(player, spawn.pos, active.compiled.supportAt(spawn.pos.x, spawn.pos.z), clock.now());
  }

  const ctx = {
    config, secrets, clock, events, persistence, session, world, candidates, requests, startedAt,
    publicUrl, modelStatus, liveContext, summary, placeAtSpawn,
  } as ServerContext;

  const sim = new Simulation({
    session, world, candidates, clock, events, persistence, mode: tickMode,
    hooks: {
      onTick: (message) => hub.broadcastTick(message),
      onWorld: (message) => hub.broadcastWorld(message),
      onCommitDeferred: (pending) => {
        const entry = requests.addActivity(pending.candidate.requestId, {
          phase: 'awaiting_safe_commit',
          message: `Waiting for ${pending.blockers.join(', ')} to leave the changed surface`,
          codes: ['OCCUPIED_SUPPORT'],
          objectIds: pending.blockers,
        }, world.version);
        hub.broadcastActivity([entry]);
      },
    },
  });
  ctx.sim = sim;
  // Make sure spawn positions are known before any player is placed.
  if (world.current) sim.ensureCache(world.version, world.current.spec, world.current.compiled);

  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1024 * 1024 });
  const hub = createWsHub(ctx);
  ctx.hub = hub;
  await registerRoutes(app, ctx);

  let started = false;
  let stopped = false;

  const server: BeetleServer = {
    app,
    config,
    clock,
    tokens: { director: secrets.directorToken, agent: secrets.agentToken },
    secrets,
    events,
    session,
    world,
    candidates,
    requests,
    sim,
    hub,
    async start() {
      if (started) throw new Error('server already started');
      started = true;
      await app.listen({ host: config.host, port: config.port });
      const addr = app.server.address();
      if (addr && typeof addr === 'object') listeningPort = addr.port;
      hub.attach(app.server);
      sim.start();
      events.emit({ name: 'server.started', worldVersion: world.version, data: { host: config.host, port: listeningPort, tickMode, hasWorld: world.hasWorld } });
      const url = `http://${config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host}:${listeningPort}`;
      return { host: config.host, port: listeningPort, url, publicUrl: publicUrl() };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      sim.stop();
      requests.releaseWaiters();
      hub.closeAll();
      events.emit({ name: 'server.stopped', worldVersion: world.version });
      if (started) await app.close();
      await persistence.flush();
      await events.flush();
    },
    tick(n = 1) {
      for (let i = 0; i < n; i += 1) sim.tick();
    },
    port: () => listeningPort,
    publicUrl,
    state: {
      session: () => session.state,
      worldVersion: () => world.version,
      spec: () => world.current?.spec ?? null,
      liveContext,
    },
    startupNotes: () => [...notes],
  };
  return server;
}
