// Live model tests (cases 17 and 18): a real edit request through the agent package against the real server with the
// fixture world. Skipped unless BEETLE_LIVE_MODEL=1. The openclaw-mode test additionally needs BEETLE_LIVE_OPENCLAW=1.
// Nothing here talks to a cloud model: the agent is configured with the loopback Ollama endpoint only.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES, SCORING, type BuildReport, type DirectorRequest, type TickMessage, type WorldMessage, type WorldSpec } from '@beetle/contracts';
import {
  REPO_ROOT, TSX_CLI, WsClient, agentWorld, awaitTicks, collectRelic, createDirectorRequest, directorFetch, joinController, playerIn,
  sleep, startServer, waitUntil, type Controller, type ServerHandle,
} from '../support/server-harness.ts';
import { bridgeTouchesIsland, relicsByRouteLength } from '../support/world-geom.ts';

const LIVE = process.env.BEETLE_LIVE_MODEL === '1';
const LIVE_OPENCLAW = process.env.BEETLE_LIVE_OPENCLAW === '1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.BEETLE_MODEL ?? 'qwen3.5:4b';
const PROMPT = 'Turn the water into lava and add a bridge to the northern island. Keep our players and collected relics.';
const AGENT_INDEX = path.join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const AGENT_MAIN = path.join(REPO_ROOT, 'packages', 'agent', 'src', 'main.ts');
const JOB_TIMEOUT_MS = Number(process.env.BEETLE_LIVE_JOB_TIMEOUT_MS ?? 240_000);

type AgentRun = { how: 'in-process' | 'child'; wallMs: number; log: string };

function northernIsland(spec: WorldSpec) {
  return [...spec.islands].sort((a, b) => b.center.z - a.center.z)[0];
}

