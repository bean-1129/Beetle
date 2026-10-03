// Protocol, persistence and static-serving tests for the in-process server.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES, ROUTES, SIMULATION, type ServerMessage, type WorldSpec } from '@beetle/contracts';
import { createBeetleServer, createFakeClock, systemClock, type BeetleServer, type BeetleServerOptions } from './index.ts';

const DIRECTOR = 'd1rector-token-for-tests-0123456789ab';
const AGENT = 'agent-token-for-tests-0123456789abcdef';

type Harness = { server: BeetleServer; dataDir: string; clock: ReturnType<typeof createFakeClock>; port: number };
const harnesses: Harness[] = [];
const tempDirs: string[] = [];

async function makeServer(extra: Partial<BeetleServerOptions> = {}, dataDir?: string): Promise<Harness> {
  const dir = dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'beetle-protocol-test-'));
  const clock = createFakeClock(1_750_000_000_000);
  const server = await createBeetleServer({
    host: '127.0.0.1', port: 0, dataDir: dir, publicUrl: 'http://127.0.0.1:7700',
    directorToken: DIRECTOR, agentToken: AGENT, startWorld: 'fixture', loadSnapshot: false,
    tickMode: 'manual', clock, ollamaBaseUrl: 'http://127.0.0.1:1', webDistDir: null, logRequests: false,
    ...extra,
  });
  const info = await server.start();
  const h = { server, dataDir: dir, clock, port: info.port };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function inject(server: BeetleServer, method: 'GET' | 'POST', url: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await server.app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body), remoteAddress: '127.0.0.1' });
  let json: any = null;
  try { json = JSON.parse(res.body); } catch { json = res.body; }
  return { status: res.statusCode, json, body: res.body };
}

async function joinPlayer(server: BeetleServer, slot: 0 | 1) {
  const invite = await inject(server, 'POST', ROUTES.directorInvite, { slot }, DIRECTOR);
  const join = await inject(server, 'POST', ROUTES.join, { inviteCode: invite.json.inviteCode });
  expect(join.status).toBe(200);
  return join.json as { controllerToken: string; playerId: string };
}

