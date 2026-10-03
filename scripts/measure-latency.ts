// Controller latency measurement for Beetle: WebSocket RTT, input-to-server-tick latency (idle and under load)
// and tick interval jitter, measured from two real controller sockets against a real server process.
//
// Usage: npx tsx scripts/measure-latency.ts
//   BEETLE_LATENCY_PORT=7782      port for the measured server (default 7782)
//   BEETLE_LATENCY_MODE=child     'child' (default: separate Node process, separate event loop) or 'in-process'
//   BEETLE_LATENCY_RTT=200        ping/pong samples per controller
//   BEETLE_LATENCY_INPUTS=100     input-to-tick samples per controller (idle and load)
//   BEETLE_LATENCY_TICKS=300      consecutive ticks for jitter
//
// Every client-side timestamp comes from one monotonic clock: performance.now() in this process.
// What is measured is network + server scheduling latency on loopback. It is NOT input-to-photon latency:
// no phone, no browser, no renderer, no display refresh is involved.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GEOMETRY, ROUTES, SIMULATION, type ServerMessage, type TickMessage, type WelcomeMessage } from '@beetle/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_MAIN = path.join(REPO_ROOT, 'apps', 'server', 'src', 'main.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TICK_MS = 1000 / SIMULATION.tickHz;

const PORT = Number(process.env.BEETLE_LATENCY_PORT ?? 7782);
const MODE: 'child' | 'in-process' = process.env.BEETLE_LATENCY_MODE === 'in-process' ? 'in-process' : 'child';
const RTT_SAMPLES = Number(process.env.BEETLE_LATENCY_RTT ?? 200);
const INPUT_SAMPLES = Number(process.env.BEETLE_LATENCY_INPUTS ?? 100);
const TICK_SAMPLES = Number(process.env.BEETLE_LATENCY_TICKS ?? 300);
const LOAD_INPUT_HZ = 30;
const HOST = '127.0.0.1';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------------------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------------------
export type Stats = { n: number; min: number; p50: number; p95: number; max: number; mean: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length); // nearest-rank
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0, min: NaN, p50: NaN, p95: NaN, max: NaN, mean: NaN };
  return {
    n,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[n - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / n,
  };
}

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');

// ---------------------------------------------------------------------------------------------------------
// Server lifecycle (child process by default so the measured server has its own event loop)
// ---------------------------------------------------------------------------------------------------------
type ServerHandle = { baseUrl: string; wsUrl: string; directorToken: string; dataDir: string; mode: string; stop(): Promise<void>; logs(): string };

