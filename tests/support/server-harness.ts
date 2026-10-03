// Integration-test harness: starts the real Beetle server (in-process via the apps/server factory when it
// exposes one, otherwise as a child process running apps/server/src/main.ts), plus HTTP, WebSocket,
// controller and movement helpers. Everything here talks to the server exactly like a phone or the agent would.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  ROUTES, SIMULATION,
  type CommitResult, type DirectorRequest, type PlayerView, type ServerMessage, type SessionSummary, type TickMessage,
  type ValidationResult, type Vec2, type WelcomeMessage, type WorldMessage, type WorldSpec,
} from '@beetle/contracts';
import { bridgeOf, dist, endpointOn, islandContains, islandNear, islandRoute, moveToward, relicPos } from './world-geom.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER_INDEX = path.join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts');
export const SERVER_MAIN = path.join(REPO_ROOT, 'apps', 'server', 'src', 'main.ts');
export const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
export const TICK_MS = 1000 / SIMULATION.tickHz;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function hexToken(): string {
  return randomBytes(16).toString('hex');
}

export async function waitUntil<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, intervalMs = 50, label = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout after ${timeoutMs} ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------------------------------------

export type ServerHandle = {
  mode: 'in-process' | 'child';
  host: string;
  port: number;
  baseUrl: string;
  wsUrl: string;
  directorToken: string;
  agentToken: string;
  dataDir: string;
  /** Captured stdout/stderr (child mode) or notes (in-process). Tokens never appear here. */
  logs(): string;
  stop(): Promise<void>;
};

export type StartServerOptions = {
  startWorld?: 'fixture' | 'none';
  /** auto: in-process when the factory is available, else child. BEETLE_HARNESS_MODE overrides. */
  mode?: 'auto' | 'in-process' | 'child';
  env?: Record<string, string>;
  startTimeoutMs?: number;
  keepDataDir?: boolean;
};

export async function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function tempDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'beetle-it-'));
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const envMode = process.env.BEETLE_HARNESS_MODE;
  const mode = opts.mode ?? (envMode === 'child' || envMode === 'in-process' ? envMode : 'auto');
  if (mode !== 'child') {
    try {
      const handle = await startInProcess(opts);
      if (handle) return handle;
      if (mode === 'in-process') throw new Error(`apps/server/src/index.ts does not expose a usable server factory`);
    } catch (err) {
      if (mode === 'in-process') throw err;
      // eslint-disable-next-line no-console
      console.warn(`[harness] in-process start failed, falling back to child process: ${(err as Error).message}`);
    }
  }
  return startChild(opts);
}

/**
 * Starts the server in-process through createBeetleServer() from apps/server/src/index.ts (port 0, temp data dir,
 * fixed tokens, no snapshot restore, no static web dir). Returns null when the module or factory is missing so the
 * caller can fall back to a child process.
 */