type WsClient = { ws: WebSocket; send(m: unknown): void; next(p: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>; closed: Promise<number>; close(): Promise<void> };

function connectWs(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${ROUTES.ws}`);
    const queue: ServerMessage[] = [];
    const waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
      next: (predicate, timeoutMs = 3000) => {
        const idx = queue.findIndex(predicate);
        if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
        return new Promise<ServerMessage>((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for a websocket message')), timeoutMs);
          waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      closed,
      close: () => new Promise<void>((res) => {
        if (ws.readyState === WebSocket.CLOSED) return res();
        ws.once('close', () => res());
        ws.close();
      }),
    }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('controller sockets', () => {
  it('reconnect restores the same player; a newer socket replaces the older one', async () => {
    const h = await makeServer();
    const { server } = h;
    const joined = await joinPlayer(server, 0);

    const first = await connectWs(h.port);
    first.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    const w1 = await first.next((m) => m.type === 'welcome');
    expect(w1).toMatchObject({ role: 'controller', playerId: joined.playerId, playerLabel: 'Amber' });
    server.tick();
    const player = server.session.player(joined.playerId)!;
    expect(player.connected).toBe(true);
    player.x = 3;
    player.z = -4;
    await first.close();
    await sleep(20);
    expect(player.connected).toBe(false);
    expect(player.status).toBe('disconnected');

    const second = await connectWs(h.port);
    second.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    const w2 = await second.next((m) => m.type === 'welcome');
    expect(w2).toMatchObject({ playerId: joined.playerId });
    expect(player.connected).toBe(true);
    expect(player.status).toBe('active');
    expect(player.x).toBe(3);
    expect(player.z).toBe(-4);

    const third = await connectWs(h.port);
    third.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    await third.next((m) => m.type === 'welcome');
    const code = await second.closed;
    expect(code).toBe(4002);
    await sleep(20);
    expect(player.connected).toBe(true);
    await third.close();
    await sleep(20);
    expect(player.connected).toBe(false);
  });

  it('drops inputs over the per-second limit, ignores old seq, and closes oversized frames with 1009', async () => {
    const h = await makeServer();
    const { server } = h;
    const joined = await joinPlayer(server, 0);
    const c = await connectWs(h.port);
    c.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    await c.next((m) => m.type === 'welcome');
    for (let seq = 1; seq <= SIMULATION.inputRateLimitPerSec + 10; seq += 1) {
      c.send({ type: 'input', seq, axes: { x: 0.5, z: 0 }, interact: false });
    }
    await sleep(80);
    const player = server.session.player(joined.playerId)!;
    expect(player.lastInputSeq).toBe(SIMULATION.inputRateLimitPerSec);
    c.send({ type: 'input', seq: 5, axes: { x: 0, z: 0 }, interact: false });
    await sleep(20);
    expect(player.lastInputSeq).toBe(SIMULATION.inputRateLimitPerSec);
    expect(server.session.runtimeOf(player, 0).axes.x).toBe(0.5);

    // A moving player: axes applied at the next tick move them east on the centre island.
    const before = player.x;
    server.tick(5);
    expect(player.x).toBeGreaterThan(before);
    expect(player.supportId).toBe('centre');

    const unknownToken = await connectWs(h.port);
    unknownToken.send({ type: 'hello', role: 'controller', token: 'not-a-real-token-at-all' });
    expect(await unknownToken.closed).toBe(4001);

    const noHello = await connectWs(h.port);
    noHello.send({ type: 'ping', t: 1 });
    const err = await noHello.next((m) => m.type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'HELLO_REQUIRED' });
    await noHello.close();

    c.send('{"type":"input","pad":"' + 'x'.repeat(MAX_MESSAGE_BYTES) + '"}');
    expect(await c.closed).toBe(1009);
  });

  it('origin header must match host or the public URL', async () => {
    const h = await makeServer();
    const bad = new WebSocket(`ws://127.0.0.1:${h.port}${ROUTES.ws}`, { headers: { origin: 'http://evil.example' } });
    const badResult = await new Promise<string>((res) => {
      bad.once('error', () => res('error'));
      bad.once('open', () => res('open'));
    });
    expect(badResult).toBe('error');
    const good = new WebSocket(`ws://127.0.0.1:${h.port}${ROUTES.ws}`, { headers: { origin: 'http://127.0.0.1:7700' } });
    const goodResult = await new Promise<string>((res) => {
      good.once('error', () => res('error'));
      good.once('open', () => res('open'));
    });
    expect(goodResult).toBe('open');
    good.close();
  });
});

describe('join rate limit', () => {
  it('allows 10 join attempts per minute per IP and then answers 429', async () => {
    const { server } = await makeServer();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await inject(server, 'POST', ROUTES.join, { inviteCode: 'nope-' + i })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    const other = await server.app.inject({ method: 'POST', url: ROUTES.join, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ inviteCode: 'nope-x' }), remoteAddress: '192.168.0.42' });
    expect(other.statusCode).toBe(400);
  });
});