async function waitForHealth(baseUrl: string, timeoutMs: number, isDead: () => boolean): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (isDead()) throw new Error('server exited before becoming healthy');
    try {
      const res = await fetch(`${baseUrl}${ROUTES.health}`);
      if (res.ok) return;
    } catch { /* not yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not answer ${ROUTES.health} within ${timeoutMs} ms`);
    await sleep(100);
  }
}

async function startServer(): Promise<ServerHandle> {
  const directorToken = randomBytes(16).toString('hex');
  const agentToken = randomBytes(16).toString('hex');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'beetle-latency-'));
  const baseUrl = `http://${HOST}:${PORT}`;
  const wsUrl = `ws://${HOST}:${PORT}${ROUTES.ws}`;

  if (MODE === 'in-process') {
    const mod = (await import(path.join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts'))) as {
      createBeetleServer: (o: Record<string, unknown>) => Promise<{ start(): Promise<unknown>; stop(): Promise<void>; startupNotes(): string[] }>;
    };
    const server = await mod.createBeetleServer({
      host: HOST, port: PORT, dataDir, publicUrl: baseUrl, directorToken, agentToken,
      startWorld: 'fixture', loadSnapshot: false, tickMode: 'interval', webDistDir: null, logRequests: false,
    });
    await server.start();
    const notes = server.startupNotes();
    return {
      baseUrl, wsUrl, directorToken, dataDir, mode: 'in-process (server shares this event loop)',
      logs: () => notes.join('\n'),
      async stop() { try { await server.stop(); } finally { await rm(dataDir, { recursive: true, force: true }).catch(() => undefined); } },
    };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BEETLE_HOST: HOST,
    BEETLE_PORT: String(PORT),
    BEETLE_PUBLIC_URL: baseUrl,
    BEETLE_DIRECTOR_TOKEN: directorToken,
    BEETLE_AGENT_TOKEN: agentToken,
    BEETLE_START_WORLD: 'fixture',
    BEETLE_DATA_DIR: dataDir,
    BEETLE_WEB_DIST: '',
    BEETLE_LOG_REQUESTS: '0',
  };
  const out: string[] = [];
  const capture = (chunk: Buffer) => {
    out.push(chunk.toString('utf8').replaceAll(directorToken, '<director-token>').replaceAll(agentToken, '<agent-token>'));
    if (out.length > 500) out.splice(0, out.length - 500);
  };
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, SERVER_MAIN], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => child.on('exit', () => { exited = true; resolve(); }));
  const stop = async () => {
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exitPromise, sleep(4000)]);
      if (!exited) { child.kill('SIGKILL'); await Promise.race([exitPromise, sleep(2000)]); }
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitForHealth(baseUrl, 30_000, () => exited);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n${out.join('')}`);
  }
  return { baseUrl, wsUrl, directorToken, dataDir, mode: `child process (pid ${child.pid}, own event loop)`, logs: () => out.join(''), stop };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP join
// ---------------------------------------------------------------------------------------------------------
type Controller = { playerId: string; controllerToken: string; label: string; slot: number };

async function joinController(server: ServerHandle): Promise<Controller> {
  const inviteRes = await fetch(`${server.baseUrl}${ROUTES.directorInvite}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${server.directorToken}` }, body: '{}',
  });
  if (!inviteRes.ok) throw new Error(`invite failed: HTTP ${inviteRes.status} ${(await inviteRes.text()).slice(0, 200)}`);
  const invite = (await inviteRes.json()) as { inviteCode: string; slot: number };
  const joinRes = await fetch(`${server.baseUrl}${ROUTES.join}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteCode: invite.inviteCode }),
  });
  if (!joinRes.ok) throw new Error(`join failed: HTTP ${joinRes.status} ${(await joinRes.text()).slice(0, 200)}`);
  const join = (await joinRes.json()) as { controllerToken: string; playerId: string; label: string };
  return { playerId: join.playerId, controllerToken: join.controllerToken, label: join.label, slot: invite.slot };
}

// ---------------------------------------------------------------------------------------------------------
// WebSocket controller client. Every arrival is stamped with performance.now() in the 'message' handler.
// ---------------------------------------------------------------------------------------------------------
type TickListener = (tick: TickMessage, arrivedAt: number) => void;

class ControllerClient {
  readonly ws: WebSocket;
  readonly ctrl: Controller;
  seq = 0;
  welcome: WelcomeMessage | null = null;
  lastTick: TickMessage | null = null;
  lastTickAt = 0;
  errors: { code: string; message: string }[] = [];
  private tickListeners = new Set<TickListener>();
  private pongWaiters = new Map<number, (arrivedAt: number) => void>();
  private welcomeWaiter: ((w: WelcomeMessage) => void) | null = null;

  constructor(ws: WebSocket, ctrl: Controller) {
    this.ws = ws;
    this.ctrl = ctrl;
    ws.on('message', (data) => {
      const arrivedAt = now();
      let msg: ServerMessage;
      try { msg = JSON.parse(data.toString()) as ServerMessage; } catch { return; }
      switch (msg.type) {
        case 'tick':
          this.lastTick = msg;
          this.lastTickAt = arrivedAt;
          for (const l of this.tickListeners) l(msg, arrivedAt);
          break;
        case 'pong': {
          const w = this.pongWaiters.get(msg.t);
          if (w) { this.pongWaiters.delete(msg.t); w(arrivedAt); }
          break;
        }
        case 'welcome':
          this.welcome = msg;
          this.welcomeWaiter?.(msg);
          break;
        case 'error':
          this.errors.push({ code: msg.code, message: msg.message });
          break;
        default:
          break;
      }
    });
  }

  static async connect(server: ServerHandle, ctrl: Controller): Promise<ControllerClient> {
    const ws = new WebSocket(server.wsUrl, { origin: server.baseUrl });
    const client = new ControllerClient(ws, ctrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket connect timeout')), 10_000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    const welcome = new Promise<WelcomeMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('welcome timeout')), 10_000);
      client.welcomeWaiter = (w) => { clearTimeout(timer); resolve(w); };
    });
    ws.send(JSON.stringify({ type: 'hello', role: 'controller', token: ctrl.controllerToken }));
    const w = await welcome;
    if (w.role !== 'controller' || w.playerId !== ctrl.playerId) throw new Error(`unexpected welcome for ${ctrl.label}: ${JSON.stringify(w)}`);
    return client;
  }

  me(tick: TickMessage = this.lastTick!) {
    const p = tick?.players.find((x) => x.id === this.ctrl.playerId);
    if (!p) throw new Error(`player ${this.ctrl.playerId} missing from tick`);
    return p;
  }

  onTick(l: TickListener): () => void {
    this.tickListeners.add(l);
    return () => this.tickListeners.delete(l);
  }

  /** Sends one input message; returns the monotonic send timestamp. */
  sendInput(axes: { x: number; z: number }): number {
    const t = now();
    this.seq += 1;
    this.ws.send(JSON.stringify({ type: 'input', seq: this.seq, axes, interact: false, t }));
    return t;
  }

  /** Ping/pong RTT in ms, measured with performance.now() on both ends of the same process. */
  ping(timeoutMs = 5000): Promise<number> {
    return new Promise((resolve, reject) => {
      const t = now();
      const timer = setTimeout(() => { this.pongWaiters.delete(t); reject(new Error('pong timeout')); }, timeoutMs);
      this.pongWaiters.set(t, (arrivedAt) => { clearTimeout(timer); resolve(arrivedAt - t); });
      this.ws.send(JSON.stringify({ type: 'ping', t }));
    });
  }

  /** Resolves with the arrival time of the first tick for which pred() is true. */
  waitTick(pred: (tick: TickMessage) => boolean, timeoutMs: number, label: string): Promise<{ tick: TickMessage; arrivedAt: number }> {
    return new Promise((resolve, reject) => {
      const off = this.onTick((tick, arrivedAt) => {
        if (pred(tick)) { clearTimeout(timer); off(); resolve({ tick, arrivedAt }); }
      });
      const timer = setTimeout(() => { off(); reject(new Error(`timeout (${timeoutMs} ms) waiting for ${label}`)); }, timeoutMs);
    });
  }

  /** Waits until this player has vx = vz = 0 and an unchanged position for `ticks` consecutive ticks. */
  async waitStill(ticks = 3, timeoutMs = 3000): Promise<void> {
    let run = 0;
    let lastX = NaN;
    let lastZ = NaN;
    await this.waitTick((tick) => {
      const p = this.me(tick);
      if (p.vx === 0 && p.vz === 0 && p.x === lastX && p.z === lastZ && p.status === 'active') run += 1;
      else run = 0;
      lastX = p.x;
      lastZ = p.z;
      return run >= ticks;
    }, timeoutMs, 'stillness');
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'done');
    await new Promise<void>((r) => { if (this.ws.readyState === WebSocket.CLOSED) r(); else this.ws.once('close', () => r()); });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------------------------
type InputSample = { latencyMs: number; ticksElapsed: number; sentAtMs: number };
type InputResult = { label: string; samples: InputSample[]; failures: string[]; stats: Stats; ticksElapsed: Stats };

async function measureRtt(client: ControllerClient, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await client.ping());
    await sleep(2 + Math.random() * 8); // decorrelate from the tick phase
  }
  return out;
}