async function startInProcess(opts: StartServerOptions): Promise<ServerHandle | null> {
  if (!existsSync(SERVER_INDEX)) return null;
  const modulePath = SERVER_INDEX;
  const mod = (await import(/* @vite-ignore */ modulePath)) as { createBeetleServer?: (o: Record<string, unknown>) => Promise<InProcessServer> };
  if (typeof mod.createBeetleServer !== 'function') return null;
  const directorToken = opts.env?.BEETLE_DIRECTOR_TOKEN ?? hexToken();
  const agentToken = opts.env?.BEETLE_AGENT_TOKEN ?? hexToken();
  const dataDir = await tempDataDir();
  const host = '127.0.0.1';
  const notes: string[] = [];
  const server = await mod.createBeetleServer({
    host,
    port: 0,
    dataDir,
    publicUrl: null,
    directorToken,
    agentToken,
    startWorld: opts.startWorld ?? 'fixture',
    loadSnapshot: false,
    tickMode: 'interval',
    ollamaBaseUrl: opts.env?.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    modelName: opts.env?.BEETLE_MODEL ?? 'qwen3.5:4b',
    webDistDir: null,
    logRequests: false,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const info = await server.start();
  const port = info.port;
  for (const n of server.startupNotes()) notes.push(n);
  notes.push(`listening on ${host}:${port}`);
  return {
    mode: 'in-process',
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}${ROUTES.ws}`,
    directorToken,
    agentToken,
    dataDir,
    logs: () => notes.join('\n'),
    async stop() {
      try {
        await server.stop();
      } finally {
        if (!opts.keepDataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

type InProcessServer = {
  start(): Promise<{ host: string; port: number; url: string; publicUrl: string }>;
  stop(): Promise<void>;
  startupNotes(): string[];
};

/** Spawns `node tsx apps/server/src/main.ts` with a free port and waits for /api/health. */
async function startChild(opts: StartServerOptions): Promise<ServerHandle> {
  if (!existsSync(SERVER_MAIN)) throw new Error(`server entry point missing: ${SERVER_MAIN}`);
  const host = '127.0.0.1';
  const port = await freePort(host);
  const directorToken = opts.env?.BEETLE_DIRECTOR_TOKEN ?? hexToken();
  const agentToken = opts.env?.BEETLE_AGENT_TOKEN ?? hexToken();
  const dataDir = await tempDataDir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BEETLE_HOST: host,
    BEETLE_PORT: String(port),
    BEETLE_PUBLIC_URL: `http://${host}:${port}`,
    BEETLE_DIRECTOR_TOKEN: directorToken,
    BEETLE_AGENT_TOKEN: agentToken,
    BEETLE_START_WORLD: opts.startWorld ?? 'fixture',
    BEETLE_DATA_DIR: dataDir,
    BEETLE_WEB_DIST: '',
    BEETLE_LOG_REQUESTS: '0',
    ...opts.env,
  };
  const out: string[] = [];
  let outBytes = 0;
  const capture = (chunk: Buffer) => {
    const s = chunk.toString('utf8').replace(directorToken, '<director-token>').replace(agentToken, '<agent-token>');
    outBytes += s.length;
    out.push(s);
    while (outBytes > 200_000 && out.length > 1) outBytes -= out.shift()!.length;
  };
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, SERVER_MAIN], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      resolve();
    });
  });
  const baseUrl = `http://${host}:${port}`;
  const timeoutMs = opts.startTimeoutMs ?? 90_000;
  const t0 = Date.now();
  for (;;) {
    if (exited) {
      const e = exited as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(`server child exited during startup (code ${e.code}, signal ${e.signal}). Output:\n${out.join('')}`);
    }
    try {
      const res = await fetch(baseUrl + ROUTES.health, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > timeoutMs) {
      child.kill('SIGKILL');
      throw new Error(`server did not answer ${ROUTES.health} within ${timeoutMs} ms. Output:\n${out.join('')}`);
    }
    await sleep(150);
  }
  return {
    mode: 'child',
    host,
    port,
    baseUrl,
    wsUrl: `ws://${host}:${port}${ROUTES.ws}`,
    directorToken,
    agentToken,
    dataDir,
    logs: () => out.join(''),
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([exitPromise, sleep(8000)]);
        if (!exited) {
          child.kill('SIGKILL');
          await Promise.race([exitPromise, sleep(2000)]);
        }
      }
      if (!opts.keepDataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------------

export type ApiResponse<T = any> = { status: number; json: T; text: string; headers: Headers };
export type FetchInit = { method?: string; token?: string | null; body?: unknown; timeoutMs?: number; headers?: Record<string, string> };

export async function apiFetch<T = any>(server: Pick<ServerHandle, 'baseUrl'>, pathname: string, init: FetchInit = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  const res = await fetch(server.baseUrl + pathname, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  }
  return { status: res.status, json: json as T, text, headers: res.headers };
}

export const directorFetch = <T = any>(server: ServerHandle, pathname: string, init: Omit<FetchInit, 'token'> = {}) =>
  apiFetch<T>(server, pathname, { ...init, token: server.directorToken });
export const agentFetch = <T = any>(server: ServerHandle, pathname: string, init: Omit<FetchInit, 'token'> = {}) =>
  apiFetch<T>(server, pathname, { ...init, token: server.agentToken });
export const controllerFetch = <T = any>(server: ServerHandle, controllerToken: string, pathname: string, init: Omit<FetchInit, 'token'> = {}) =>
  apiFetch<T>(server, pathname, { ...init, token: controllerToken });
export const anonFetch = <T = any>(server: ServerHandle, pathname: string, init: Omit<FetchInit, 'token'> = {}) =>
  apiFetch<T>(server, pathname, { ...init, token: null });

export type Controller = { controllerToken: string; playerId: string; label: string; color: string; inviteCode: string; inviteUrl: string };

/** Director creates an invite, the "phone" joins with it. */
export async function joinController(server: ServerHandle): Promise<Controller> {
  const invite = await directorFetch(server, ROUTES.directorInvite, { method: 'POST', body: {} });
  if (invite.status >= 300 || typeof invite.json?.inviteCode !== 'string') {
    throw new Error(`invite failed: HTTP ${invite.status} ${invite.text.slice(0, 300)}`);
  }
  const join = await anonFetch(server, ROUTES.join, { method: 'POST', body: { inviteCode: invite.json.inviteCode } });
  if (join.status >= 300 || typeof join.json?.controllerToken !== 'string') {
    throw new Error(`join failed: HTTP ${join.status} ${join.text.slice(0, 300)}`);
  }
  return {
    controllerToken: join.json.controllerToken,
    playerId: join.json.playerId,
    label: join.json.label,
    color: join.json.color,
    inviteCode: invite.json.inviteCode,
    inviteUrl: invite.json.url,
  };
}

export type AgentWorld = { hasWorld?: boolean; spec: WorldSpec; version: number; summary: SessionSummary };

export async function agentWorld(server: ServerHandle): Promise<AgentWorld> {
  const res = await agentFetch<AgentWorld>(server, ROUTES.agentWorld);
  if (res.status !== 200) throw new Error(`GET ${ROUTES.agentWorld} -> HTTP ${res.status} ${res.text.slice(0, 300)}`);
  return res.json;
}

export type StagedPatch = { candidateId: string; patchId: string; digest: string; baseWorldVersion: number; changedIds: string[] };

export async function stagePatch(server: ServerHandle, requestId: string, patch: { summary: string; ops: unknown[] }): Promise<ApiResponse<StagedPatch & { issues?: unknown[] }>> {
  return agentFetch(server, ROUTES.agentProposePatch, { method: 'POST', body: { requestId, patch } });
}

export async function stagePatchOk(server: ServerHandle, requestId: string, patch: { summary: string; ops: unknown[] }): Promise<StagedPatch> {
  const res = await stagePatch(server, requestId, patch);
  if (res.status >= 300 || typeof res.json?.candidateId !== 'string') throw new Error(`stage patch failed: HTTP ${res.status} ${res.text.slice(0, 600)}`);
  return res.json;
}

export async function validateCandidate(server: ServerHandle, candidateId: string): Promise<ValidationResult> {
  const res = await agentFetch<ValidationResult>(server, ROUTES.agentValidate.replace(':id', encodeURIComponent(candidateId)), { method: 'POST', body: {} });
  if (res.status >= 300) throw new Error(`validate failed: HTTP ${res.status} ${res.text.slice(0, 600)}`);
  return res.json;
}

export async function commitCandidate(server: ServerHandle, candidateId: string, proofId: string, timeoutMs = 20_000): Promise<CommitResult & { status: number }> {
  const res = await agentFetch(server, ROUTES.agentCommit.replace(':id', encodeURIComponent(candidateId)), { method: 'POST', body: { proofId }, timeoutMs });
  const j = res.json as Record<string, unknown> | null;
  if (j && typeof j.ok === 'boolean') return { ...(j as unknown as CommitResult), status: res.status };
  return { ok: false, code: (j && typeof j.code === 'string' ? j.code : 'INTERNAL') as never, message: `HTTP ${res.status}: ${res.text.slice(0, 300)}`, objectIds: [], retryable: false, status: res.status };
}

/** Commit and, while the server answers COMMIT_DEFERRED (retryable), keep retrying until settled or timeout. */
export async function commitUntilSettled(server: ServerHandle, candidateId: string, proofId: string, timeoutMs = SIMULATION.commitDeferMaxMs + 6000): Promise<CommitResult & { status: number; attempts: number; elapsedMs: number }> {
  const t0 = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const r = await commitCandidate(server, candidateId, proofId, timeoutMs + 5000);
    const elapsedMs = Date.now() - t0;
    if (r.ok || !(r.code === 'COMMIT_DEFERRED' && r.retryable) || elapsedMs > timeoutMs) return { ...r, attempts, elapsedMs };
    await sleep(250);
  }
}

/** Stage + validate in one go; throws when validation fails so tests see the issue codes. */
export async function stageAndValidate(server: ServerHandle, requestId: string, patch: { summary: string; ops: unknown[] }): Promise<StagedPatch & { proofId: string; validation: ValidationResult }> {
  const staged = await stagePatchOk(server, requestId, patch);
  const validation = await validateCandidate(server, staged.candidateId);
  if (!validation.ok || !validation.proof) {
    throw new Error(`validation failed for ${JSON.stringify(patch.ops)}: ${JSON.stringify(validation.issues)}`);
  }
  return { ...staged, proofId: validation.proof.proofId, validation };
}

export async function createDirectorRequest(server: ServerHandle, prompt: string, kind: 'brief' | 'edit' = 'edit', authorizeNewWorld?: boolean): Promise<ApiResponse<DirectorRequest>> {
  return directorFetch<DirectorRequest>(server, ROUTES.directorRequest, { method: 'POST', body: { kind, prompt, ...(authorizeNewWorld === undefined ? {} : { authorizeNewWorld }) } });
}

export function requestIdFor(label: string): string {
  return `req-${label}-${randomBytes(3).toString('hex')}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
}

// ---------------------------------------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------------------------------------

export type Axes = { x: number; z: number };
type Waiter = { pred: (m: ServerMessage, index: number) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; since: number };

export class WsClient {
  readonly ws: WebSocket;
  readonly name: string;
  /** Absolute index of messages[0]; older ticks are trimmed. */
  private dropped = 0;
  private readonly messages: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private lastTickMsg: TickMessage | null = null;
  private welcomeMsg: WelcomeMessage | null = null;
  private axisMatrix: [number, number, number, number] | null = null;
  seq = 0;
  closedInfo: { code: number; reason: string } | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly errors: Extract<ServerMessage, { type: 'error' }>[] = [];

  private constructor(ws: WebSocket, name: string) {
    this.ws = ws;
    this.name = name;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closedInfo = { code, reason: reason.toString() };
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error(`[${name}] socket closed (${code} ${reason.toString()}) while waiting`));
        }
        resolve(this.closedInfo);
      });
    });
    ws.on('message', (data) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage;
      } catch {
        return;
      }
      this.push(msg);
    });
  }

  static connect(server: Pick<ServerHandle, 'wsUrl' | 'baseUrl'>, opts: { name?: string; origin?: string | null; timeoutMs?: number } = {}): Promise<WsClient> {
    const origin = opts.origin === undefined ? server.baseUrl : opts.origin;
    const ws = new WebSocket(server.wsUrl, origin ? { origin } : {});
    const client = new WsClient(ws, opts.name ?? 'ws');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${client.name}] websocket connect timeout`)), opts.timeoutMs ?? 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(client);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private push(msg: ServerMessage): void {
    const index = this.dropped + this.messages.length;
    this.messages.push(msg);
    if (msg.type === 'tick') this.lastTickMsg = msg;
    else if (msg.type === 'welcome') this.welcomeMsg = msg;
    else if (msg.type === 'error') this.errors.push(msg);
    // Keep memory bounded: drop old ticks once the buffer grows (non-tick messages are rare and kept).
    if (this.messages.length > 3000) {
      let removed = 0;
      while (this.messages.length > 1500 && removed < 1500) {
        if (this.messages[0].type === 'tick') {
          this.messages.shift();
          this.dropped++;
          removed++;
        } else break;
      }
    }
    for (const w of this.waiters.slice()) {
      if (index < w.since) continue;
      let hit = false;
      try { hit = w.pred(msg, index); } catch { hit = false; }
      if (hit) {
        clearTimeout(w.timer);
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  }

  /** Absolute index of the next message to arrive; pass as `since` to wait only for new messages. */
  cursor(): number {
    return this.dropped + this.messages.length;
  }

  /** Messages with absolute index >= since. */
  since(since: number): ServerMessage[] {
    const start = Math.max(0, since - this.dropped);
    return this.messages.slice(start);
  }

  ticksSince(since: number): TickMessage[] {
    return this.since(since).filter((m): m is TickMessage => m.type === 'tick');
  }

  lastTick(): TickMessage | null {
    return this.lastTickMsg;
  }

  welcome(): WelcomeMessage | null {
    return this.welcomeMsg;
  }

  send(msg: unknown): void {
    if (!this.isOpen) throw new Error(`[${this.name}] send on closed socket`);
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text: string | Buffer): void {
    this.ws.send(text);
  }

  waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage, index: number) => boolean, timeoutMs = 5000, opts: { since?: number; label?: string } = {}): Promise<T> {
    const since = opts.since ?? 0;
    const start = Math.max(0, since - this.dropped);
    for (let i = start; i < this.messages.length; i++) {
      const m = this.messages[i];
      let hit = false;
      try { hit = pred(m, this.dropped + i); } catch { hit = false; }
      if (hit) return Promise.resolve(m as T);
    }
    if (this.closedInfo) return Promise.reject(new Error(`[${this.name}] socket already closed (${this.closedInfo.code})`));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        const recent = this.messages.slice(-6).map((m) => (m.type === 'error' ? `error:${m.code}` : m.type)).join(',');
        reject(new Error(`[${this.name}] timeout after ${timeoutMs} ms waiting for ${opts.label ?? 'message'} (recent: ${recent || 'none'})`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolve as (m: ServerMessage) => void, reject, timer, since });
    });
  }

  waitForType<K extends ServerMessage['type']>(type: K, timeoutMs = 5000, opts: { since?: number } = {}): Promise<Extract<ServerMessage, { type: K }>> {
    return this.waitFor((m) => m.type === type, timeoutMs, { ...opts, label: `'${type}' message` });
  }

  /** The next tick that arrives after this call. */
  nextTick(timeoutMs = 3000): Promise<TickMessage> {
    return this.waitFor<TickMessage>((m) => m.type === 'tick', timeoutMs, { since: this.cursor(), label: 'tick' });
  }

  /** Waits until a tick arriving after this call satisfies pred. */
  waitForTick(pred: (t: TickMessage) => boolean, timeoutMs = 5000, label = 'tick condition'): Promise<TickMessage> {
    return this.waitFor<TickMessage>((m) => m.type === 'tick' && pred(m), timeoutMs, { since: this.cursor(), label });
  }

  private expectWelcome(msg: ServerMessage): WelcomeMessage {
    if (msg.type === 'welcome') return msg;
    if (msg.type === 'error') throw new Error(`[${this.name}] hello rejected: ${msg.code} ${msg.message}`);
    throw new Error(`[${this.name}] unexpected ${msg.type} instead of welcome`);
  }

  async helloController(token: string, lastSeq?: number, timeoutMs = 8000): Promise<WelcomeMessage> {
    const since = this.cursor();
    this.send({ type: 'hello', role: 'controller', token, ...(lastSeq === undefined ? {} : { lastSeq }) });
    const msg = await this.waitFor((m) => m.type === 'welcome' || m.type === 'error', timeoutMs, { since, label: 'welcome' });
    return this.expectWelcome(msg);
  }

  /**
   * Display hello. Resolves after the welcome AND the initial snapshot burst (world, activity, controllers) so that a
   * cursor taken afterwards only sees messages caused by later events.
   */
  async helloDisplay(worldVersion?: number, timeoutMs = 8000): Promise<WelcomeMessage> {
    const since = this.cursor();
    this.send({ type: 'hello', role: 'display', ...(worldVersion === undefined ? {} : { worldVersion }) });
    const msg = await this.waitFor((m) => m.type === 'welcome' || m.type === 'error', timeoutMs, { since, label: 'welcome' });
    const welcome = this.expectWelcome(msg);
    await this.absorbSnapshot(since);
    return welcome;
  }

  async helloDirector(token: string, timeoutMs = 8000): Promise<WelcomeMessage> {
    const since = this.cursor();
    this.send({ type: 'hello', role: 'director', token });
    const msg = await this.waitFor((m) => m.type === 'welcome' || m.type === 'error', timeoutMs, { since, label: 'welcome' });
    const welcome = this.expectWelcome(msg);
    await this.absorbSnapshot(since);
    return welcome;
  }

  /** The server ends its hello snapshot with a 'controllers' message; wait for it (tolerant for older servers). */
  private async absorbSnapshot(since: number): Promise<void> {
    await this.waitFor((m) => m.type === 'controllers', 3000, { since, label: 'snapshot controllers message' }).catch(() => undefined);
  }

  /** The snapshot 'world' message received right after hello, if any. */
  snapshotWorld(): WorldMessage | null {
    for (const m of this.messages) if (m.type === 'world' && m.reason === 'snapshot') return m;
    return null;
  }

  input(axes: Axes, interact = false): number {
    this.seq += 1;
    this.send({ type: 'input', seq: this.seq, axes: { x: clamp1(axes.x), z: clamp1(axes.z) }, interact, t: Date.now() });
    return this.seq;
  }

  ping(): void {
    this.send({ type: 'ping', t: Date.now() });
  }

  ack(worldVersion: number): void {
    this.send({ type: 'ack', worldVersion });
  }

  resync(haveVersion: number): void {
    this.send({ type: 'resync', haveVersion });
  }

  async close(code = 1000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close(code, 'test done');
    await Promise.race([this.closed, sleep(3000)]);
    if ((this.ws.readyState as number) !== WebSocket.CLOSED) this.ws.terminate();
  }

  /** Abrupt disconnect (like a phone losing WiFi). */
  terminate(): void {
    this.ws.terminate();
  }

  // ---- movement helpers -----------------------------------------------------------------------------------

  /** Maps a desired world-space direction to controller axes (identity until calibrated). */
  axesFor(dir: Vec2): Axes {
    const m = this.axisMatrix;
    if (!m) return { x: dir.x, z: dir.z };
    const [a, b, c, d] = m; // observed v = M * input, M = [[a, b], [c, d]] ; input = M^-1 * v
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-6) return { x: dir.x, z: dir.z };
    return { x: (d * dir.x - b * dir.z) / det, z: (-c * dir.x + a * dir.z) / det };
  }

  /**
   * Learns how the server maps input axes to world velocity by pushing +X then +Z briefly and reading the tick
   * velocity. Falls back to identity when nothing is observed. Moves the player roughly a metre.
   */
  async calibrateAxes(playerId: string): Promise<void> {
    if (this.axisMatrix) return;
    const probe = async (axes: Axes): Promise<Vec2> => {
      const hold = holdInput(this, axes);
      try {
        const tick = await this.waitForTick((t) => {
          const p = playerIn(t, playerId);
          return Boolean(p && Math.hypot(p.vx, p.vz) > 0.5);
        }, 1500, 'calibration velocity').catch(() => null);
        const p = tick ? playerIn(tick, playerId) : null;
        return p ? { x: p.vx, z: p.vz } : { x: 0, z: 0 };
      } finally {
        hold.stop();
      }
    };
    const vx = await probe({ x: 1, z: 0 });
    await awaitTicks(this, 2);
    const vz = await probe({ x: 0, z: 1 });
    await awaitTicks(this, 2);
    const n1 = Math.hypot(vx.x, vx.z) || 1;
    const n2 = Math.hypot(vz.x, vz.z) || 1;
    const a = vx.x / n1, c = vx.z / n1, b = vz.x / n2, d = vz.z / n2;
    this.axisMatrix = Math.abs(a * d - b * c) < 0.5 ? [1, 0, 0, 1] : [a, b, c, d];
  }
}

