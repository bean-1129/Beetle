// Functional acceptance test for the "hero transformation": while two phones keep playing, the director asks the local
// agent to turn the water into lava and add an alternative bridge; the world must change in place (version +1) without
// dropping a socket, a tick, a player or a collected relic.
//
// Unattended, end to end, honest: it starts the real server (fixture world) and the direct-mode worker as child
// processes on port 7784, drives both controllers at 20 Hz for the whole run, submits the director request, polls it to
// a terminal state and records every measurement in data/acceptance/volcanic-<unix ms>.json. A model failure is
// reported as FAIL with the activity trail; nothing is retried.
//
// Usage: npx tsx scripts/acceptance-volcanic.ts [--data-dir <scratch>] [--port 7784] [--out-dir data/acceptance]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_PHASES, ROUTES, SIMULATION,
  type AgentActivity, type BuildReport, type DirectorRequest, type PlayerView, type ServerMessage, type TickMessage, type WorldSpec,
} from '@beetle/contracts';
import {
  REPO_ROOT, SERVER_MAIN, TSX_CLI, WsClient, anonFetch, awaitTicks, collectRelic, directorFetch, hexToken, joinController, navigateTo,
  playerIn, sleep, type Controller, type ServerHandle,
} from '../tests/support/server-harness.ts';
import { bridgeTouchesIsland, dist, islandOf, relicPos } from '../tests/support/world-geom.ts';

// ---------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------

const AGENT_MAIN = path.join(REPO_ROOT, 'packages', 'agent', 'src', 'main.ts');
const PROMPT = 'Turn the environment volcanic: water becomes lava. Also add one new bridge from the centre island to the east island as an alternative route. Keep our players and collected relics.';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 7784;
const MODEL = process.env.BEETLE_MODEL ?? 'qwen3.5:4b';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT_MS = Number(process.env.BEETLE_ACCEPTANCE_REQUEST_TIMEOUT_MS ?? 240_000);
const POLL_MS = 1000;
const INPUT_INTERVAL_MS = 50; // 20 Hz
const SERVER_START_TIMEOUT_MS = 90_000;
const AGENT_CONNECT_TIMEOUT_MS = 90_000;
const RELIC_TIMEOUT_MS = 90_000;
const POST_COMMIT_OBSERVE_MS = 3000;
const MAX_TICK_GAP_MS = 1000;
const MAX_STATIONARY_MS = 1500;
const MIN_PATH_M = 10;
const PATROL_HALF_SPAN = 4; // metres either side of the island centre; the centre island has radius 9
const RELIC_ID = 'relic-east';
const CENTRE_ISLAND_ID = 'centre';
const EAST_ISLAND_ID = 'east';

type Args = { dataDir: string | null; port: number; outDir: string };
function parseArgs(argv: string[]): Args {
  const out: Args = { dataDir: process.env.BEETLE_ACCEPTANCE_DATA_DIR ?? null, port: Number(process.env.BEETLE_ACCEPTANCE_PORT ?? DEFAULT_PORT), outDir: path.join(REPO_ROOT, 'data', 'acceptance') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--data-dir') out.dataDir = path.resolve(next());
    else if (a === '--port') { out.port = Number.parseInt(next(), 10); if (!(out.port > 0)) throw new Error('--port must be a positive integer'); }
    else if (a === '--out-dir') out.outDir = path.resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Child processes (server + worker), both `node tsx <entry>` exactly like the launcher, with captured logs.
// ---------------------------------------------------------------------------------------------------------

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; at: number };
type Child = { name: string; pid: number | undefined; logs(): string; exit(): ExitInfo | null; stop(): Promise<void> };

function spawnChild(name: string, entry: string, extraArgs: string[], env: NodeJS.ProcessEnv, redact: string[]): Child {
  const out: string[] = [];
  let bytes = 0;
  const capture = (chunk: Buffer) => {
    let s = chunk.toString('utf8');
    for (const secret of redact) if (secret) s = s.split(secret).join('<redacted>');
    bytes += s.length;
    out.push(s);
    while (bytes > 300_000 && out.length > 1) bytes -= out.shift()!.length;
  };
  const proc: ChildProcess = spawn(process.execPath, [TSX_CLI, entry, ...extraArgs], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);
  let exited: ExitInfo | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    proc.on('exit', (code, signal) => { exited = { code, signal, at: Date.now() }; resolve(); });
    proc.on('error', (err) => { capture(Buffer.from(`[spawn error] ${err.message}\n`)); });
  });
  return {
    name,
    pid: proc.pid,
    logs: () => out.join(''),
    exit: () => exited,
    async stop() {
      if (exited) return;
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      await Promise.race([exitPromise, sleep(8000)]);
      if (!exited) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        await Promise.race([exitPromise, sleep(2000)]);
      }
    },
  };
}