describe('persistence', () => {
  it('writes snapshots, session and events; a restart restores world-current.json with its version', async () => {
    const h = await makeServer();
    const { server, dataDir } = h;
    const staged = await inject(server, 'POST', ROUTES.agentProposePatch, { requestId: 'req-p', patch: { summary: 'lava', ops: [{ op: 'set_hazard', kind: 'lava' }] } }, AGENT);
    expect(staged.status).toBe(200);
    const vr = await inject(server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId), undefined, AGENT);
    expect(vr.json.ok).toBe(true);
    const commitPromise = inject(server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: vr.json.proof.proofId }, AGENT);
    for (let i = 0; i < 5; i += 1) { await sleep(1); server.tick(); }
    const res = await commitPromise;
    expect(res.json.ok).toBe(true);
    expect(res.json.worldVersion).toBe(2);
    await server.stop();
    await server.events.flush();

    expect(existsSync(path.join(dataDir, 'snapshots', 'world-v2.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'snapshots', 'world-current.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'snapshots', 'session.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'secrets.json'))).toBe(false); // tokens came from options, nothing to persist
    const current = JSON.parse(readFileSync(path.join(dataDir, 'snapshots', 'world-current.json'), 'utf8')) as { version: number; spec: WorldSpec };
    expect(current.version).toBe(2);
    expect(current.spec.hazard.kind).toBe('lava');
    expect(current.spec.hazard.policy.scorePenalty).toBe(1);
    const events = readFileSync(path.join(dataDir, 'events', 'server.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name: string; source: string });
    expect(events.every((e) => e.source === 'server')).toBe(true);
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(['candidate.staged', 'validate.result', 'commit.ok', 'server.started', 'server.stopped']));

    const restarted = await makeServer({ startWorld: 'none', loadSnapshot: true }, dataDir);
    expect(restarted.server.world.version).toBe(2);
    expect(restarted.server.world.current!.spec.hazard.kind).toBe('lava');
    const health = await inject(restarted.server, 'GET', ROUTES.health);
    expect(health.json.worldVersion).toBe(2);
    // The first harness was already stopped; drop it from cleanup to avoid a double stop on the same dir.
    harnesses.splice(harnesses.indexOf(h), 1);
  });

  it('creates data/secrets.json with mode 0600 when no tokens are provided', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beetle-secrets-test-'));
    tempDirs.push(dir);
    const server = await createBeetleServer({
      host: '127.0.0.1', port: 0, dataDir: dir, startWorld: 'none', loadSnapshot: false, tickMode: 'manual', clock: createFakeClock(),
      ollamaBaseUrl: 'http://127.0.0.1:1', webDistDir: null, logRequests: false, env: {},
    });
    expect(server.secrets.filePath).toBe(path.join(dir, 'secrets.json'));
    const file = JSON.parse(readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as { directorToken: string; agentToken: string };
    expect(file.directorToken).toMatch(/^[0-9a-f]{32}$/);
    expect(file.agentToken).toMatch(/^[0-9a-f]{32}$/);
    expect(server.tokens).toEqual({ director: file.directorToken, agent: file.agentToken });
    const again = await createBeetleServer({
      host: '127.0.0.1', port: 0, dataDir: dir, startWorld: 'none', loadSnapshot: false, tickMode: 'manual', clock: createFakeClock(),
      ollamaBaseUrl: 'http://127.0.0.1:1', webDistDir: null, logRequests: false, env: {},
    });
    expect(again.tokens).toEqual(server.tokens);
    await server.stop();
    await again.stop();
  });
});

describe('static web client and interval mode', () => {
  it('serves apps/web/dist pages and maps /director, /play, /controller when the directory exists', async () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), 'beetle-dist-test-'));
    tempDirs.push(dist);
    mkdirSync(path.join(dist, 'assets'));
    for (const page of ['index', 'director', 'play', 'controller']) writeFileSync(path.join(dist, `${page}.html`), `<!doctype html><title>${page}</title>`);
    writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("ok")');
    const { server } = await makeServer({ webDistDir: dist });
    for (const page of ['director', 'play', 'controller']) {
      const res = await inject(server, 'GET', `/${page}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`<title>${page}</title>`);
    }
    const root = await inject(server, 'GET', '/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('<title>index</title>');
    const asset = await inject(server, 'GET', '/assets/app.js');
    expect(asset.status).toBe(200);
    const missing = await inject(server, 'GET', '/nope.txt');
    expect(missing.status).toBe(404);
    const api = await inject(server, 'GET', ROUTES.health);
    expect(api.status).toBe(200);
  });

  it('interval mode ticks on its own at roughly 30 Hz and broadcasts ticks', async () => {
    const h = await makeServer({ tickMode: 'interval', clock: systemClock });
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    await display.next((m) => m.type === 'welcome');
    const t0 = h.server.session.state.tick;
    await sleep(350);
    const ticks = h.server.session.state.tick - t0;
    expect(ticks).toBeGreaterThanOrEqual(6);
    expect(ticks).toBeLessThanOrEqual(14);
    const tick = await display.next((m) => m.type === 'tick');
    expect(tick).toMatchObject({ type: 'tick', worldVersion: 1 });
    await display.close();
  });
});
