// Functional acceptance test for streaming generation: one phone walks to the edge of the known world and Beetle grows
// the world ahead of it, twice, without dropping the player, a collected relic or the score.
//
// Unattended, end to end, honest: starts the real server (BEETLE_START_WORLD=fixture:seed2 when the fixture exists,
// else garden5 replaced by an inline two-island streaming world through a world candidate commit) and the direct-mode
// worker as child processes on port 7820, joins one controller, collects a relic, walks to the frontier (an island rim
// with no crossing within 45 degrees), waits up to 90 s for the automatic request to commit, measures request-to-commit
// time, asserts preservation and reachability, then walks onto the new island and repeats for a second extension.
// Everything is recorded in data/acceptance/streaming-<unix ms>.json; a PASS/FAIL table is printed; children stopped.
//
// Usage: npx tsx scripts/acceptance-streaming.ts [--port 7820] [--data-dir <scratch>] [--out-dir data/acceptance]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GEOMETRY, ROUTES, STREAMING, type AgentActivity, type DirectorRequest } from '@beetle/contracts';
import {
  REPO_ROOT, SERVER_MAIN, TSX_CLI, agentFetch, awaitTicks, collectRelic, commitUntilSettled, currentPlayer, directorFetch, driveTo, hexToken,
  navigateTo, playerIn, posOf, sleep, validateCandidate, type ServerHandle,
} from '../tests/support/server-harness.ts';
import {
  angleDeg, angleDiff, autoRequests, collectedOf, directionMatches, getRequest, inlineTwoIslandWorld, islandReachable, joinSolo, openHeading,
  patrol, publicWorld, rimDistance, rimPoint, seed2Available, snapPlayers, ticksAroundVersion, waitForNewAutoRequest, type Solo,
} from '../tests/support/streaming-helpers.ts';
import { dist, islandOf } from '../tests/support/world-geom.ts';

const AGENT_MAIN = path.join(REPO_ROOT, 'packages', 'agent', 'src', 'main.ts');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 7820;
const ALLOWED_PORTS = { min: 7820, max: 7829 };
const MODEL = process.env.BEETLE_MODEL ?? 'qwen3.5:4b';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const COMMIT_TIMEOUT_MS = 90_000;
const DETECT_TIMEOUT_MS = 15_000;
const EXTENSIONS = 2;
const SERVER_START_TIMEOUT_MS = 90_000;
const AGENT_CONNECT_TIMEOUT_MS = 90_000;
const MAX_POSITION_JUMP_M = 1.0;

type Args = { dataDir: string | null; port: number; outDir: string };
function parseArgs(argv: string[]): Args {
  const out: Args = { dataDir: null, port: Number(process.env.BEETLE_ACCEPTANCE_PORT ?? DEFAULT_PORT), outDir: path.join(REPO_ROOT, 'data', 'acceptance') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--data-dir') out.dataDir = path.resolve(next());
    else if (a === '--port') out.port = Number.parseInt(next(), 10);
    else if (a === '--out-dir') out.outDir = path.resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(out.port >= ALLOWED_PORTS.min && out.port <= ALLOWED_PORTS.max)) throw new Error(`--port must be within ${ALLOWED_PORTS.min}..${ALLOWED_PORTS.max} (other ports belong to other runs)`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------------------------------------

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
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
    proc.on('exit', (code, signal) => { exited = { code, signal }; resolve(); });
    proc.on('error', (err) => capture(Buffer.from(`[spawn error] ${err.message}\n`)));
  });
  return {
    name, pid: proc.pid, logs: () => out.join(''), exit: () => exited,
    async stop() {
      if (exited) return;
      try { proc.kill('SIGTERM'); } catch { /* gone */ }
      await Promise.race([exitPromise, sleep(8000)]);
      if (!exited) { try { proc.kill('SIGKILL'); } catch { /* gone */ } await Promise.race([exitPromise, sleep(2000)]); }
    },
  };
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