function clamp1(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

export function playerIn(tick: TickMessage, playerId: string): PlayerView | undefined {
  return tick.players.find((p) => p.id === playerId);
}

export function posOf(p: PlayerView): Vec2 {
  return { x: p.x, z: p.z };
}

/** Waits for n ticks on this socket. */
export async function awaitTicks(client: WsClient, n: number, timeoutMs?: number): Promise<TickMessage> {
  const since = client.cursor();
  let count = 0;
  return client.waitFor<TickMessage>((m) => m.type === 'tick' && ++count >= n, timeoutMs ?? Math.max(2000, n * TICK_MS * 4 + 1000), { since, label: `${n} ticks` });
}

/** Keeps sending the same input at `intervalMs` (default 20 Hz) until stop(). stop(true) also sends a zero input. */
export type InputHold = { stop(sendZero?: boolean): void; readonly stopped: boolean; readonly lastSentAt: number; readonly sent: number };

export function holdInput(client: WsClient, axes: Axes, opts: { intervalMs?: number; interact?: boolean } = {}): InputHold {
  const intervalMs = opts.intervalMs ?? 50;
  const interact = opts.interact ?? false;
  let stopped = false;
  let lastSentAt = 0;
  let sent = 0;
  const push = () => {
    if (!client.isOpen) return;
    client.input(axes, interact);
    lastSentAt = Date.now();
    sent++;
  };
  push();
  const timer = setInterval(() => {
    if (!client.isOpen) { clearInterval(timer); return; }
    push();
  }, intervalMs);
  return {
    get stopped() { return stopped; },
    get lastSentAt() { return lastSentAt; },
    get sent() { return sent; },
    stop(sendZero = true) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (sendZero && client.isOpen) client.input({ x: 0, z: 0 }, false);
    },
  };
}