async function measureTickJitter(client: ControllerClient, n: number): Promise<{ arrivalIntervals: number[]; serverIntervals: number[]; tickGaps: number; shortIntervals: number; longIntervals: number; first: number; last: number }> {
  const arrivals: number[] = [];
  const serverMs: number[] = [];
  const ticks: number[] = [];
  await new Promise<void>((resolve) => {
    const off = client.onTick((tick, arrivedAt) => {
      arrivals.push(arrivedAt);
      serverMs.push(tick.serverMs);
      ticks.push(tick.tick);
      if (arrivals.length >= n) { off(); resolve(); }
    });
  });
  const arrivalIntervals = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  const serverIntervals = serverMs.slice(1).map((t, i) => t - serverMs[i]);
  let tickGaps = 0;
  for (let i = 1; i < ticks.length; i += 1) if (ticks[i] !== ticks[i - 1] + 1) tickGaps += 1;
  const shortIntervals = arrivalIntervals.filter((v) => v < TICK_MS / 2).length; // catch-up ticks sent back to back
  const longIntervals = arrivalIntervals.filter((v) => v > TICK_MS * 1.5).length; // late ticks
  return { arrivalIntervals, serverIntervals, tickGaps, shortIntervals, longIntervals, first: ticks[0], last: ticks[ticks.length - 1] };
}