/** Runs one agent job for the queued request, in-process when the package exports what we need, else as a child. */
async function runAgentOnce(server: ServerHandle, mode: 'direct' | 'openclaw'): Promise<AgentRun> {
  const env: Record<string, string> = {
    BEETLE_SERVER_URL: server.baseUrl,
    BEETLE_AGENT_TOKEN: server.agentToken,
    BEETLE_AGENT_MODE: mode,
    BEETLE_DATA_DIR: server.dataDir,
    OLLAMA_BASE_URL,
    BEETLE_MODEL: MODEL,
    BEETLE_REQUEST_DEADLINE_MS: String(Math.max(60_000, JOB_TIMEOUT_MS - 30_000)),
    BEETLE_WORKER_ID: `it-${mode}-${process.pid}`,
  };
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    // eslint-disable-next-line no-console
    console.log(`[agent:${mode}] ${line}`);
  };
  const t0 = Date.now();
  if (existsSync(AGENT_INDEX)) {
    try {
      const modulePath = AGENT_INDEX;
      const agent = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
      const loadConfig = agent.loadConfig as (o: { env: NodeJS.ProcessEnv; mode: 'direct' | 'openclaw' }) => Promise<Record<string, unknown>>;
      const createBeetleClient = agent.createBeetleClient as (o: { serverUrl: string; token: string }) => unknown;
      const createDirectRunner = agent.createDirectRunner as (d: Record<string, unknown>) => unknown;
      const createOpenClawRunner = agent.createOpenClawRunner as (d: Record<string, unknown>) => unknown;
      const startWorker = agent.startWorker as (o: Record<string, unknown>) => { stop(): void; done: Promise<{ processed: number }> };
      if (loadConfig && createBeetleClient && startWorker && (mode === 'direct' ? createDirectRunner : createOpenClawRunner)) {
        const config = await loadConfig({ env: { ...process.env, ...env }, mode });
        const client = createBeetleClient({ serverUrl: server.baseUrl, token: server.agentToken });
        const runner = mode === 'direct'
          ? createDirectRunner({ config, client, log })
          : createOpenClawRunner({ config, client, log });
        const worker = startWorker({ config, client, runner, log, once: true, claimTimeoutMs: 15_000 });
        const timer = setTimeout(() => worker.stop(), JOB_TIMEOUT_MS);
        try {
          await worker.done;
        } finally {
          clearTimeout(timer);
        }
        return { how: 'in-process', wallMs: Date.now() - t0, log: lines.join('\n') };
      }
    } catch (err) {
      log(`in-process agent failed (${(err as Error).message}); falling back to child process`);
    }
  }
  if (!existsSync(AGENT_MAIN)) throw new Error(`agent entry point missing: ${AGENT_MAIN}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, AGENT_MAIN, '--mode', mode, '--once'], {
      cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer) => { for (const l of chunk.toString('utf8').split(/\r?\n/)) if (l.trim()) log(l.replace(server.agentToken, '<agent-token>')); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const killer = setTimeout(() => child.kill('SIGTERM'), JOB_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(); else reject(new Error(`agent child exited with code ${code}:\n${lines.slice(-30).join('\n')}`));
    });
    child.on('error', reject);
  });
  return { how: 'child', wallMs: Date.now() - t0, log: lines.join('\n') };
}

async function ollamaHasModel(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (body.models ?? []).some((m) => m.name === MODEL || m.model === MODEL);
  } catch {
    return false;
  }
}

async function runLiveEdit(mode: 'direct' | 'openclaw') {
  const server = await startServer({ startWorld: 'fixture', env: { OLLAMA_BASE_URL, BEETLE_MODEL: MODEL } });
  const sockets: WsClient[] = [];
  try {
    const base = await agentWorld(server);
    expect(base.spec.hazard.kind).toBe('water');
    const north = northernIsland(base.spec);
    const northBridgesBefore = base.spec.bridges.filter((b) => bridgeTouchesIsland(b, north)).map((b) => b.id);

    // Two players join; one collects a relic so there is something to preserve.
    const c1: Controller = await joinController(server);
    const c2: Controller = await joinController(server);
    const ws1 = await WsClient.connect(server, { name: 'p1' });
    const ws2 = await WsClient.connect(server, { name: 'p2' });
    const display = await WsClient.connect(server, { name: 'display' });
    sockets.push(ws1, ws2, display);
    await ws1.helloController(c1.controllerToken);
    await ws2.helloController(c2.controllerToken);
    await display.helloDisplay(base.version);
    await ws1.waitForTick((t) => Boolean(playerIn(t, c1.playerId)?.connected && playerIn(t, c2.playerId)?.connected), 5000, 'both connected');
    const p1 = await awaitTicks(ws1, 2).then((t) => playerIn(t, c1.playerId)!);
    const relic = relicsByRouteLength(base.spec, { x: p1.x, z: p1.z })[0].relic.id;
    const collectedTick = await collectRelic(ws1, base.spec, c1.playerId, relic, 60_000);
    expect(collectedTick.relics[relic]).toBe('collected');
    expect(collectedTick.score).toBe(SCORING.relic);

    // The director asks for the edit; the agent claims and runs it.
    const created = await createDirectorRequest(server, PROMPT, 'edit');
    expect(created.status).toBe(200);
    const createdBody = created.json as unknown as { request?: DirectorRequest } & DirectorRequest;
    const request: DirectorRequest = createdBody.request ?? createdBody;
    expect(request.kind).toBe('edit');
    expect(request.worldVersionAtRequest).toBe(base.version);
    const sinceWorld = display.cursor();
    const sinceTick1 = ws1.cursor();
    const sinceTick2 = ws2.cursor();
    const startedAt = Date.now();
    const run = await runAgentOnce(server, mode);

    const finished = await waitUntil(async () => {
      const res = await directorFetch(server, ROUTES.directorRequestById.replace(':id', request.id));
      const r: DirectorRequest | undefined = res.json?.request;
      return r && (r.status === 'committed' || r.status === 'failed' || r.status === 'cancelled') ? r : null;
    }, 30_000, 500, 'request to finish');
    const reports = (await directorFetch<{ reports: BuildReport[] }>(server, ROUTES.directorReports)).json.reports ?? [];
    const report = reports.find((r) => r.requestId === request.id) ?? null;
    const timings = {
      mode,
      agentRun: run.how,
      wallMs: run.wallMs,
      sinceRequestMs: Date.now() - startedAt,
      report: report ? { outcome: report.outcome, mode: report.mode, model: report.model, timings: report.timings, validation: report.validation, toolCalls: report.toolCalls.length, preserved: report.preserved } : null,
      requestStatus: finished.status,
      error: finished.error ?? null,
    };
    // eslint-disable-next-line no-console
    console.log(`[live-agent] measured: ${JSON.stringify(timings)}`);

    expect(finished.status, `request ${request.id} ended ${finished.status}: ${JSON.stringify(finished.error)}\n${run.log.slice(-2000)}`).toBe('committed');
    expect(report).not.toBeNull();
    expect(report!.mode).toBe(mode);
    expect(report!.outcome).toBe('committed');
    expect(report!.model).toBe(MODEL);

    const after = await agentWorld(server);
    expect(after.version).toBe(base.version + 1);
    expect(finished.resultWorldVersion).toBe(base.version + 1);
    expect(after.spec.hazard.kind).toBe('lava');
    expect(after.spec.hazard.policy.scorePenalty).toBe(SCORING.lavaFallPenalty);
    const northAfter = after.spec.islands.find((i) => i.id === north.id) ?? northernIsland(after.spec);
    const northBridgesAfter = after.spec.bridges.filter((b) => bridgeTouchesIsland(b, northAfter)).map((b) => b.id);
    const newNorthBridges = northBridgesAfter.filter((id) => !northBridgesBefore.includes(id));
    expect(newNorthBridges.length, `bridges touching ${north.id} before: ${northBridgesBefore.join(',')} after: ${northBridgesAfter.join(',')}`).toBeGreaterThanOrEqual(1);

    // The display received the commit broadcast; players and collected relics are preserved and both controller
    // sockets stayed open and receive ticks at the new version.
    const world = await display.waitFor<WorldMessage>((m) => m.type === 'world' && m.reason === 'commit', 5000, { since: sinceWorld, label: 'commit broadcast on display' });
    expect(world.version).toBe(base.version + 1);
    expect(world.spec.hazard.kind).toBe('lava');
    const tick1 = await ws1.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === base.version + 1, 5000, { since: sinceTick1, label: 'tick at new version on p1' });
    const tick2 = await ws2.waitFor<TickMessage>((m) => m.type === 'tick' && m.worldVersion === base.version + 1, 5000, { since: sinceTick2, label: 'tick at new version on p2' });
    expect(tick1.players.map((p) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
    expect(tick2.players.map((p) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
    expect(playerIn(tick1, c1.playerId)?.connected).toBe(true);
    expect(playerIn(tick1, c2.playerId)?.connected).toBe(true);
    expect(tick1.relics[relic]).toBe('collected');
    expect(tick1.score).toBe(SCORING.relic);
    expect(after.summary.collectedRelicIds).toEqual([relic]);
    expect(after.summary.players.map((p) => p.id).sort()).toEqual([c1.playerId, c2.playerId].sort());
    return timings;
  } finally {
    for (const s of sockets) await s.close().catch(() => undefined);
    await server.stop();
  }
}

describe.skipIf(!LIVE)('live agent (BEETLE_LIVE_MODEL=1)', () => {
  let modelReady = false;
  beforeAll(async () => {
    modelReady = await ollamaHasModel();
    if (!modelReady) throw new Error(`Ollama at ${OLLAMA_BASE_URL} does not serve ${MODEL}; cannot run live tests`);
  }, 30_000);

  afterAll(async () => {
    await sleep(50);
  });

  it(`case 18: direct mode commits "${PROMPT}" with lava, a new bridge to the northern island and preserved players`, async () => {
    await runLiveEdit('direct');
  }, JOB_TIMEOUT_MS + 120_000);

  it.skipIf(!LIVE_OPENCLAW)(`case 17: openclaw mode commits the same edit through the real OpenClaw tools`, async () => {
    await runLiveEdit('openclaw');
  }, JOB_TIMEOUT_MS + 120_000);
});

describe.skipIf(LIVE)('live agent (skipped)', () => {
  it('is skipped without BEETLE_LIVE_MODEL=1', () => {
    expect(LIVE).toBe(false);
  });
});