export async function driveFor(client: WsClient, axes: Axes, ms: number): Promise<void> {
  const hold = holdInput(client, axes);
  await sleep(ms);
  hold.stop();
}

/** Edge-triggered interact press: one input with interact=true, then release. */
export async function pressInteract(client: WsClient, axes: Axes = { x: 0, z: 0 }): Promise<void> {
  client.input(axes, false);
  await awaitTicks(client, 1);
  client.input(axes, true);
  await awaitTicks(client, 2);
  client.input(axes, false);
  await awaitTicks(client, 1);
}

export type DriveOptions = { tolerance?: number; timeoutMs?: number; intervalMs?: number };

/** Drives the player in a straight line toward target using the live tick stream; nudges sideways when stuck. */
export async function driveTo(client: WsClient, playerId: string, target: Vec2, opts: DriveOptions = {}): Promise<PlayerView> {
  const tolerance = opts.tolerance ?? 0.3;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const intervalMs = opts.intervalMs ?? 40;
  const t0 = Date.now();
  let lastPos: Vec2 | null = null;
  let stuck = 0;
  let nudge: Axes | null = null;
  let nudgeUntil = 0;
  let nudges = 0;
  for (;;) {
    const tick = client.lastTick() ?? (await client.nextTick());
    const p = playerIn(tick, playerId);
    if (!p) throw new Error(`[${client.name}] player ${playerId} not in tick`);
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= tolerance) {
      client.input({ x: 0, z: 0 }, false);
      return p;
    }
    if (Date.now() - t0 > timeoutMs) {
      client.input({ x: 0, z: 0 }, false);
      throw new Error(`[${client.name}] driveTo timeout: ${playerId} at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) status=${p.status} support=${p.supportId}, target (${target.x.toFixed(2)}, ${target.z.toFixed(2)}), dist ${d.toFixed(2)}`);
    }
    if (p.status !== 'active') {
      await sleep(intervalMs);
      continue;
    }
    if (lastPos && dist(lastPos, p) < 0.005) stuck++; else stuck = 0;
    lastPos = { x: p.x, z: p.z };
    let dir: Vec2 = { x: dx / d, z: dz / d };
    if (stuck > 10 && !nudge) {
      nudges++;
      const side = nudges % 2 === 0 ? 1 : -1;
      nudge = { x: -dir.z * side, z: dir.x * side };
      nudgeUntil = Date.now() + 350;
      stuck = 0;
    }
    if (nudge && Date.now() < nudgeUntil) dir = nudge; else nudge = null;
    client.input(client.axesFor(dir), false);
    await sleep(intervalMs);
  }
}