/**
 * One input-to-tick sample: send axes x=+1 at t0 and take the arrival time of the first tick in which this
 * player's x increased. Then walk back west to the home x, send zero input and wait for stillness so every
 * sample starts from rest at (roughly) the same spot on the centre island.
 * `setCommand` lets a background 30 Hz stream (load mode) keep repeating the current command.
 */
async function inputToTickSample(client: ControllerClient, homeX: number, setCommand: (axes: { x: number; z: number }) => void): Promise<InputSample> {
  const before = client.me();
  const x0 = before.x;
  const tick0 = client.lastTick!.tick;
  setCommand({ x: 1, z: 0 });
  const t0 = client.sendInput({ x: 1, z: 0 });
  const { tick, arrivedAt } = await client.waitTick((t) => client.me(t).x > x0, 2000, 'x increase');
  const sample = { latencyMs: arrivedAt - t0, ticksElapsed: tick.tick - tick0, sentAtMs: t0 };
  // Return to home so the player never drifts toward the island edge (east edge is ~10 m away).
  setCommand({ x: -1, z: 0 });
  client.sendInput({ x: -1, z: 0 });
  await client.waitTick((t) => client.me(t).x <= homeX, 3000, 'return west');
  setCommand({ x: 0, z: 0 });
  client.sendInput({ x: 0, z: 0 });
  await client.waitStill(3);
  return sample;
}

async function measureInputToTick(client: ControllerClient, n: number, label: string, setCommand: (axes: { x: number; z: number }) => void): Promise<InputResult> {
  const samples: InputSample[] = [];
  const failures: string[] = [];
  client.sendInput({ x: 0, z: 0 });
  await client.waitStill(3);
  const homeX = client.me().x;
  for (let i = 0; i < n; i += 1) {
    try {
      samples.push(await inputToTickSample(client, homeX, setCommand));
    } catch (err) {
      failures.push(`sample ${i}: ${(err as Error).message}`);
      setCommand({ x: 0, z: 0 });
      client.sendInput({ x: 0, z: 0 });
      await sleep(300);
    }
    await sleep(40 + Math.random() * 80); // rest; random so t0 lands uniformly across the tick phase
  }
  return { label, samples, failures, stats: stats(samples.map((s) => s.latencyMs)), ticksElapsed: stats(samples.map((s) => s.ticksElapsed)) };
}