async function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function health(baseUrl: string): Promise<any | null> {
  try {
    const res = await fetch(baseUrl + ROUTES.health, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Tick recording and continuous driving
// ---------------------------------------------------------------------------------------------------------

type TickSample = { t: number; tick: number; worldVersion: number; x: number; z: number; status: string; supportId: string | null; connected: boolean };
type WorldEvent = { t: number; reason: string; version: number; changedIds?: string[]; patchSummary?: string };

class Recorder {
  readonly samples: TickSample[] = [];
  readonly worldMessages: WorldEvent[] = [];
  readonly errors: { t: number; code: string; message: string }[] = [];
  readonly tickTimes: number[] = [];
  closedAt: number | null = null;
  closeInfo: { code: number; reason: string } | null = null;
  constructor(readonly client: WsClient, readonly playerId: string) {
    client.ws.on('message', (data) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(data.toString()) as ServerMessage; } catch { return; }
      const t = Date.now();
      if (msg.type === 'tick') {
        this.tickTimes.push(t);
        const p = playerIn(msg, playerId);
        if (p) this.samples.push({ t, tick: msg.tick, worldVersion: msg.worldVersion, x: p.x, z: p.z, status: p.status, supportId: p.supportId, connected: p.connected });
      } else if (msg.type === 'world') {
        this.worldMessages.push({ t, reason: msg.reason, version: msg.version, changedIds: msg.changedIds, patchSummary: msg.patchSummary });
      } else if (msg.type === 'error') {
        this.errors.push({ t, code: msg.code, message: msg.message });
      }
    });
    client.ws.on('close', (code, reason) => { this.closedAt = Date.now(); this.closeInfo = { code, reason: reason.toString() }; });
  }
}

type GapStats = { ticks: number; gaps: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null; gapsOver1000: number; firstT: number | null; lastT: number | null };
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}
function gapStats(times: number[], from: number, to: number): GapStats {
  const inWindow = times.filter((t) => t >= from && t <= to);
  const gaps: number[] = [];
  for (let i = 1; i < inWindow.length; i++) gaps.push(inWindow[i] - inWindow[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const sum = gaps.reduce((a, b) => a + b, 0);
  return {
    ticks: inWindow.length, gaps: gaps.length,
    meanMs: gaps.length ? Math.round((sum / gaps.length) * 100) / 100 : null,
    p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    gapsOver1000: gaps.filter((g) => g > MAX_TICK_GAP_MS).length,
    firstT: inWindow[0] ?? null, lastT: inWindow[inWindow.length - 1] ?? null,
  };
}

type MotionStats = { samples: number; movedSamples: number; pathLengthM: number; maxStationaryMs: number; statusCounts: Record<string, number>; supportIds: string[]; bbox: { minX: number; maxX: number; minZ: number; maxZ: number } | null };
function motionStats(samples: TickSample[], from: number, to: number): MotionStats {
  const w = samples.filter((s) => s.t >= from && s.t <= to);
  let moved = 0;
  let pathLength = 0;
  let maxStationary = 0;
  let stationarySince: number | null = null;
  const statusCounts: Record<string, number> = {};
  const supports = new Set<string>();
  let bbox: MotionStats['bbox'] = null;
  for (let i = 0; i < w.length; i++) {
    const s = w[i];
    statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
    if (s.supportId) supports.add(s.supportId);
    bbox = bbox ? { minX: Math.min(bbox.minX, s.x), maxX: Math.max(bbox.maxX, s.x), minZ: Math.min(bbox.minZ, s.z), maxZ: Math.max(bbox.maxZ, s.z) } : { minX: s.x, maxX: s.x, minZ: s.z, maxZ: s.z };
    if (i === 0) continue;
    const d = Math.hypot(s.x - w[i - 1].x, s.z - w[i - 1].z);
    if (d > 1e-4) {
      moved++;
      pathLength += d;
      if (stationarySince !== null) { maxStationary = Math.max(maxStationary, s.t - stationarySince); stationarySince = null; }
    } else if (stationarySince === null) {
      stationarySince = w[i - 1].t;
    }
  }
  if (stationarySince !== null && w.length) maxStationary = Math.max(maxStationary, w[w.length - 1].t - stationarySince);
  return { samples: w.length, movedSamples: moved, pathLengthM: Math.round(pathLength * 100) / 100, maxStationaryMs: maxStationary, statusCounts, supportIds: [...supports], bbox };
}

/** Walks back and forth along X at 20 Hz: first toward `firstDir` (+1 east, -1 west) then back, staying on the island. */
function startPatrol(client: WsClient, playerId: string, firstDir: 1 | -1, laneZ: number, centre: { x: number; z: number }) {
  let dir: 1 | -1 = firstDir;
  let flips = 0;
  let sent = 0;
  let zeroSent = 0;
  const timer = setInterval(() => {
    if (!client.isOpen) return;
    const tick = client.lastTick();
    const p = tick ? playerIn(tick, playerId) : undefined;
    if (!p || p.status !== 'active') { client.input({ x: 0, z: 0 }, false); zeroSent++; return; }
    const targetX = centre.x + dir * PATROL_HALF_SPAN;
    if ((dir === 1 && p.x >= targetX) || (dir === -1 && p.x <= targetX)) { dir = dir === 1 ? -1 : 1; flips++; }
    const dx = dir;
    const dz = Math.max(-1, Math.min(1, (centre.z + laneZ - p.z) * 0.8));
    const n = Math.hypot(dx, dz) || 1;
    client.input({ x: dx / n, z: dz / n }, false);
    sent++;
  }, INPUT_INTERVAL_MS);
  return { stop() { clearInterval(timer); if (client.isOpen) client.input({ x: 0, z: 0 }, false); }, stats: () => ({ flips, sent, zeroSent }) };
}

// ---------------------------------------------------------------------------------------------------------
// Assertions and record
// ---------------------------------------------------------------------------------------------------------

type Assertion = { id: string; name: string; pass: boolean; detail: string };
const assertions: Assertion[] = [];
function check(id: string, name: string, pass: boolean, detail: string): boolean {
  assertions.push({ id, name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${name}: ${detail}`);
  return pass;
}

function collectedIds(tick: TickMessage): string[] {
  return Object.entries(tick.relics).filter(([, v]) => v === 'collected').map(([k]) => k).sort();
}
function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
}
function surfaceIds(spec: WorldSpec): Set<string> {
  return new Set([...spec.islands.map((i) => i.id), ...spec.bridges.map((b) => b.id)]);
}
function playerSummary(p: PlayerView | undefined) {
  return p ? { id: p.id, label: p.label, connected: p.connected, status: p.status, supportId: p.supportId, x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 } : null;
}

function renderTable(rows: Assertion[]): string {
  const w = Math.max(...rows.map((r) => r.name.length), 4);
  const lines = [`| Result | Id  | ${'Check'.padEnd(w)} | Detail |`, `|--------|-----|-${'-'.repeat(w)}-|--------|`];
  for (const r of rows) lines.push(`| ${r.pass ? 'PASS  ' : 'FAIL  '} | ${r.id.padEnd(3)} | ${r.name.padEnd(w)} | ${r.detail} |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAtMs = Date.now();
  const record: Record<string, any> = {
    test: 'acceptance-volcanic', startedAt: new Date(startedAtMs).toISOString(), finishedAt: null, prompt: PROMPT,
    config: { port: args.port, host: HOST, model: MODEL, ollamaBaseUrl: OLLAMA_BASE_URL, requestTimeoutMs: REQUEST_TIMEOUT_MS, inputHz: 1000 / INPUT_INTERVAL_MS, tickHz: SIMULATION.tickHz, agentMode: 'direct', requestDeadlineMs: 180_000, modelCallTimeoutMs: 170_000 },
    phases: {} as Record<string, { startMs: number; endMs: number | null; durationMs: number | null }>,
    health: {}, players: {}, baseline: null, request: null, activity: [], activityPhaseTimings: null, report: null, after: null,
    tickGaps: {}, motion: {}, sockets: {}, patrol: {}, assertions: [] as Assertion[], verdict: null as string | null, error: null as string | null,
    dataDir: null as string | null, childLogsTail: {} as Record<string, string>,
  };
  const phase = (name: string) => {
    const now = Date.now();
    for (const p of Object.values(record.phases) as { endMs: number | null; startMs: number; durationMs: number | null }[]) if (p.endMs === null) { p.endMs = now; p.durationMs = now - p.startMs; }
    record.phases[name] = { startMs: now, endMs: null, durationMs: null };
    console.log(`\n== ${name} (+${((now - startedAtMs) / 1000).toFixed(1)} s)`);
  };
  const outDir = args.outDir;
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `volcanic-${startedAtMs}.json`);
  const save = async () => {
    const now = Date.now();
    for (const p of Object.values(record.phases) as { endMs: number | null; startMs: number; durationMs: number | null }[]) if (p.endMs === null) p.durationMs = now - p.startMs;
    record.assertions = assertions;
    await writeFile(outFile, JSON.stringify(record, null, 2) + '\n');
  };

  const dataDir = args.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'beetle-acceptance-')));
  await mkdir(dataDir, { recursive: true });
  record.dataDir = dataDir;
  const directorToken = hexToken();
  const agentToken = hexToken();
  const baseUrl = `http://${HOST}:${args.port}`;
  const server: ServerHandle = {
    mode: 'child', host: HOST, port: args.port, baseUrl, wsUrl: `ws://${HOST}:${args.port}${ROUTES.ws}`, directorToken, agentToken, dataDir,
    logs: () => '', stop: async () => undefined,
  };

  let serverChild: Child | null = null;
  let workerChild: Child | null = null;
  const sockets: WsClient[] = [];
  const patrols: { stop(): void }[] = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const p of patrols) { try { p.stop(); } catch { /* ignore */ } }
    for (const s of sockets) { try { await s.close(); } catch { /* ignore */ } }
    if (workerChild) await workerChild.stop();
    if (serverChild) await serverChild.stop();
    if (serverChild) record.childLogsTail.server = serverChild.logs().slice(-6000);
    if (workerChild) record.childLogsTail.worker = workerChild.logs().slice(-6000);
  };
  const onSignal = (sig: string) => {
    console.error(`\n${sig} received: stopping children`);
    record.error = record.error ?? `interrupted by ${sig}`;
    cleanup().then(() => save()).finally(() => process.exit(130));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    // ---- 1. server + worker ---------------------------------------------------------------------------------
    phase('start-server');
    if (!(await portIsFree(args.port, HOST))) throw new Error(`port ${args.port} on ${HOST} is already in use; refusing to start (never touch the live rehearsal port)`);
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${path.join(REPO_ROOT, '.tools', 'node', 'bin')}:${process.env.PATH ?? ''}` };
    serverChild = spawnChild('server', SERVER_MAIN, [], {
      ...baseEnv,
      BEETLE_PORT: String(args.port), BEETLE_HOST: HOST, BEETLE_PUBLIC_URL: baseUrl, BEETLE_START_WORLD: 'fixture', BEETLE_DATA_DIR: dataDir,
      BEETLE_DIRECTOR_TOKEN: directorToken, BEETLE_AGENT_TOKEN: agentToken, BEETLE_WEB_DIST: '', BEETLE_LOG_REQUESTS: '0',
      OLLAMA_BASE_URL, BEETLE_MODEL: MODEL,
    }, [directorToken, agentToken]);
    console.log(`server pid ${serverChild.pid} on ${baseUrl}, data dir ${dataDir}`);
    {
      const t0 = Date.now();
      for (;;) {
        const ex = serverChild.exit();
        if (ex) throw new Error(`server exited during startup (code ${ex.code}, signal ${ex.signal}):\n${serverChild.logs().slice(-3000)}`);
        const h = await health(baseUrl);
        if (h && h.ok) { record.health.atServerReady = h; break; }
        if (Date.now() - t0 > SERVER_START_TIMEOUT_MS) throw new Error(`server did not answer ${ROUTES.health} within ${SERVER_START_TIMEOUT_MS} ms:\n${serverChild.logs().slice(-3000)}`);
        await sleep(150);
      }
    }
    console.log(`server healthy after ${Date.now() - record.phases['start-server'].startMs} ms (world v${record.health.atServerReady.worldVersion}, hasWorld ${record.health.atServerReady.hasWorld})`);

    phase('start-worker');
    workerChild = spawnChild('worker', AGENT_MAIN, ['--mode', 'direct'], {
      ...baseEnv,
      BEETLE_SERVER_URL: baseUrl, BEETLE_AGENT_TOKEN: agentToken, BEETLE_AGENT_MODE: 'direct', BEETLE_MODEL: MODEL, OLLAMA_BASE_URL,
      BEETLE_REQUEST_DEADLINE_MS: '180000', BEETLE_MODEL_CALL_TIMEOUT_MS: '170000', BEETLE_DATA_DIR: dataDir,
    }, [directorToken, agentToken]);
    console.log(`worker pid ${workerChild.pid} (direct mode, ${MODEL})`);
    {
      const t0 = Date.now();
      for (;;) {
        const ex = workerChild.exit();
        if (ex) throw new Error(`worker exited during startup (code ${ex.code}, signal ${ex.signal}):\n${workerChild.logs().slice(-3000)}`);
        const h = await health(baseUrl);
        if (h && h.ok && h.agentConnected) { record.health.atAgentConnected = h; break; }
        if (Date.now() - t0 > AGENT_CONNECT_TIMEOUT_MS) throw new Error(`health.agentConnected stayed false for ${AGENT_CONNECT_TIMEOUT_MS} ms:\n${workerChild.logs().slice(-3000)}`);
        await sleep(200);
      }
    }
    console.log(`agent connected after ${Date.now() - record.phases['start-worker'].startMs} ms; model status ${JSON.stringify(record.health.atAgentConnected.model ?? null)}`);
    check('A0', 'server + worker up', true, `health ok, agentConnected, world v${record.health.atAgentConnected.worldVersion}`);

    const world0Res = await anonFetch(server, ROUTES.world);
    if (world0Res.status !== 200 || !world0Res.json?.spec) throw new Error(`GET ${ROUTES.world} -> HTTP ${world0Res.status}`);
    const spec0 = world0Res.json.spec as WorldSpec;
    const version0 = world0Res.json.version as number;
    check('A1', 'fixture world is serene', spec0.hazard.kind === 'water' && spec0.worldId === 'garden5', `worldId ${spec0.worldId}, hazard ${spec0.hazard.kind}, v${version0}, bridges [${spec0.bridges.map((b) => b.id).join(', ')}]`);
    const centre = islandOf(spec0, CENTRE_ISLAND_ID);

    // ---- 2. two controllers ---------------------------------------------------------------------------------
    phase('join-controllers');
    const c1: Controller = await joinController(server);
    const c2: Controller = await joinController(server);
    const ws1 = await WsClient.connect(server, { name: 'p1' });
    const ws2 = await WsClient.connect(server, { name: 'p2' });
    sockets.push(ws1, ws2);
    const w1 = await ws1.helloController(c1.controllerToken);
    const w2 = await ws2.helloController(c2.controllerToken);
    const rec1 = new Recorder(ws1, c1.playerId);
    const rec2 = new Recorder(ws2, c2.playerId);
    // A display observer: the server sends `world` messages (reason commit, changedIds, patchSummary) only to
    // display and director sockets; controllers see the version change in the tick stream. The observer acks
    // every world message like the real display page does.
    const wsD = await WsClient.connect(server, { name: 'display' });
    sockets.push(wsD);
    const recD = new Recorder(wsD, '');
    wsD.ws.on('message', (data) => {
      try { const m = JSON.parse(data.toString()) as ServerMessage; if (m.type === 'world' && wsD.isOpen) wsD.ack(m.version); } catch { /* ignore */ }
    });
    await wsD.helloDisplay();
    record.players = {
      p1: { playerId: c1.playerId, label: c1.label, slot: 0, welcomePlayerId: w1.playerId, tickHz: w1.tickHz },
      p2: { playerId: c2.playerId, label: c2.label, slot: 1, welcomePlayerId: w2.playerId, tickHz: w2.tickHz },
    };
    check('A2', 'two controllers joined', w1.playerId === c1.playerId && w2.playerId === c2.playerId && c1.playerId !== c2.playerId, `${c1.label} ${c1.playerId}, ${c2.label} ${c2.playerId}`);
    await awaitTicks(ws1, 2);
    await awaitTicks(ws2, 2);

    // Player 2 starts moving right away: west then back, on the northern lane of the centre island.
    const patrol2 = startPatrol(ws2, c2.playerId, -1, 3, centre.center);
    patrols.push(patrol2);

    // ---- player 1 collects one relic along the bridge graph, then returns to the centre island --------------
    phase('collect-relic');
    const relicTick = await collectRelic(ws1, spec0, c1.playerId, RELIC_ID, RELIC_TIMEOUT_MS);
    console.log(`relic ${RELIC_ID} collected at tick ${relicTick.tick}, score ${relicTick.score} (relic at ${JSON.stringify(relicPos(spec0, RELIC_ID))})`);
    phase('return-to-centre');
    const home = { x: centre.center.x - 2, z: centre.center.z - 3 };
    const back = await navigateTo(ws1, spec0, c1.playerId, home, { tolerance: 0.4, timeoutMs: RELIC_TIMEOUT_MS });
    console.log(`player 1 back on ${back.supportId} at (${back.x.toFixed(2)}, ${back.z.toFixed(2)})`);
    const patrol1 = startPatrol(ws1, c1.playerId, 1, -3, centre.center);
    patrols.push(patrol1);
    await awaitTicks(ws1, 3);
    await awaitTicks(ws2, 3);

    // ---- 3. baseline ----------------------------------------------------------------------------------------
    phase('baseline');
    const base1 = ws1.lastTick()!;
    const base2 = ws2.lastTick()!;
    const worldBeforeRes = await anonFetch(server, ROUTES.world);
    const specBefore = worldBeforeRes.json.spec as WorldSpec;
    const versionBefore = worldBeforeRes.json.version as number;
    const baseline = {
      tick: base1.tick, worldVersion: base1.worldVersion, worldVersionHttp: versionBefore, score: base1.score, collectedRelicIds: collectedIds(base1),
      relics: base1.relics, gate: base1.gate,
      players: base1.players.map((p) => playerSummary(p)),
      p1: playerSummary(playerIn(base1, c1.playerId)), p2: playerSummary(playerIn(base2, c2.playerId)),
      bridgeIds: specBefore.bridges.map((b) => b.id).sort(), islandIds: specBefore.islands.map((i) => i.id).sort(), hazard: specBefore.hazard.kind, title: specBefore.title,
    };
    record.baseline = baseline;
    const p1b = playerIn(base1, c1.playerId);
    const p2b = playerIn(base2, c2.playerId);
    check('A3', 'baseline: relic collected, both players on centre island', baseline.collectedRelicIds.includes(RELIC_ID) && baseline.score > 0 && p1b?.supportId === CENTRE_ISLAND_ID && p2b?.supportId === CENTRE_ISLAND_ID && Boolean(p1b?.connected && p2b?.connected),
      `collected [${baseline.collectedRelicIds.join(', ')}], score ${baseline.score}, v${baseline.worldVersion}, p1 on ${p1b?.supportId}, p2 on ${p2b?.supportId}`);

    // ---- 4. director request ----------------------------------------------------------------------------------
    phase('director-request');
    const submitAt = Date.now();
    const created = await directorFetch(server, ROUTES.directorRequest, { method: 'POST', body: { kind: 'edit', prompt: PROMPT } });
    const req0: DirectorRequest | null = created.json?.request ?? null;
    if (created.status >= 300 || !req0?.id) throw new Error(`POST ${ROUTES.directorRequest} -> HTTP ${created.status}: ${created.text.slice(0, 300)}`);
    console.log(`request ${req0.id} queued at world v${req0.worldVersionAtRequest}`);
    let request: DirectorRequest = req0;
    let activity: AgentActivity[] = [];
    const pollLog: { t: number; status: string; sockets: [boolean, boolean]; tickAgeMs: [number, number] }[] = [];
    let terminalAt: number | null = null;
    for (;;) {
      await sleep(POLL_MS);
      const polled = await directorFetch(server, ROUTES.directorRequestById.replace(':id', req0.id));
      const cur: DirectorRequest | null = polled.json?.request ?? null;
      if (cur) request = cur;
      if (Array.isArray(polled.json?.activity)) activity = polled.json.activity;
      const now = Date.now();
      pollLog.push({ t: now, status: request.status, sockets: [ws1.isOpen, ws2.isOpen], tickAgeMs: [now - (rec1.tickTimes[rec1.tickTimes.length - 1] ?? now), now - (rec2.tickTimes[rec2.tickTimes.length - 1] ?? now)] });
      const latest = activity[activity.length - 1];
      process.stdout.write(`  ${String(now - submitAt).padStart(6)} ms ${request.status.padEnd(20)} ${latest ? latest.message : ''}\n`);
      if (request.status === 'committed' || request.status === 'failed' || request.status === 'cancelled') { terminalAt = now; break; }
      if (now - submitAt > REQUEST_TIMEOUT_MS) break;
    }
    const waitEnd = Date.now();
    record.request = { ...request, submittedAtMs: submitAt, terminalAtMs: terminalAt, directorObservedMs: (terminalAt ?? waitEnd) - submitAt, timedOut: terminalAt === null, pollLog };
    check('A4', 'request reached committed', request.status === 'committed', `status ${request.status}${request.error ? ' error ' + JSON.stringify(request.error) : ''}${terminalAt === null ? ` (timeout after ${REQUEST_TIMEOUT_MS} ms)` : ''}, ${(record.request.directorObservedMs / 1000).toFixed(1)} s observed by the director`);

    // keep playing a little after the terminal state so post-commit ticks and supports are observed
    phase('post-commit-observe');
    await sleep(POST_COMMIT_OBSERVE_MS);

    // ---- activity trail, report, world after ------------------------------------------------------------------
    phase('collect-results');
    const actRes = await directorFetch(server, `${ROUTES.directorActivity}?limit=500`);
    const globalActivity: AgentActivity[] = Array.isArray(actRes.json?.entries) ? actRes.json.entries : [];
    const trail = (activity.length ? activity : globalActivity).filter((a) => a.requestId === req0.id).sort((a, b) => a.at - b.at);
    record.activity = trail;
    const phaseTimings: Record<string, { firstMs: number; lastMs: number; count: number }> = {};
    for (const a of trail) {
      const cur = phaseTimings[a.phase];
      if (!cur) phaseTimings[a.phase] = { firstMs: a.elapsedMs, lastMs: a.elapsedMs, count: 1 };
      else { cur.lastMs = Math.max(cur.lastMs, a.elapsedMs); cur.count++; }
    }
    const ordered = AGENT_PHASES.filter((p) => phaseTimings[p]).map((p) => ({ phase: p, ...phaseTimings[p] }));
    const segments: { from: string; to: string; ms: number }[] = [];
    for (let i = 1; i < ordered.length; i++) segments.push({ from: ordered[i - 1].phase, to: ordered[i].phase, ms: ordered[i].firstMs - ordered[i - 1].firstMs });
    record.activityPhaseTimings = { byPhase: ordered, segments, totalMs: request.finishedAt && request.createdAt ? request.finishedAt - request.createdAt : null, codes: [...new Set(trail.flatMap((a) => a.codes ?? []))], repairs: trail.filter((a) => a.phase === 'repairing').length };
    const reportsRes = await directorFetch(server, ROUTES.directorReports);
    const reports: BuildReport[] = Array.isArray(reportsRes.json?.reports) ? reportsRes.json.reports : [];
    const report = reports.find((r) => r.requestId === req0.id) ?? null;
    record.report = report;

    const worldAfterRes = await anonFetch(server, ROUTES.world);
    const specAfter = worldAfterRes.json.spec as WorldSpec;
    const versionAfter = worldAfterRes.json.version as number;
    const after1 = ws1.lastTick();
    const after2 = ws2.lastTick();
    const p1a = after1 ? playerIn(after1, c1.playerId) : undefined;
    const p2a = after2 ? playerIn(after2, c2.playerId) : undefined;
    const bridgesAfter = specAfter.bridges.map((b) => b.id).sort();
    const newBridges = specAfter.bridges.filter((b) => !baseline.bridgeIds.includes(b.id));
    const removedBridges = baseline.bridgeIds.filter((id) => !bridgesAfter.includes(id));
    const east = specAfter.islands.find((i) => i.id === EAST_ISLAND_ID) ?? null;
    const newEastBridges = east ? newBridges.filter((b) => bridgeTouchesIsland(b, east)) : [];
    const centreAfter = specAfter.islands.find((i) => i.id === CENTRE_ISLAND_ID) ?? null;
    const newCentreEastBridges = east && centreAfter ? newEastBridges.filter((b) => bridgeTouchesIsland(b, centreAfter)) : [];
    const surfaces = surfaceIds(specAfter);
    record.after = {
      worldVersionHttp: versionAfter, hazard: specAfter.hazard.kind, title: specAfter.title, worldId: specAfter.worldId,
      bridgeIds: bridgesAfter, islandIds: specAfter.islands.map((i) => i.id).sort(),
      newBridges: newBridges.map((b) => ({ id: b.id, width: b.width, endpoints: b.endpoints, lengthM: Math.round(dist(b.endpoints[0].point, b.endpoints[1].point) * 100) / 100 })),
      removedBridgeIds: removedBridges, newBridgesTouchingEast: newEastBridges.map((b) => b.id), newBridgesCentreToEast: newCentreEastBridges.map((b) => b.id),
      summary: worldAfterRes.json.summary ?? null,
      tick1: after1 ? { tick: after1.tick, worldVersion: after1.worldVersion, score: after1.score, collectedRelicIds: collectedIds(after1), gate: after1.gate, players: after1.players.map((p) => playerSummary(p)) } : null,
      tick2: after2 ? { tick: after2.tick, worldVersion: after2.worldVersion, score: after2.score, collectedRelicIds: collectedIds(after2), players: after2.players.map((p) => playerSummary(p)) } : null,
      p1: playerSummary(p1a), p2: playerSummary(p2a),
      worldMessages: { display: recD.worldMessages, p1: rec1.worldMessages, p2: rec2.worldMessages },
    };

    // ---- 5. liveness during the wait --------------------------------------------------------------------------
    const waitFrom = submitAt;
    const waitTo = terminalAt ?? waitEnd;
    const runEnd = Date.now();
    record.tickGaps = {
      p1: { wait: gapStats(rec1.tickTimes, waitFrom, waitTo), wholeRun: gapStats(rec1.tickTimes, 0, runEnd) },
      p2: { wait: gapStats(rec2.tickTimes, waitFrom, waitTo), wholeRun: gapStats(rec2.tickTimes, 0, runEnd) },
    };
    record.motion = {
      p1: { wait: motionStats(rec1.samples, waitFrom, waitTo), wholeRun: motionStats(rec1.samples, 0, runEnd) },
      p2: { wait: motionStats(rec2.samples, waitFrom, waitTo), wholeRun: motionStats(rec2.samples, 0, runEnd) },
    };
    record.sockets = {
      p1: { open: ws1.isOpen, closedAt: rec1.closedAt, closeInfo: rec1.closeInfo, errors: rec1.errors, inputsSent: ws1.seq },
      p2: { open: ws2.isOpen, closedAt: rec2.closedAt, closeInfo: rec2.closeInfo, errors: rec2.errors, inputsSent: ws2.seq },
      display: { open: wsD.isOpen, closedAt: recD.closedAt, closeInfo: recD.closeInfo, errors: recD.errors, worldMessages: recD.worldMessages.length },
    };
    record.patrol = { p1: patrol1.stats(), p2: patrol2.stats() };
    const g1 = record.tickGaps.p1.wait as GapStats;
    const g2 = record.tickGaps.p2.wait as GapStats;
    const m1 = record.motion.p1.wait as MotionStats;
    const m2 = record.motion.p2.wait as MotionStats;
    check('A5', 'neither socket closed', ws1.isOpen && ws2.isOpen && rec1.closedAt === null && rec2.closedAt === null, `p1 open ${ws1.isOpen}, p2 open ${ws2.isOpen}, ws errors p1 ${rec1.errors.length} p2 ${rec2.errors.length}`);
    check('A6', 'ticks kept arriving during the wait (max gap < 1 s)', g1.ticks > 0 && g2.ticks > 0 && (g1.maxMs ?? Infinity) < MAX_TICK_GAP_MS && (g2.maxMs ?? Infinity) < MAX_TICK_GAP_MS,
      `p1 ${g1.ticks} ticks, max gap ${g1.maxMs} ms, p99 ${g1.p99Ms} ms; p2 ${g2.ticks} ticks, max gap ${g2.maxMs} ms, p99 ${g2.p99Ms} ms`);
    check('A7', 'both players kept moving during the wait', m1.pathLengthM >= MIN_PATH_M && m2.pathLengthM >= MIN_PATH_M && m1.maxStationaryMs < MAX_STATIONARY_MS && m2.maxStationaryMs < MAX_STATIONARY_MS,
      `p1 path ${m1.pathLengthM} m, moved ${m1.movedSamples}/${m1.samples} ticks, longest still ${m1.maxStationaryMs} ms; p2 path ${m2.pathLengthM} m, moved ${m2.movedSamples}/${m2.samples} ticks, longest still ${m2.maxStationaryMs} ms`);

    // ---- 6. the world after the commit ------------------------------------------------------------------------
    const tickV1 = after1?.worldVersion ?? -1;
    const tickV2 = after2?.worldVersion ?? -1;
    check('A8', 'worldVersion increased by exactly one', versionAfter === versionBefore + 1 && tickV1 === versionBefore + 1 && tickV2 === versionBefore + 1, `v${versionBefore} -> v${versionAfter} (ticks: p1 v${tickV1}, p2 v${tickV2})`);
    check('A9', 'hazard is lava', specAfter.hazard.kind === 'lava', `hazard ${specAfter.hazard.kind}, title "${specAfter.title}"`);
    check('A10', 'bridge set changed with a new bridge touching the east island', newBridges.length > 0 && newEastBridges.length > 0,
      `new [${newBridges.map((b) => `${b.id} ${b.endpoints[0].islandId}->${b.endpoints[1].islandId}`).join(', ') || '-'}], removed [${removedBridges.join(', ') || '-'}], touching east [${newEastBridges.map((b) => b.id).join(', ') || '-'}], centre<->east [${newCentreEastBridges.map((b) => b.id).join(', ') || '-'}]`);
    const collectedAfter1 = after1 ? collectedIds(after1) : [];
    const collectedAfter2 = after2 ? collectedIds(after2) : [];
    check('A11', 'collected relics and score unchanged', Boolean(after1 && after2) && sameSet(collectedAfter1, baseline.collectedRelicIds) && sameSet(collectedAfter2, baseline.collectedRelicIds) && after1!.score === baseline.score && after2!.score === baseline.score,
      `before [${baseline.collectedRelicIds.join(', ')}] score ${baseline.score}; after [${collectedAfter1.join(', ')}] score ${after1?.score}`);
    const idsAfter1 = after1 ? after1.players.map((p) => p.id) : [];
    check('A12', 'both player ids still present and connected', Boolean(p1a && p2a && p1a.connected && p2a.connected) && idsAfter1.includes(c1.playerId) && idsAfter1.includes(c2.playerId),
      `p1 ${c1.playerId} connected ${p1a?.connected ?? 'missing'}, p2 ${c2.playerId} connected ${p2a?.connected ?? 'missing'}`);
    check('A13', 'player supportId values are surfaces of the new world', Boolean(p1a?.supportId && p2a?.supportId) && surfaces.has(p1a!.supportId!) && surfaces.has(p2a!.supportId!),
      `p1 on ${p1a?.supportId ?? 'null'} (${p1a?.status}), p2 on ${p2a?.supportId ?? 'null'} (${p2a?.status}); surfaces [${[...surfaces].join(', ')}]`);
    const commitMsg = recD.worldMessages.find((m) => m.reason === 'commit' && m.version === versionBefore + 1);
    check('A14', 'display observer received the commit world message', Boolean(commitMsg) && wsD.isOpen,
      commitMsg ? `v${commitMsg.version} at +${commitMsg.t - submitAt} ms after submit, changed [${(commitMsg.changedIds ?? []).join(', ')}], summary "${commitMsg.patchSummary ?? ''}"` : `none (display socket open ${wsD.isOpen}, ${recD.worldMessages.length} world messages: ${recD.worldMessages.map((m) => `${m.reason} v${m.version}`).join(', ')})`);
    check('A15', 'build report published for the request', Boolean(report) && report!.outcome === request.status, report ? `outcome ${report.outcome}, mode ${report.mode}, model ${report.model}, attempts ${report.validation.attempts}, failedCodes [${report.validation.failedCodes.join(', ')}], preserved ${JSON.stringify(report.preserved ?? null)}, timings ${JSON.stringify(report.timings)}` : 'no report found');
  } catch (err) {
    record.error = (err as Error).stack ?? String(err);
    console.error(`\nacceptance run aborted: ${(err as Error).message}`);
    check('AX', 'run completed without an unexpected error', false, (err as Error).message.split('\n')[0].slice(0, 300));
  } finally {
    phase('cleanup');
    await cleanup();
    record.phases.cleanup.endMs = Date.now();
    record.phases.cleanup.durationMs = record.phases.cleanup.endMs - record.phases.cleanup.startMs;
    record.finishedAt = new Date().toISOString();
    record.totalMs = Date.now() - startedAtMs;
    record.verdict = assertions.length > 0 && assertions.every((a) => a.pass) ? 'PASS' : 'FAIL';
    await save();
  }

  const act = record.activityPhaseTimings;
  console.log('\n' + renderTable(assertions));
  console.log(`\nVerdict: ${record.verdict}  (${(record.totalMs / 1000).toFixed(1)} s total)`);
  if (act) {
    console.log('Agent phases (ms since request creation): ' + act.byPhase.map((p: { phase: string; firstMs: number }) => `${p.phase}@${p.firstMs}`).join('  '));
    if (act.segments.length) console.log('Phase segments: ' + act.segments.map((s: { from: string; to: string; ms: number }) => `${s.from}->${s.to} ${s.ms} ms`).join(', '));
    if (act.totalMs !== null) console.log(`Request total: ${act.totalMs} ms (director observed ${record.request?.directorObservedMs} ms)`);
  }
  console.log(`Wrote ${outFile}`);
  return record.verdict === 'PASS' ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error('acceptance-volcanic failed: ' + ((err as Error).stack ?? String(err)));
  process.exit(2);
});