/** Current position from the latest tick (waits for one if needed). */
export async function currentPlayer(client: WsClient, playerId: string): Promise<PlayerView> {
  const tick = client.lastTick() ?? (await client.nextTick());
  const p = playerIn(tick, playerId);
  if (!p) throw new Error(`player ${playerId} not in tick`);
  return p;
}

/** Walks across bridges along the island graph to reach target (which must be on/near an island). */
export async function navigateTo(client: WsClient, spec: WorldSpec, playerId: string, target: Vec2, opts: DriveOptions = {}): Promise<PlayerView> {
  await client.calibrateAxes(playerId);
  const me = await currentPlayer(client, playerId);
  const start = posOf(me);
  const fromIsland = islandNear(spec, start);
  const toIsland = islandNear(spec, target);
  if (!islandContains(fromIsland, start, 0.2)) {
    // Standing on a bridge or at a rim: step onto the nearest island first.
    const inside = moveToward(start, fromIsland.center, dist(start, fromIsland.center) - fromIsland.radius + 0.8);
    await driveTo(client, playerId, inside, { tolerance: 0.3, timeoutMs: opts.timeoutMs });
  }
  const route = islandRoute(spec, fromIsland.id, toIsland.id);
  if (!route) throw new Error(`no bridge route from ${fromIsland.id} to ${toIsland.id}`);
  for (const leg of route) {
    const a = endpointOn(leg.bridge, leg.from.id);
    const b = endpointOn(leg.bridge, leg.to.id);
    const aIn = moveToward(a, leg.from.center, 0.8);
    const bIn = moveToward(b, leg.to.center, 0.8);
    await driveTo(client, playerId, aIn, { tolerance: 0.25, timeoutMs: opts.timeoutMs });
    await driveTo(client, playerId, bIn, { tolerance: 0.25, timeoutMs: opts.timeoutMs });
  }
  return driveTo(client, playerId, target, opts);
}