/** 30 Hz input stream that repeats the current command (load mode). Returns a stop function and the send count. */
function startInputStream(client: ControllerClient, hz: number): { setCommand: (axes: { x: number; z: number }) => void; stop: () => number } {
  let command = { x: 0, z: 0 };
  let sent = 0;
  const timer = setInterval(() => { client.sendInput(command); sent += 1; }, 1000 / hz);
  return {
    setCommand: (axes) => { command = axes; },
    stop: () => { clearInterval(timer); return sent; },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------------
function table(rows: { label: string; s: Stats }[]): string {
  const lines = ['| Measurement | n | min ms | p50 ms | p95 ms | max ms | mean ms |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const r of rows) lines.push(`| ${r.label} | ${r.s.n} | ${fmt(r.s.min)} | ${fmt(r.s.p50)} | ${fmt(r.s.p95)} | ${fmt(r.s.max)} | ${fmt(r.s.mean)} |`);
  return lines.join('\n');
}

function cpuModel(): string {
  const fromNode = os.cpus()[0]?.model?.trim();
  if (fromNode && fromNode.toLowerCase() !== 'unknown') return fromNode;
  // On many ARM Linux hosts os.cpus() reports 'unknown'; lscpu lists one "Model name" per core type (big.LITTLE).
  try {
    const names = execFileSync('lscpu', [], { encoding: 'utf8', timeout: 2000 }).split('\n')
      .filter((l) => l.startsWith('Model name:')).map((l) => l.slice('Model name:'.length).trim()).filter(Boolean);
    const distinct = [...new Set(names)];
    if (distinct.length) return distinct.join(' + ');
  } catch { /* fall through */ }
  return fromNode || 'unknown';
}

function machineFacts() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: cpuModel(),
    cpuCount: cpus.length,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    loadAvg1m: Number(os.loadavg()[0].toFixed(2)),
    nodeVersion: process.version,
    transport: `WebSocket over TCP loopback ${HOST}:${PORT}`,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log(`[latency] starting Beetle server on ${HOST}:${PORT} (${MODE}) with the fixture world`);
  const server = await startServer();
  const clients: ControllerClient[] = [];
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    for (const c of clients) await c.close().catch(() => undefined);
    await server.stop();
  };
  const onSignal = () => { shutdown().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    console.log(`[latency] server up: ${server.mode}`);
    const ctrls = [await joinController(server), await joinController(server)];
    for (const c of ctrls) clients.push(await ControllerClient.connect(server, c));
    console.log(`[latency] joined controllers: ${ctrls.map((c) => `${c.label} (slot ${c.slot})`).join(', ')}`);
    // Let the first ticks arrive.
    await clients[0].waitTick(() => true, 5000, 'first tick');
    await clients[1].waitTick(() => true, 5000, 'first tick');

    // (a) WebSocket RTT
    console.log(`[latency] (a) WebSocket ping/pong RTT, ${RTT_SAMPLES} samples per controller`);
    const rtt = [] as { label: string; samples: number[]; stats: Stats }[];
    for (const c of clients) {
      const samples = await measureRtt(c, RTT_SAMPLES);
      rtt.push({ label: c.ctrl.label, samples, stats: stats(samples) });
    }
    const rttAll = stats(rtt.flatMap((r) => r.samples));

    // (c) tick interval jitter (idle: no inputs in flight)
    console.log(`[latency] (c) tick interval jitter over ${TICK_SAMPLES} consecutive ticks (idle)`);
    const jitter = await measureTickJitter(clients[0], TICK_SAMPLES);
    const arrivalStats = stats(jitter.arrivalIntervals);
    const arrivalDeviation = stats(jitter.arrivalIntervals.map((v) => Math.abs(v - TICK_MS)));
    const serverIntervalStats = stats(jitter.serverIntervals);

    // (b) input-to-tick, idle, one controller at a time
    console.log(`[latency] (b) input to server tick, ${INPUT_SAMPLES} samples per controller, idle`);
    const idle: InputResult[] = [];
    for (const c of clients) {
      const r = await measureInputToTick(c, INPUT_SAMPLES, `${c.ctrl.label} idle`, () => undefined);
      idle.push(r);
      console.log(`[latency]   ${r.label}: p50 ${fmt(r.stats.p50)} ms, p95 ${fmt(r.stats.p95)} ms, failures ${r.failures.length}`);
    }
    const idleAll = stats(idle.flatMap((r) => r.samples.map((s) => s.latencyMs)));

    // (d) input-to-tick under load: both controllers stream 30 inputs/s and measure simultaneously
    console.log(`[latency] (d) input to server tick under load: both controllers streaming ${LOAD_INPUT_HZ} inputs/s, ${INPUT_SAMPLES} samples each, simultaneous`);
    const streams = clients.map((c) => startInputStream(c, LOAD_INPUT_HZ));
    const loadT0 = now();
    const load = await Promise.all(clients.map((c, i) => measureInputToTick(c, INPUT_SAMPLES, `${c.ctrl.label} load`, streams[i].setCommand)));
    const loadDurationMs = now() - loadT0;
    const streamSent = streams.map((s) => s.stop());
    const loadAll = stats(load.flatMap((r) => r.samples.map((s) => s.latencyMs)));
    for (const r of load) console.log(`[latency]   ${r.label}: p50 ${fmt(r.stats.p50)} ms, p95 ${fmt(r.stats.p95)} ms, failures ${r.failures.length}`);
    const effectiveHz = streamSent.map((n) => Number((n / (loadDurationMs / 1000)).toFixed(1)));

    const errors = clients.flatMap((c) => c.errors.map((e) => `${c.ctrl.label}: ${e.code} ${e.message}`));
    const machine = machineFacts();
    const finishedAt = Date.now();

    const rows = [
      { label: 'WebSocket RTT (ping/pong), both controllers', s: rttAll },
      ...rtt.map((r) => ({ label: `WebSocket RTT, ${r.label}`, s: r.stats })),
      { label: 'Input to server tick, idle, both controllers', s: idleAll },
      ...idle.map((r) => ({ label: `Input to server tick, ${r.label}`, s: r.stats })),
      { label: `Input to server tick, load (2 x ${LOAD_INPUT_HZ} inputs/s), both controllers`, s: loadAll },
      ...load.map((r) => ({ label: `Input to server tick, ${r.label}`, s: r.stats })),
      { label: 'Tick interval, client arrival (nominal 33.33)', s: arrivalStats },
      { label: 'Tick interval deviation from 33.33 ms, client arrival', s: arrivalDeviation },
      { label: 'Tick interval, server serverMs stamps (wall clock)', s: serverIntervalStats },
    ];
    const tableMd = table(rows);

    const result = {
      kind: 'beetle-controller-latency',
      startedAt, finishedAt, durationMs: finishedAt - startedAt,
      server: { mode: server.mode, host: HOST, port: PORT, startWorld: 'fixture', tickHz: SIMULATION.tickHz, tickMs: TICK_MS, inputTimeoutMs: SIMULATION.inputTimeoutMs, inputRateLimitPerSec: SIMULATION.inputRateLimitPerSec, playerSpeed: GEOMETRY.playerSpeed },
      config: { rttSamplesPerController: RTT_SAMPLES, inputSamplesPerController: INPUT_SAMPLES, tickSamples: TICK_SAMPLES, loadInputHz: LOAD_INPUT_HZ },
      machine,
      controllers: ctrls.map((c) => ({ label: c.label, slot: c.slot, playerId: c.playerId })),
      clock: 'performance.now() in the measuring process for every client-side timestamp; serverMs is the server wall clock and only used for the secondary server-interval row',
      notIncluded: ['phone or browser input sampling', 'Wi-Fi or any non-loopback network', 'display rendering, GPU frame time, display refresh (this is not input-to-photon latency)'],
      results: {
        websocketRtt: { all: rttAll, perController: rtt.map((r) => ({ label: r.label, stats: r.stats })) },
        inputToTickIdle: { all: idleAll, perController: idle.map((r) => ({ label: r.label, stats: r.stats, ticksElapsed: r.ticksElapsed, failures: r.failures })) },
        inputToTickLoad: { all: loadAll, perController: load.map((r) => ({ label: r.label, stats: r.stats, ticksElapsed: r.ticksElapsed, failures: r.failures })), streamInputsSent: streamSent, effectiveStreamHz: effectiveHz, durationMs: Math.round(loadDurationMs) },
        tickJitter: { arrivalInterval: arrivalStats, arrivalDeviation, serverInterval: serverIntervalStats, tickGaps: jitter.tickGaps, shortIntervals: jitter.shortIntervals, longIntervals: jitter.longIntervals, firstTick: jitter.first, lastTick: jitter.last },
      },
      serverErrorsReceived: errors,
      raw: {
        websocketRtt: rtt.map((r) => ({ label: r.label, samplesMs: r.samples.map((v) => Number(v.toFixed(3))) })),
        inputToTickIdle: idle.map((r) => ({ label: r.label, samples: r.samples.map((s) => ({ ...s, latencyMs: Number(s.latencyMs.toFixed(3)), sentAtMs: Number(s.sentAtMs.toFixed(3)) })) })),
        inputToTickLoad: load.map((r) => ({ label: r.label, samples: r.samples.map((s) => ({ ...s, latencyMs: Number(s.latencyMs.toFixed(3)), sentAtMs: Number(s.sentAtMs.toFixed(3)) })) })),
        tickArrivalIntervalsMs: jitter.arrivalIntervals.map((v) => Number(v.toFixed(3))),
      },
    };

    const outDir = path.join(REPO_ROOT, 'data', 'latency');
    await mkdir(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `latency-${finishedAt}.json`);
    await writeFile(jsonPath, JSON.stringify(result, null, 2));

    const doc = renderDoc({ result, tableMd, jsonPath: path.relative(REPO_ROOT, jsonPath) });
    const docPath = path.join(REPO_ROOT, 'docs', 'LATENCY.md');
    await writeFile(docPath, doc);

    console.log('');
    console.log(tableMd);
    console.log('');
    console.log(`[latency] tick gaps in ${TICK_SAMPLES} ticks: ${jitter.tickGaps}; late ticks (>50 ms): ${jitter.longIntervals}; catch-up ticks (<16.7 ms): ${jitter.shortIntervals}; load stream sent ${streamSent.join(' / ')} inputs (${effectiveHz.join(' / ')} Hz effective)`);
    if (errors.length) console.log(`[latency] server error messages received: ${errors.join('; ')}`);
    const failures = [...idle, ...load].flatMap((r) => r.failures);
    if (failures.length) console.log(`[latency] sample failures: ${failures.join('; ')}`);
    console.log(`[latency] wrote ${path.relative(REPO_ROOT, jsonPath)} and docs/LATENCY.md`);
  } finally {
    await shutdown();
    console.log('[latency] server stopped');
  }
}

function renderDoc(o: { result: Record<string, any>; tableMd: string; jsonPath: string }): string {
  const r = o.result;
  const m = r.machine;
  const j = r.results.tickJitter;
  const loadRes = r.results.inputToTickLoad;
  const failures = [...r.results.inputToTickIdle.perController, ...loadRes.perController].flatMap((p: { label: string; failures: string[] }) => p.failures.map((f: string) => `${p.label}: ${f}`));
  return `# Controller latency (measured)

Measured on ${new Date(r.finishedAt).toISOString()} by \`scripts/measure-latency.ts\` (run: \`npx tsx scripts/measure-latency.ts\`).
Raw samples: \`${o.jsonPath}\`.

**Read the labels carefully.** "WebSocket RTT" and "input to server tick" are transport and simulation
latencies on loopback. They are **not** input-to-photon latency: no phone, no browser input sampling, no
Wi-Fi hop, no renderer, no GPU frame time and no display refresh is included. The number a player feels is
larger than anything in these tables.

## Results

${o.tableMd}

Percentiles use nearest-rank over the raw samples. Tick jitter rows are over ${j.arrivalInterval.n} intervals from ${r.config.tickSamples} consecutive ticks (ticks ${j.firstTick} to ${j.lastTick}, ${j.tickGaps} gaps in tick numbering). ${j.longIntervals} interval(s) were late (> 50 ms) and ${j.shortIntervals} were catch-up ticks (< 16.7 ms, sent back to back after a late one). The same outliers appear in the server's own \`serverMs\` stamps, so they come from the server's drift-corrected \`setInterval\` firing late on a loaded host, not from the socket. Tick numbering stays contiguous; the min/max of the interval rows describe server timer scheduling, not transport jitter. The load run streamed ${loadRes.streamInputsSent.join(' and ')} inputs (${loadRes.effectiveStreamHz.join(' and ')} Hz effective per controller) over ${(loadRes.durationMs / 1000).toFixed(1)} s.
Ticks elapsed between sending the input and the first moving tick (idle): ${r.results.inputToTickIdle.perController.map((p: any) => `${p.label} min ${p.ticksElapsed.min}, p50 ${p.ticksElapsed.p50}, max ${p.ticksElapsed.max}`).join('; ')}. Under load: ${loadRes.perController.map((p: any) => `${p.label} min ${p.ticksElapsed.min}, p50 ${p.ticksElapsed.p50}, max ${p.ticksElapsed.max}`).join('; ')}.
${failures.length ? `Sample failures: ${failures.join('; ')}.` : 'No sample failures.'}${r.serverErrorsReceived.length ? ` Server error messages received: ${r.serverErrorsReceived.join('; ')}.` : ' No server error messages were received.'}

## Method

- Server: the real Beetle server (\`apps/server/src/main.ts\`) started as a ${r.server.mode} on ${r.server.host}:${r.server.port} with \`BEETLE_START_WORLD=fixture\` (garden5) and a scratch \`BEETLE_DATA_DIR\` that is deleted afterwards. Fixed ${r.server.tickHz} Hz simulation (${r.server.tickMs.toFixed(2)} ms per tick), player speed ${r.server.playerSpeed} m/s, input timeout ${r.server.inputTimeoutMs} ms, input rate limit ${r.server.inputRateLimitPerSec}/s.
- Controllers: two players joined exactly like phones do: \`POST /api/director/invite\` (director token) then \`POST /api/join\` with the invite code, then a WebSocket to \`/ws\` (the \`ws\` package, Origin set to the server URL) and a \`hello\` with role \`controller\`.
- Clock: every client-side timestamp is \`performance.now()\` in the measuring process (one monotonic clock); arrival times are taken inside the socket's \`message\` handler before parsing. The server's \`serverMs\` (wall clock) is used only for the secondary "server serverMs stamps" row.
- (a) WebSocket RTT: \`{type:'ping', t}\` and the matching \`pong\`; RTT = pong arrival - t. ${r.config.rttSamplesPerController} sequential samples per controller with a 2-10 ms random gap, while ticks keep flowing.
- (b) Input to server tick: from rest, send \`input\` with axes x=+1 at t0; latency = arrival time of the first \`tick\` whose player x is greater than before, minus t0. Then send x=-1 until x is back at the home position, send zero axes, and wait for three consecutive ticks with zero velocity and unchanged position before the next sample (plus a 40-120 ms random rest so t0 lands uniformly across the tick phase). ${r.config.inputSamplesPerController} samples per controller, one controller at a time, no other traffic.
- (c) Tick interval jitter: arrival-time differences of ${r.config.tickSamples} consecutive \`tick\` messages on one idle controller socket; also the absolute deviation from the nominal 33.33 ms.
- (d) Load: both controllers run a ${r.config.loadInputHz} inputs/s stream (setInterval) that repeats the current command, and both run the (b) procedure at the same time, ${r.config.inputSamplesPerController} samples each.

## Machine

- Host: ${m.hostname}, ${m.platform}
- CPU: ${m.cpuModel} x ${m.cpuCount}; RAM ${m.totalMemGiB} GiB; 1-minute load average at the end of the run: ${m.loadAvg1m}
- Node ${m.nodeVersion}; transport: ${m.transport}
- Run duration ${(r.durationMs / 1000).toFixed(1)} s

## Limits of what was measured

- Loopback only. A real controller is a phone on Wi-Fi: add the wireless RTT (typically several ms to tens of ms, with its own tail) on top of every row.
- No browser: the \`/controller\` page's touch sampling, JavaScript timers and the browser's WebSocket stack are not in the numbers. Neither is the display's render loop: "input to server tick" ends when the tick JSON reaches the measuring process, not when a pixel changes.
- The input-to-tick figure is quantised by the ${r.server.tickHz} Hz loop: an input that arrives just after a tick boundary waits up to one full tick before it moves the player, so the spread between min and max is dominated by tick phase, not by transport.
- The measuring client and the server ran on the same machine; CPU contention from other processes (load average above) affects both. The load scenario is two scripted controllers at ${r.config.loadInputHz} inputs/s, not a crowd and not the agent, Ollama or a display client.
- One run on one machine. Repeat the script for distribution over time; this file is overwritten by each run and the JSON files accumulate under \`data/latency/\`.
`;
}

main().catch((err) => {
  console.error('[latency] failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