async function health(baseUrl: string): Promise<any | null> {
  try {
    const res = await fetch(baseUrl + ROUTES.health, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------------------------------------

type Check = { id: string; name: string; pass: boolean; detail: string };
type Extension = {
  n: number; islandId: string; headingDeg: number; frontierPoint: { x: number; z: number };
  requestId?: string; autoReason?: DirectorRequest['autoReason']; prompt?: string; status?: string;
  arrivedAt?: number; requestCreatedAt?: number; requestSeenAt?: number; finishedAt?: number; versionSeenAt?: number;
  arrivalToRequestMs?: number; requestToCommitMs?: number; requestToVersionTickMs?: number;
  versionBefore?: number; versionAfter?: number; resultWorldVersion?: number;
  newIslands?: { id: string; center: { x: number; z: number }; radius: number; bearingDeg: number; offHeadingDeg: number }[];
  reachability?: unknown[]; positionJumpM?: number; activity?: AgentActivity[];
  walkedOnto?: string | null;
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const directorToken = hexToken();
  const agentToken = hexToken();
  const dataDir = args.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'beetle-accept-streaming-')));
  const useSeed2 = seed2Available();
  const record: Record<string, any> = {
    kind: 'acceptance-streaming', startedAt, port: args.port, model: MODEL, dataDir,
    world: { source: useSeed2 ? 'fixture:seed2' : 'inline-two-island via world candidate commit' },
    limits: { ...STREAMING }, checks: [] as Check[], extensions: [] as Extension[], phases: {} as Record<string, number>, error: null as string | null, childLogsTail: {},
  };
  const checks: Check[] = record.checks;
  const check = (id: string, name: string, pass: boolean, detail: string) => {
    checks.push({ id, name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}: ${detail}`);
  };
  const phase = (name: string) => { record.phases[name] = Date.now() - startedAt; console.log(`-- ${name} (+${record.phases[name]} ms)`); };

  const baseUrl = `http://${HOST}:${args.port}`;
  const server: ServerHandle = {
    mode: 'child', host: HOST, port: args.port, baseUrl, wsUrl: `ws://${HOST}:${args.port}${ROUTES.ws}`, directorToken, agentToken, dataDir,
    logs: () => '', stop: async () => undefined,
  };
  let serverChild: Child | null = null;
  let workerChild: Child | null = null;
  let p: Solo | null = null;
  const walkers: { stop(): void }[] = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const w of walkers) { try { w.stop(); } catch { /* ignore */ } }
    if (p) { try { await p.ws.close(); } catch { /* ignore */ } }
    if (workerChild) await workerChild.stop();
    if (serverChild) await serverChild.stop();
    if (serverChild) record.childLogsTail.server = serverChild.logs().slice(-6000);
    if (workerChild) record.childLogsTail.worker = workerChild.logs().slice(-6000);
  };
  const save = async () => {
    record.finishedAt = Date.now();
    record.totalMs = record.finishedAt - startedAt;
    record.pass = !record.error && checks.length > 0 && checks.every((c) => c.pass);
    await mkdir(args.outDir, { recursive: true });
    const file = path.join(args.outDir, `streaming-${startedAt}.json`);
    await writeFile(file, JSON.stringify(record, null, 2) + '\n');
    return file;
  };
  process.on('SIGINT', () => { record.error = record.error ?? 'interrupted by SIGINT'; cleanup().then(save).finally(() => process.exit(130)); });

  try {
    // ---- server --------------------------------------------------------------------------------------------
    phase('start-server');
    if (!(await portIsFree(args.port))) throw new Error(`port ${args.port} is in use; refusing to start`);
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${path.join(REPO_ROOT, '.tools', 'node', 'bin')}:${process.env.PATH ?? ''}` };
    serverChild = spawnChild('server', SERVER_MAIN, [], {
      ...baseEnv,
      BEETLE_PORT: String(args.port), BEETLE_HOST: HOST, BEETLE_PUBLIC_URL: baseUrl, BEETLE_START_WORLD: useSeed2 ? 'fixture:seed2' : 'fixture',
      BEETLE_DATA_DIR: dataDir, BEETLE_DIRECTOR_TOKEN: directorToken, BEETLE_AGENT_TOKEN: agentToken, BEETLE_WEB_DIST: '', BEETLE_LOG_REQUESTS: '0',
      OLLAMA_BASE_URL, BEETLE_MODEL: MODEL,
    }, [directorToken, agentToken]);
    for (const t0 = Date.now(); ;) {
      const ex = serverChild.exit();
      if (ex) throw new Error(`server exited during startup (code ${ex.code}):\n${serverChild.logs().slice(-3000)}`);
      const h = await health(baseUrl);
      if (h?.ok) break;
      if (Date.now() - t0 > SERVER_START_TIMEOUT_MS) throw new Error(`server not healthy after ${SERVER_START_TIMEOUT_MS} ms`);
      await sleep(150);
    }
    console.log(`server pid ${serverChild.pid} healthy on ${baseUrl}`);

    let w0 = await publicWorld(server);
    if (!(w0.spec.streaming === true && w0.spec.islands.length <= 3)) {
      // Fallback: replace the fixture with the inline two-island streaming world through a world candidate commit.
      phase('install-inline-world');
      const staged = await agentFetch(server, ROUTES.agentProposeWorld, { method: 'POST', body: { requestId: 'req-accept-stream-seed', spec: inlineTwoIslandWorld() } });
      if (staged.status >= 300 || !staged.json?.candidateId) throw new Error(`propose world -> HTTP ${staged.status} ${staged.text.slice(0, 400)}`);
      const v = await validateCandidate(server, staged.json.candidateId);
      if (!v.ok || !v.proof) throw new Error(`inline world failed validation: ${JSON.stringify(v.issues)}`);
      const c = await commitUntilSettled(server, staged.json.candidateId, v.proof.proofId);
      if (!c.ok) throw new Error(`inline world commit failed: ${c.code} ${c.message}`);
      w0 = await publicWorld(server);
      record.world.source = 'inline-two-island via world candidate commit';
    }
    record.world.initial = { worldId: w0.spec.worldId, version: w0.version, islands: w0.spec.islands.map((i) => i.id), bridges: w0.spec.bridges.map((b) => b.id), streaming: w0.spec.streaming };
    check('S0', 'streaming world installed', w0.spec.streaming === true, `${w0.spec.worldId} v${w0.version}, islands [${w0.spec.islands.map((i) => i.id).join(', ')}], streaming ${w0.spec.streaming}`);

    // ---- worker --------------------------------------------------------------------------------------------
    phase('start-worker');
    workerChild = spawnChild('worker', AGENT_MAIN, ['--mode', 'direct'], {
      ...baseEnv,
      BEETLE_SERVER_URL: baseUrl, BEETLE_AGENT_TOKEN: agentToken, BEETLE_AGENT_MODE: 'direct', BEETLE_MODEL: MODEL, OLLAMA_BASE_URL,
      BEETLE_REQUEST_DEADLINE_MS: '85000', BEETLE_MODEL_CALL_TIMEOUT_MS: '80000', BEETLE_DATA_DIR: dataDir,
    }, [directorToken, agentToken]);
    for (const t0 = Date.now(); ;) {
      const ex = workerChild.exit();
      if (ex) throw new Error(`worker exited during startup (code ${ex.code}):\n${workerChild.logs().slice(-3000)}`);
      const h = await health(baseUrl);
      if (h?.ok && h.agentConnected) { record.healthAtAgent = h; break; }
      if (Date.now() - t0 > AGENT_CONNECT_TIMEOUT_MS) throw new Error(`agent not connected after ${AGENT_CONNECT_TIMEOUT_MS} ms:\n${workerChild.logs().slice(-3000)}`);
      await sleep(200);
    }
    check('S1', 'server + direct worker up', true, `worker pid ${workerChild.pid}, model ${MODEL}`);

    // ---- player --------------------------------------------------------------------------------------------
    phase('join');
    p = await joinSolo(server, 'p1');
    const pid = p.c.playerId;
    const spawnIsland = w0.spec.spawns[0].supportingSurfaceId;
    const relic = w0.spec.relics.find((r) => r.supportingSurfaceId === spawnIsland);
    if (relic) {
      phase('collect-relic');
      const t = await collectRelic(p.ws, w0.spec, pid, relic.id, 60_000);
      check('S2', 'relic collected before streaming', t.relics[relic.id] === 'collected' && t.score > 0, `${relic.id} collected, score ${t.score}`);
    } else {
      check('S2', 'relic collected before streaming', false, `no relic on spawn island ${spawnIsland}; preservation checks cover score 0 only`);
    }

    // ---- extensions -----------------------------------------------------------------------------------------
    let currentIsland = spawnIsland;
    let lastAutoAt = 0;
    for (let n = 1; n <= EXTENSIONS; n++) {
      phase(`extension-${n}`);
      const before = await publicWorld(server);
      const island = islandOf(before.spec, currentIsland);
      const heading = openHeading(before.spec, island.id);
      const insetA = rimPoint(island, heading, 2.2, 1.5);
      const insetB = rimPoint(island, heading, 2.2, -1.5);
      const ext: Extension = { n, islandId: island.id, headingDeg: heading, frontierPoint: insetA };
      record.extensions.push(ext);

      // Respect the cooldown before approaching (the server would hold the request back anyway).
      const wait = lastAutoAt + STREAMING.cooldownMs + 500 - Date.now();
      if (wait > 0) { console.log(`waiting ${wait} ms for the cooldown`); await sleep(wait); }

      // A request still open from earlier (e.g. the relic walk touched the frontier band) counts for this extension.
      const prior = await autoRequests(server);
      const open = prior.find((r) => !['committed', 'failed', 'cancelled'].includes(r.status));
      const known = prior.filter((r) => r !== open).map((r) => r.id);
      const baseTick = await awaitTicks(p.ws, 2);
      const base = { version: baseTick.worldVersion, score: baseTick.score, collected: collectedOf(baseTick), players: snapPlayers(baseTick) };
      ext.versionBefore = base.version;

      await navigateTo(p.ws, before.spec, pid, insetA, { tolerance: 0.35, timeoutMs: 40_000 });
      ext.arrivedAt = Date.now();
      const atRim = await currentPlayer(p.ws, pid);
      console.log(`extension ${n}: player at (${atRim.x.toFixed(1)}, ${atRim.z.toFixed(1)}) on ${atRim.supportId}, ${rimDistance(island, posOf(atRim)).toFixed(2)} m from the ${island.id} rim, heading ${heading} deg`);
      // Keep walking along the rim band while Beetle works.
      const walk = patrol(p.ws, pid, insetA, insetB);
      walkers.push(walk);
      const since = p.ws.cursor();
      let req: DirectorRequest | null = null;
      try {
        req = await waitForNewAutoRequest(server, known, DETECT_TIMEOUT_MS, 300);
        ext.requestSeenAt = Date.now();
        if (!req) {
          check(`E${n}.1`, `extension ${n}: automatic request created`, false, `none within ${DETECT_TIMEOUT_MS} ms at the ${island.id} rim`);
          continue;
        }
        lastAutoAt = Math.max(lastAutoAt, req.createdAt);
        ext.requestId = req.id; ext.autoReason = req.autoReason; ext.prompt = req.prompt; ext.requestCreatedAt = req.createdAt;
        ext.arrivalToRequestMs = req.createdAt - ext.arrivedAt; // negative: created while still walking into the band
        check(`E${n}.1`, `extension ${n}: automatic request created`,
          req.auto === true && req.kind === 'edit' && req.autoReason?.islandId === island.id && req.autoReason?.playerId === pid && directionMatches(req.autoReason?.direction ?? '', heading),
          `${req.id} kind ${req.kind}, autoReason ${JSON.stringify(req.autoReason)}, ${ext.arrivalToRequestMs} ms after arrival`);

        // Wait for the request to reach a terminal state.
        let r: DirectorRequest | null = req;
        while (r && !['committed', 'failed', 'cancelled'].includes(r.status) && Date.now() - req.createdAt < COMMIT_TIMEOUT_MS) {
          await sleep(500);
          r = await getRequest(server, req.id);
        }
        ext.status = r?.status ?? 'missing';
        lastAutoAt = Math.max(lastAutoAt, r?.finishedAt ?? Date.now()); // the server's cooldown also runs from settle
        ext.finishedAt = r?.finishedAt;
        ext.resultWorldVersion = r?.resultWorldVersion;
        const full = await directorFetch(server, ROUTES.directorRequestById.replace(':id', req.id));
        ext.activity = (full.json?.activity ?? []).map((a: AgentActivity) => ({ ...a }));
        const committed = r?.status === 'committed';
        ext.requestToCommitMs = committed && r?.finishedAt ? r.finishedAt - req.createdAt : undefined;
        check(`E${n}.2`, `extension ${n}: committed within ${COMMIT_TIMEOUT_MS / 1000} s`, committed && (ext.requestToCommitMs ?? Infinity) <= COMMIT_TIMEOUT_MS,
          committed ? `request to commit ${ext.requestToCommitMs} ms` : `status ${ext.status} after ${Date.now() - req.createdAt} ms; last activity: ${ext.activity?.slice(-3).map((a) => `${a.phase}: ${a.message}`).join(' | ')}`);
        if (!committed) continue;

        const versionTick = await p.ws.waitForTick((t) => t.worldVersion > base.version, 10_000, 'tick at new version').catch(() => null);
        ext.versionSeenAt = Date.now();
        ext.requestToVersionTickMs = versionTick ? ext.versionSeenAt - req.createdAt : undefined;
        await awaitTicks(p.ws, 5);
      } finally {
        walk.stop();
      }

      // ---- preservation -------------------------------------------------------------------------------------
      const after = await publicWorld(server);
      ext.versionAfter = after.version;
      const { before: tb, after: ta } = ticksAroundVersion(p.ws, since, after.version);
      const pb = tb ? playerIn(tb, pid) : undefined;
      const pa = ta ? playerIn(ta, pid) : undefined;
      ext.positionJumpM = pb && pa ? dist(posOf(pb), posOf(pa)) : undefined;
      check(`E${n}.3`, `extension ${n}: version +1`, after.version === base.version + 1 && ext.resultWorldVersion === after.version, `v${base.version} -> v${after.version} (request resultWorldVersion ${ext.resultWorldVersion})`);
      const ids = (ta?.players ?? []).map((x) => x.id).sort();
      check(`E${n}.4`, `extension ${n}: player preserved`,
        Boolean(pa && pb && pa.connected && pa.status === 'active' && JSON.stringify(ids) === JSON.stringify(base.players.map((x) => x.id).sort()) && (ext.positionJumpM ?? Infinity) <= MAX_POSITION_JUMP_M),
        pa && pb ? `${pid} connected ${pa.connected}, ${pa.status}, (${pb.x.toFixed(2)}, ${pb.z.toFixed(2)}) -> (${pa.x.toFixed(2)}, ${pa.z.toFixed(2)}), jump ${ext.positionJumpM!.toFixed(3)} m across ${ta!.serverMs - tb!.serverMs} ms` : 'no tick pair around the version change');
      check(`E${n}.5`, `extension ${n}: relics and score preserved`,
        Boolean(ta && JSON.stringify(collectedOf(ta)) === JSON.stringify(base.collected) && ta.score === base.score),
        `collected [${ta ? collectedOf(ta).join(', ') : '?'}] (was [${base.collected.join(', ')}]), score ${ta?.score} (was ${base.score})`);

      const beforeIds = new Set(before.spec.islands.map((i) => i.id));
      const added = after.spec.islands.filter((i) => !beforeIds.has(i.id));
      ext.newIslands = added.map((i) => {
        const bearingDeg = angleDeg(island.center, i.center);
        return { id: i.id, center: i.center, radius: i.radius, bearingDeg: Math.round(bearingDeg), offHeadingDeg: Math.round(angleDiff(bearingDeg, heading)) };
      });
      const reach = added.map((i) => islandReachable(after.spec, i.id, island.id));
      ext.reachability = reach;
      const removed = before.spec.islands.filter((i) => !after.spec.islands.some((x) => x.id === i.id)).map((i) => i.id);
      check(`E${n}.6`, `extension ${n}: 1 or 2 new islands, nothing removed`, added.length >= STREAMING.islandsPerExtension.min && added.length <= STREAMING.islandsPerExtension.max && removed.length === 0,
        `added [${added.map((i) => `${i.id} @(${i.center.x}, ${i.center.z}) r${i.radius}`).join(', ')}], removed [${removed.join(', ')}]`);
      check(`E${n}.7`, `extension ${n}: new islands reachable`, added.length > 0 && reach.every((r) => r.ok), reach.map((r) => `${r.islandId}: ${r.detail}`).join('; ') || 'no new island');
      check(`E${n}.8`, `extension ${n}: new islands toward the frontier`, added.length > 0 && ext.newIslands.some((i) => i.offHeadingDeg <= 67.5),
        ext.newIslands.map((i) => `${i.id} bearing ${i.bearingDeg} deg (${i.offHeadingDeg} off ${heading})`).join(', ') || 'none');

      // Walk onto the new island nearest the heading: proves reachability on foot and sets up the next frontier.
      const nextIsland = added.filter((i) => reach.find((r) => r.islandId === i.id)?.ok)
        .sort((a, b) => angleDiff(angleDeg(island.center, a.center), heading) - angleDiff(angleDeg(island.center, b.center), heading))[0];
      if (nextIsland) {
        phase(`walk-onto-${nextIsland.id}`);
        const there = await navigateTo(p.ws, after.spec, pid, { x: nextIsland.center.x, z: nextIsland.center.z }, { tolerance: 0.6, timeoutMs: 60_000 }).catch((e: Error) => { console.log(`walk failed: ${e.message}`); return null; });
        const settled = there ? playerIn(await awaitTicks(p.ws, 2), pid) : undefined;
        ext.walkedOnto = settled?.supportId ?? null;
        check(`E${n}.9`, `extension ${n}: player walked onto ${nextIsland.id}`, settled?.supportId === nextIsland.id, `supportId ${settled?.supportId ?? 'n/a'}`);
        if (settled?.supportId === nextIsland.id) currentIsland = nextIsland.id;
      }
    }
  } catch (err) {
    record.error = (err as Error).stack ?? String(err);
    console.error(`ERROR: ${(err as Error).message}`);
  } finally {
    phase('cleanup');
    await cleanup();
  }
  const file = await save();

  // ---- table --------------------------------------------------------------------------------------------------
  console.log('\nStreaming acceptance');
  console.log('ID     RESULT  CHECK');
  for (const c of checks) console.log(`${c.id.padEnd(6)} ${(c.pass ? 'PASS' : 'FAIL').padEnd(7)} ${c.name}`);
  for (const e of record.extensions as Extension[]) {
    console.log(`extension ${e.n}: island ${e.islandId} heading ${e.headingDeg} deg, request ${e.requestId ?? '-'} (${e.autoReason?.direction ?? '-'}), status ${e.status ?? '-'}, arrival->request ${e.arrivalToRequestMs ?? '-'} ms, request->commit ${e.requestToCommitMs ?? '-'} ms, request->tick ${e.requestToVersionTickMs ?? '-'} ms, v${e.versionBefore ?? '?'} -> v${e.versionAfter ?? '?'}, new [${(e.newIslands ?? []).map((i) => i.id).join(', ')}]`);
  }
  if (record.error) console.log(`ERROR: ${String(record.error).split('\n')[0]}`);
  console.log(`\n${record.pass ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.pass).length}/${checks.length} checks) -> ${path.relative(REPO_ROOT, file)}`);
  void GEOMETRY;
  return record.pass ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