/** Walks to the middle of a bridge and returns the tick view (supportId should equal the bridge id). */
export async function standOnBridge(client: WsClient, spec: WorldSpec, playerId: string, bridgeId: string): Promise<PlayerView> {
  const bridge = bridgeOf(spec, bridgeId);
  const [e0, e1] = bridge.endpoints;
  const mid = { x: (e0.point.x + e1.point.x) / 2, z: (e0.point.z + e1.point.z) / 2 };
  await client.calibrateAxes(playerId);
  const me = await currentPlayer(client, playerId);
  const startIsland = islandNear(spec, posOf(me));
  const entryIslandId = startIsland.id === e1.islandId ? e1.islandId : e0.islandId;
  const entry = moveToward(endpointOn(bridge, entryIslandId), islandNearById(spec, entryIslandId).center, 0.8);
  await navigateTo(client, spec, playerId, entry, { tolerance: 0.25 });
  const view = await driveTo(client, playerId, mid, { tolerance: 0.2 });
  // Let the server settle one tick so supportId reflects the final position.
  const tick = await awaitTicks(client, 2);
  return playerIn(tick, playerId) ?? view;
}

function islandNearById(spec: WorldSpec, id: string) {
  const island = spec.islands.find((i) => i.id === id);
  if (!island) throw new Error(`island ${id} missing`);
  return island;
}

/** Walks to a relic and presses interact until the tick stream reports it collected (or timeout). */
export async function collectRelic(client: WsClient, spec: WorldSpec, playerId: string, relicId: string, timeoutMs = 40_000): Promise<TickMessage> {
  const target = relicPos(spec, relicId);
  await navigateTo(client, spec, playerId, target, { tolerance: 0.35, timeoutMs });
  const deadline = Date.now() + 6000;
  for (;;) {
    const since = client.cursor();
    await pressInteract(client);
    const hit = await client.waitFor<TickMessage>((m) => m.type === 'tick' && m.relics[relicId] === 'collected', 1000, { since, label: `relic ${relicId} collected` }).catch(() => null);
    if (hit) return hit;
    if (Date.now() > deadline) {
      const p = await currentPlayer(client, playerId);
      throw new Error(`relic ${relicId} not collected; player at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) dist ${dist(posOf(p), target).toFixed(2)} status=${p.status}`);
    }
    await driveTo(client, playerId, target, { tolerance: 0.25 });
  }
}
