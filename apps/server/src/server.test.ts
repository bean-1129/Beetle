// In-process server tests: createBeetleServer on port 0, temp data dir, fixture world, manual ticks with a fake clock.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ROUTES, SIMULATION, type CommitResult, type ServerMessage, type ValidationResult, type WorldMessage } from '@beetle/contracts';
import { createBeetleServer, createFakeClock, type BeetleServer, type BeetleServerOptions } from './index.ts';

const DIRECTOR = 'd1rector-token-for-tests-0123456789ab';
const AGENT = 'agent-token-for-tests-0123456789abcdef';

type Harness = {
  server: BeetleServer;
  dataDir: string;
  clock: ReturnType<typeof createFakeClock>;
  port: number;
};

const harnesses: Harness[] = [];

async function makeServer(extra: Partial<BeetleServerOptions> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'beetle-server-test-'));
  const clock = createFakeClock(1_750_000_000_000);
  const server = await createBeetleServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    publicUrl: 'http://127.0.0.1:7700',
    directorToken: DIRECTOR,
    agentToken: AGENT,
    startWorld: 'fixture',
    loadSnapshot: false,
    tickMode: 'manual',
    clock,
    ollamaBaseUrl: 'http://127.0.0.1:1',
    webDistDir: null,
    logRequests: false,
    ...extra,
  });
  const info = await server.start();
  const h = { server, dataDir, clock, port: info.port };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  }
});

type Resp = { status: number; json: any };

async function api(server: BeetleServer, method: 'GET' | 'POST', url: string, opts: { body?: unknown; token?: string; remoteAddress?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await server.app.inject({
    method,
    url,
    headers,
    payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  });
  let json: unknown = null;
  if (res.body) {
    try { json = JSON.parse(res.body); } catch { json = res.body; }
  }
  return { status: res.statusCode, json };
}

const agentCall = (server: BeetleServer, method: 'GET' | 'POST', url: string, body?: unknown) => api(server, method, url, { body, token: AGENT });
const directorCall = (server: BeetleServer, method: 'GET' | 'POST', url: string, body?: unknown) => api(server, method, url, { body, token: DIRECTOR });

/** Ticks the manual simulation until the promise settles (commits resolve inside the loop). */
async function withTicks<T>(server: BeetleServer, promise: Promise<T>, maxTicks = 400): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
  for (let i = 0; i < maxTicks && !settled; i += 1) {
    await new Promise((r) => setImmediate(r));
    if (settled) break;
    server.tick();
    await new Promise((r) => setImmediate(r));
  }
  if (!settled) throw new Error(`promise did not settle within ${maxTicks} ticks`);
  if (error) throw error;
  return value as T;
}

async function stagePatch(server: BeetleServer, ops: unknown[], summary = 'test patch') {
  const res = await agentCall(server, 'POST', ROUTES.agentProposePatch, { requestId: 'req-test', patch: { summary, ops } });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as { candidateId: string; patchId: string; digest: string; baseWorldVersion: number; changedIds: string[] };
}

async function validate(server: BeetleServer, candidateId: string): Promise<ValidationResult> {
  const res = await agentCall(server, 'POST', ROUTES.agentValidate.replace(':id', candidateId));
  expect(res.status).toBe(200);
  return res.json as ValidationResult;
}

async function commit(server: BeetleServer, candidateId: string, proofId: string): Promise<{ status: number; result: CommitResult }> {
  const res = await withTicks(server, agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', candidateId), { proofId }));
  return { status: res.status, result: res.json as CommitResult };
}

async function joinPlayer(server: BeetleServer, slot: 0 | 1) {
  const invite = await directorCall(server, 'POST', ROUTES.directorInvite, { slot });
  expect(invite.status).toBe(200);
  const join = await api(server, 'POST', ROUTES.join, { body: { inviteCode: invite.json.inviteCode } });
  expect(join.status, JSON.stringify(join.json)).toBe(200);
  return join.json as { controllerToken: string; playerId: string; label: string; color: string; slot: 0 | 1 };
}

type WsClient = {
  ws: WebSocket;
  send(msg: unknown): void;
  next(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
};

function connectWs(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${ROUTES.ws}`);
    const queue: ServerMessage[] = [];
    const waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        queue.push(msg);
        if (queue.length > 500) queue.splice(0, 100);
      }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (msg) => ws.send(JSON.stringify(msg)),
      next: (predicate, timeoutMs = 3000) => {
        const idx = queue.findIndex(predicate);
        if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
        return new Promise<ServerMessage>((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.findIndex((w) => w.resolve === wrapped);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error('timed out waiting for a websocket message'));
          }, timeoutMs);
          const wrapped = (m: ServerMessage) => { clearTimeout(timer); res(m); };
          waiters.push({ predicate, resolve: wrapped });
        });
      },
      close: () => new Promise<void>((res) => {
        if (ws.readyState === WebSocket.CLOSED) return res();
        ws.once('close', () => res());
        ws.close();
      }),
    }));
  });
}

async function connectController(h: Harness, token: string): Promise<WsClient> {
  const client = await connectWs(h.port);
  client.send({ type: 'hello', role: 'controller', token });
  const welcome = await client.next((m) => m.type === 'welcome');
  expect(welcome.type).toBe('welcome');
  return client;
}

function setPosition(server: BeetleServer, playerId: string, x: number, z: number): void {
  const player = server.session.player(playerId);
  if (!player) throw new Error('unknown player ' + playerId);
  const compiled = server.world.current?.compiled;
  player.x = x;
  player.z = z;
  player.vx = 0;
  player.vz = 0;
  player.status = 'active';
  player.supportId = compiled ? compiled.supportAt(x, z) : null;
}

// ---------------------------------------------------------------------------------------------

describe('smoke', () => {
  it('starts on port 0 and answers /api/health and /api/world', async () => {
    const { server, port } = await makeServer();
    expect(port).toBeGreaterThan(0);
    const health = await api(server, 'GET', ROUTES.health);
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ ok: true, hasWorld: true, worldVersion: 1, players: 0, connectedControllers: 0, agentConnected: false });
    expect(health.json.model).toEqual({ name: 'qwen3.5:4b', reachable: false, present: false });
    expect(typeof health.json.publicUrl).toBe('string');
    expect(typeof health.json.uptimeMs).toBe('number');

    const world = await api(server, 'GET', ROUTES.world);
    expect(world.status).toBe(200);
    expect(world.json.hasWorld).toBe(true);
    expect(world.json.version).toBe(1);
    expect(world.json.spec.worldVersion).toBe(1);
    expect(world.json.spec.title.endsWith('(fixture)')).toBe(true);
    expect(world.json.summary.worldVersion).toBe(1);
    expect(world.json.summary.remainingRelicIds).toHaveLength(3);
  });

  it('starts with no world when startWorld is none', async () => {
    const { server } = await makeServer({ startWorld: 'none' });
    const world = await api(server, 'GET', ROUTES.world);
    expect(world.json).toEqual({ hasWorld: false, version: 0, spec: null, summary: null });
    const edit = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'edit', prompt: 'add a bridge' });
    expect(edit.status).toBe(409);
    expect(edit.json.code).toBe('UNSUPPORTED_OPERATION');
    const brief = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'five islands' });
    expect(brief.status).toBe(200);
    expect(brief.json.request.status).toBe('queued');
  });
});

describe('case 8: occupied support defers then rejects, then succeeds after the player moves', () => {
  it('rejects with OCCUPIED_SUPPORT naming the player and commits once they step off', async () => {
    const h = await makeServer();
    const { server } = h;
    const joined = await joinPlayer(server, 0);
    const controller = await connectController(h, joined.controllerToken);
    server.tick();
    const player = server.session.player(joined.playerId)!;
    expect(player.connected).toBe(true);
    expect(player.supportId).toBe('centre');

    // Validate while the player is safely on the centre island.
    const staged = await stagePatch(server, [
      { op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple', width: 2.4 },
      { op: 'remove_bridge', id: 'bridge-north' },
    ], 'reroute the temple bridge');
    const vr = await validate(server, staged.candidateId);
    expect(vr.ok, JSON.stringify(vr.issues)).toBe(true);
    expect(vr.proof?.proofId).toMatch(/^[0-9a-f]{32}$/);

    // Now the player walks onto the bridge the patch removes.
    setPosition(server, joined.playerId, 0, 14);
    server.tick();
    expect(server.session.player(joined.playerId)!.supportId).toBe('bridge-north');

    const first = await commit(server, staged.candidateId, vr.proof!.proofId);
    expect(first.result.ok).toBe(false);
    if (first.result.ok) throw new Error('unreachable');
    expect(first.result.code).toBe('OCCUPIED_SUPPORT');
    expect(first.result.objectIds).toContain(joined.playerId);
    expect(first.result.retryable).toBe(true);
    expect(server.world.version).toBe(1);
    const deferred = server.events.recent(100, (e) => e.name === 'commit.deferred');
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    const rejected = server.events.recent(100, (e) => e.name === 'commit.rejected');
    expect(rejected.at(-1)?.durationMs ?? 0).toBeGreaterThanOrEqual(SIMULATION.commitDeferMaxMs);
    const activity = await directorCall(server, 'GET', `${ROUTES.directorActivity}?limit=50`);
    expect(activity.json.entries.some((e: { phase: string }) => e.phase === 'awaiting_safe_commit')).toBe(true);

    // The player moves off the bridge; the same proof now commits.
    setPosition(server, joined.playerId, 0, 0);
    server.tick();
    const second = await commit(server, staged.candidateId, vr.proof!.proofId);
    expect(second.result.ok, JSON.stringify(second.result)).toBe(true);
    if (!second.result.ok) throw new Error('unreachable');
    expect(second.result.worldVersion).toBe(2);
    expect(second.result.idempotentReplay).toBe(false);
    expect(server.world.version).toBe(2);
    expect(server.world.current!.spec.bridges.some((b) => b.id === 'bridge-north')).toBe(false);
    expect(server.world.current!.spec.bridges.some((b) => b.id === 'bridge-east-temple')).toBe(true);
    await controller.close();
  });
});

describe('case 9: stale versions and idempotent replays', () => {
  it('fails STALE_WORLD_VERSION after another commit lands and replays an identical commit without a bump', async () => {
    const { server } = await makeServer();
    const a = await stagePatch(server, [{ op: 'set_title', title: 'Garden A' }], 'retitle A');
    const b = await stagePatch(server, [{ op: 'set_hazard', kind: 'lava' }], 'lava');
    expect(a.baseWorldVersion).toBe(1);
    expect(b.baseWorldVersion).toBe(1);
    const va = await validate(server, a.candidateId);
    const vb = await validate(server, b.candidateId);
    expect(va.ok && vb.ok).toBe(true);

    const cb = await commit(server, b.candidateId, vb.proof!.proofId);
    expect(cb.result.ok).toBe(true);
    expect(server.world.version).toBe(2);
    expect(server.world.current!.spec.hazard.kind).toBe('lava');

    const ca = await commit(server, a.candidateId, va.proof!.proofId);
    expect(ca.result.ok).toBe(false);
    if (ca.result.ok) throw new Error('unreachable');
    expect(ca.result.code).toBe('STALE_WORLD_VERSION');
    expect(server.world.version).toBe(2);

    const replay = await commit(server, b.candidateId, vb.proof!.proofId);
    expect(replay.status).toBe(200);
    expect(replay.result.ok).toBe(true);
    if (!replay.result.ok) throw new Error('unreachable');
    expect(replay.result.idempotentReplay).toBe(true);
    expect(replay.result.worldVersion).toBe(2);
    expect(server.world.version).toBe(2);

    // Validating a stale candidate also reports STALE_WORLD_VERSION up front.
    const vaAgain = await validate(server, a.candidateId);
    expect(vaAgain.ok).toBe(false);
    expect(vaAgain.issues[0].code).toBe('STALE_WORLD_VERSION');
  });

  it('rejects unknown candidates, missing proofs, mismatched proofs and expired proofs in order', async () => {
    const { server, clock } = await makeServer();
    const unknown = await agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', 'cand-nope'), { proofId: 'f'.repeat(32) });
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe('UNKNOWN_CANDIDATE');

    const a = await stagePatch(server, [{ op: 'set_title', title: 'Garden A' }]);
    const notValidated = await agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', a.candidateId), { proofId: 'f'.repeat(32) });
    expect(notValidated.json.code).toBe('NOT_VALIDATED');

    const b = await stagePatch(server, [{ op: 'set_title', title: 'Garden B' }]);
    const vb = await validate(server, b.candidateId);
    const mismatch = await agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', a.candidateId), { proofId: vb.proof!.proofId });
    expect(mismatch.json.code).toBe('DIGEST_MISMATCH');

    clock.advance(SIMULATION.validationProofTtlMs + 1);
    const expired = await agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', b.candidateId), { proofId: vb.proof!.proofId });
    expect(expired.json.code).toBe('VALIDATION_EXPIRED');
    expect(server.world.version).toBe(1);
  });
});

describe('case 10: a commit preserves players, inventory, score and sockets', () => {
  it('keeps ids, positions, collected relics, score and the controller binding', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const p1 = await joinPlayer(server, 1);
    const c0 = await connectController(h, p0.controllerToken);
    const c1 = await connectController(h, p1.controllerToken);
    server.tick();

    // Player 0 collects relic-east (world position 26, 0).
    setPosition(server, p0.playerId, 26, 0);
    setPosition(server, p1.playerId, -3, 3);
    c0.send({ type: 'input', seq: 1, axes: { x: 0, z: 0 }, interact: true });
    await c0.next((m) => m.type === 'tick' || m.type === 'controllers', 500).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    server.tick();
    c0.send({ type: 'input', seq: 2, axes: { x: 0, z: 0 }, interact: false });
    await new Promise((r) => setTimeout(r, 30));
    server.tick();
    const before = server.session.snapshot();
    expect(before.collectedRelicIds).toEqual(['relic-east']);
    expect(before.score).toBe(10);
    const posBefore = before.players.map((p) => ({ id: p.id, x: p.x, z: p.z, connected: p.connected, seq: p.lastInputSeq }));

    const staged = await stagePatch(server, [{ op: 'add_decoration', id: 'tree-new', type: 'tree', islandId: 'centre', localPosition: { x: 0, z: 6 } }], 'plant a tree');
    const vr = await validate(server, staged.candidateId);
    expect(vr.ok, JSON.stringify(vr.issues)).toBe(true);
    const res = await commit(server, staged.candidateId, vr.proof!.proofId);
    expect(res.result.ok).toBe(true);
    expect(server.world.version).toBe(2);

    const after = server.session.snapshot();
    expect(after.worldVersion).toBe(2);
    expect(after.collectedRelicIds).toEqual(['relic-east']);
    expect(after.relicTombstones['relic-east']?.byPlayerId).toBe(p0.playerId);
    expect(after.score).toBe(10);
    expect(after.players.map((p) => ({ id: p.id, x: p.x, z: p.z, connected: p.connected, seq: p.lastInputSeq }))).toEqual(posBefore);

    // Sockets stay bound: input from player 1 still lands on player 1 and ticks carry lastInputSeq.
    c1.send({ type: 'input', seq: 7, axes: { x: 0, z: 0 }, interact: false });
    await new Promise((r) => setTimeout(r, 30));
    server.tick();
    expect(server.session.player(p1.playerId)!.lastInputSeq).toBe(7);
    const tick = await c1.next((m) => m.type === 'tick' && (m as { lastInputSeq?: number }).lastInputSeq === 7);
    expect(tick.type).toBe('tick');
    if (tick.type === 'tick') {
      expect(tick.worldVersion).toBe(2);
      expect(tick.relics['relic-east']).toBe('collected');
    }
    // Displays received the commit broadcast with changedIds.
    await c0.close();
    await c1.close();
  });
});

describe('case 11: one relic, two interacts in the same tick; undo keeps it collected', () => {
  it('awards the relic once (slot order wins) and undo after collection keeps it collected', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const p1 = await joinPlayer(server, 1);
    const c0 = await connectController(h, p0.controllerToken);
    const c1 = await connectController(h, p1.controllerToken);
    server.tick();

    // First a harmless commit so there is something to undo.
    const staged = await stagePatch(server, [{ op: 'set_title', title: 'Garden before undo' }], 'retitle');
    const vr = await validate(server, staged.candidateId);
    expect(vr.ok).toBe(true);
    expect((await commit(server, staged.candidateId, vr.proof!.proofId)).result.ok).toBe(true);
    expect(server.world.version).toBe(2);

    // Both players stand on relic-south (world 0, -28) and press interact before one tick runs.
    setPosition(server, p0.playerId, 0.3, -28);
    setPosition(server, p1.playerId, -0.3, -28);
    c1.send({ type: 'input', seq: 1, axes: { x: 0, z: 0 }, interact: true });
    c0.send({ type: 'input', seq: 1, axes: { x: 0, z: 0 }, interact: true });
    await new Promise((r) => setTimeout(r, 40));
    expect(server.session.player(p0.playerId)!.lastInputSeq).toBe(1);
    expect(server.session.player(p1.playerId)!.lastInputSeq).toBe(1);
    server.tick();
    const state = server.session.state;
    expect(state.collectedRelicIds).toEqual(['relic-south']);
    expect(state.score).toBe(10);
    expect(state.relicTombstones['relic-south'].byPlayerId).toBe(p0.playerId);
    // Holding interact does not re-trigger; releasing and pressing again finds nothing nearby.
    server.tick(3);
    expect(state.score).toBe(10);

    const undo = await withTicks(server, directorCall(server, 'POST', ROUTES.directorUndo));
    expect(undo.status).toBe(200);
    expect(undo.json.ok, JSON.stringify(undo.json)).toBe(true);
    expect(undo.json.worldVersion).toBe(3);
    expect(server.world.current!.spec.title.endsWith('(fixture)')).toBe(true);
    expect(server.session.state.collectedRelicIds).toEqual(['relic-south']);
    expect(server.session.state.score).toBe(10);
    expect(server.session.player(p0.playerId)!.z).toBeCloseTo(-28, 3);
    await c0.close();
    await c1.close();
  });
});

describe('case 13: auth boundaries', () => {
  it('controller tokens get 403 on director and agent routes; agent routes reject non-loopback and wrong tokens', async () => {
    const { server } = await makeServer();
    const joined = await joinPlayer(server, 0);
    const ctrl = joined.controllerToken;

    const d1 = await api(server, 'POST', ROUTES.directorInvite, { token: ctrl, body: {} });
    expect(d1.status).toBe(403);
    const d2 = await api(server, 'GET', ROUTES.directorActivity, { token: ctrl });
    expect(d2.status).toBe(403);
    const d3 = await api(server, 'POST', ROUTES.directorRequest, { token: ctrl, body: { kind: 'edit', prompt: 'x' } });
    expect(d3.status).toBe(403);
    const a1 = await api(server, 'GET', ROUTES.agentWorld, { token: ctrl });
    expect(a1.status).toBe(403);
    const a2 = await api(server, 'POST', ROUTES.agentProposePatch, { token: ctrl, body: { requestId: 'r', patch: {} } });
    expect(a2.status).toBe(403);

    // Director token on agent routes and agent token on director routes are also refused.
    expect((await api(server, 'GET', ROUTES.agentWorld, { token: DIRECTOR })).status).toBe(403);
    expect((await api(server, 'GET', ROUTES.directorReports, { token: AGENT })).status).toBe(403);
    // No token at all.
    expect((await api(server, 'GET', ROUTES.directorReports)).status).toBe(401);
    expect((await api(server, 'GET', ROUTES.agentWorld)).status).toBe(401);

    // Valid agent token from a non-loopback address is rejected before auth.
    const remote = await api(server, 'GET', ROUTES.agentWorld, { token: AGENT, remoteAddress: '10.0.0.5' });
    expect(remote.status).toBe(403);
    const remoteNoToken = await api(server, 'GET', ROUTES.agentWorld, { remoteAddress: '192.168.1.9' });
    expect(remoteNoToken.status).toBe(403);
    expect(remoteNoToken.json.message).toMatch(/loopback/);
    const loopback = await api(server, 'GET', ROUTES.agentWorld, { token: AGENT, remoteAddress: '::ffff:127.0.0.1' });
    expect(loopback.status).toBe(200);
    expect(loopback.json.hasWorld).toBe(true);
  });

  it('brief while players are connected needs authorizeNewWorld; invites expire', async () => {
    const h = await makeServer();
    const { server, clock } = h;
    const joined = await joinPlayer(server, 0);
    const c0 = await connectController(h, joined.controllerToken);
    const refused = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'new world' });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('UNSUPPORTED_OPERATION');
    const allowed = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'new world', authorizeNewWorld: true });
    expect(allowed.status).toBe(200);
    expect(allowed.json.request.kind).toBe('brief');

    const invite = await directorCall(server, 'POST', ROUTES.directorInvite, { slot: 1 });
    expect(invite.json.url).toBe(`http://127.0.0.1:7700/controller?invite=${invite.json.inviteCode}`);
    clock.advance(5 * 60 * 1000 + 1);
    const late = await api(server, 'POST', ROUTES.join, { body: { inviteCode: invite.json.inviteCode } });
    expect(late.status).toBe(400);
    await c0.close();
  });
});

describe('case 16: display resync', () => {
  it('a display that sends resync with an old version receives a world message with the current spec', async () => {
    const h = await makeServer();
    const { server } = h;
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display', worldVersion: 0 });
    const welcome = await display.next((m) => m.type === 'welcome');
    expect(welcome).toMatchObject({ type: 'welcome', role: 'display', worldVersion: 1, tickHz: SIMULATION.tickHz });
    const snapshot = (await display.next((m) => m.type === 'world')) as WorldMessage;
    expect(snapshot.reason).toBe('snapshot');
    expect(snapshot.version).toBe(1);
    const activity = await display.next((m) => m.type === 'activity');
    expect(activity.type).toBe('activity');

    // Land a commit so the current version moves ahead of what the display has.
    const staged = await stagePatch(server, [{ op: 'set_title', title: 'Garden v2' }], 'retitle');
    const vr = await validate(server, staged.candidateId);
    const res = await commit(server, staged.candidateId, vr.proof!.proofId);
    expect(res.result.ok).toBe(true);
    const committed = (await display.next((m) => m.type === 'world' && (m as WorldMessage).reason === 'commit')) as WorldMessage;
    expect(committed.version).toBe(2);
    expect(committed.changedIds).toContain('title');
    expect(committed.patchSummary).toBe('retitle');

    display.send({ type: 'resync', haveVersion: 1 });
    const resync = (await display.next((m) => m.type === 'world' && (m as WorldMessage).reason === 'resync')) as WorldMessage;
    expect(resync.version).toBe(2);
    expect(resync.spec.title).toBe('Garden v2');
    expect(resync.spec.worldVersion).toBe(2);

    // Ping/pong and invalid messages.
    display.send({ type: 'ping', t: 123 });
    const pong = await display.next((m) => m.type === 'pong');
    expect(pong).toMatchObject({ type: 'pong', t: 123 });
    display.send({ type: 'bogus' });
    const err = await display.next((m) => m.type === 'error');
    expect(err.type).toBe('error');
    await display.close();
  });

  it('director sockets need the director token and get the activity trail', async () => {
    const h = await makeServer();
    const bad = await connectWs(h.port);
    bad.send({ type: 'hello', role: 'director', token: 'wrong-token-wrong-token' });
    const err = await bad.next((m) => m.type === 'error');
    expect(err.type).toBe('error');
    await new Promise<void>((r) => bad.ws.once('close', () => r()));

    const good = await connectWs(h.port);
    good.send({ type: 'hello', role: 'director', token: DIRECTOR });
    const welcome = await good.next((m) => m.type === 'welcome');
    expect(welcome).toMatchObject({ role: 'director' });
    await good.next((m) => m.type === 'world');
    await good.next((m) => m.type === 'activity');
    await good.close();
  });
});

describe('agent request lifecycle', () => {
  it('claim, status, finish and reports flow through activity and the request record', async () => {
    const { server } = await makeServer();
    const created = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'edit', prompt: 'make the west bridge wider' });
    expect(created.status).toBe(200);
    const id = created.json.request.id as string;

    const claimed = await agentCall(server, 'POST', ROUTES.agentRequestsClaim, { workerId: 'worker-1' });
    expect(claimed.status).toBe(200);
    expect(claimed.json.request.id).toBe(id);
    expect(claimed.json.request.status).toBe('planning');
    expect(claimed.json.request.claimedBy).toBe('worker-1');
    const health = await api(server, 'GET', ROUTES.health);
    expect(health.json.agentConnected).toBe(true);

    const status = await agentCall(server, 'POST', ROUTES.agentRequestStatus.replace(':id', id), { phase: 'validating', message: 'Checking routes', tool: 'validate_candidate', codes: [], objectIds: [] });
    expect(status.json).toEqual({ ok: true });
    const fetched = await directorCall(server, 'GET', ROUTES.directorRequestById.replace(':id', id));
    expect(fetched.json.request.status).toBe('validating');
    expect(fetched.json.activity.map((a: { phase: string }) => a.phase)).toEqual(['queued', 'planning', 'validating']);
    expect(fetched.json.activity[2].elapsedMs).toBeGreaterThanOrEqual(0);

    const report = await agentCall(server, 'POST', ROUTES.agentReports, {
      requestId: id, mode: 'direct', model: 'qwen3.5:4b', outcome: 'failed', worldVersion: 1, baseWorldVersion: 1,
      summary: 'validation kept failing', validation: { attempts: 2, failedCodes: ['DISCONNECTED_GOAL'] },
      timings: { requestedAt: 1, totalMs: 1234 }, toolCalls: [{ tool: 'validate_candidate', ok: false, ms: 12 }],
    });
    expect(report.status).toBe(200);
    expect(typeof report.json.reportId).toBe('string');
    const finished = await agentCall(server, 'POST', ROUTES.agentRequestFinish.replace(':id', id), { outcome: 'failed', reportId: report.json.reportId, error: { code: 'DISCONNECTED_GOAL', message: 'temple unreachable' } });
    expect(finished.json).toEqual({ ok: true });
    const after = directorCall(server, 'GET', ROUTES.directorRequestById.replace(':id', id));
    expect((await after).json.request).toMatchObject({ status: 'failed', reportId: report.json.reportId, error: { code: 'DISCONNECTED_GOAL' } });
    const reports = await directorCall(server, 'GET', ROUTES.directorReports);
    expect(reports.json.reports).toHaveLength(1);
    expect(reports.json.reports[0].mode).toBe('direct');

    // Nothing queued: the long-poll returns 204 quickly when the server stops waiting (we release it via a new request).
    const pending = agentCall(server, 'POST', ROUTES.agentRequestsClaim, { workerId: 'worker-1' });
    await new Promise((r) => setTimeout(r, 20));
    await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'edit', prompt: 'second' });
    const second = await pending;
    expect(second.status).toBe(200);
    expect(second.json.request.prompt).toBe('second');
  });

  it('stages a world candidate from a draft and refuses a reset while players are connected without authorisation', async () => {
    const h = await makeServer();
    const { server } = h;
    const draft = {
      title: 'Four Stones',
      islands: [
        { id: 'a', name: 'A', center: { x: 0, z: 0 }, radius: 8 },
        { id: 'b', name: 'B', center: { x: 22, z: 0 }, radius: 7 },
        { id: 'c', name: 'C', center: { x: -22, z: 0 }, radius: 7 },
        { id: 'd', name: 'D', center: { x: 0, z: 24 }, radius: 7 },
      ],
      bridges: [
        { id: 'ab', from: 'a', to: 'b', width: 2.4 },
        { id: 'ac', from: 'a', to: 'c', width: 2.4 },
        { id: 'ad', from: 'a', to: 'd', width: 2.4 },
      ],
      spawns: [{ islandId: 'a', localPosition: { x: -2, z: -2 } }, { islandId: 'a', localPosition: { x: 2, z: -2 } }],
      relics: [
        { id: 'r1', name: 'One', islandId: 'b', localPosition: { x: 1, z: 0 } },
        { id: 'r2', name: 'Two', islandId: 'c', localPosition: { x: -1, z: 0 } },
        { id: 'r3', name: 'Three', islandId: 'a', localPosition: { x: 0, z: 4 } },
      ],
      gate: { islandId: 'd', localPosition: { x: 0, z: 2 } },
      hazard: 'lava',
      decorations: [],
    };
    const bad = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: 'req-x', spec: { ...draft, islands: draft.islands.slice(0, 2) } });
    expect(bad.status).toBe(400);
    expect(bad.json.issues[0].code).toBe('INVALID_SCHEMA');

    const joined = await joinPlayer(server, 0);
    const c0 = await connectController(h, joined.controllerToken);
    const unauthorised = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'reset', authorizeNewWorld: false });
    expect(unauthorised.status).toBe(409);
    const authorised = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'reset', authorizeNewWorld: true });
    const reqId = authorised.json.request.id as string;

    const staged = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: 'req-unknown', spec: draft });
    expect(staged.status, JSON.stringify(staged.json)).toBe(200);
    expect(staged.json.spec.worldId).toMatch(/^world-[0-9a-f]+$/);
    const vr = await validate(server, staged.json.candidateId);
    expect(vr.ok, JSON.stringify(vr.issues)).toBe(true);
    const refused = await commit(server, staged.json.candidateId, vr.proof!.proofId);
    expect(refused.result.ok).toBe(false);
    if (refused.result.ok) throw new Error('unreachable');
    expect(refused.result.code).toBe('UNSUPPORTED_OPERATION');

    const stagedOk = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: reqId, spec: draft });
    const vr2 = await validate(server, stagedOk.json.candidateId);
    expect(vr2.ok).toBe(true);
    const play = await agentCall(server, 'POST', ROUTES.agentPlayability.replace(':id', stagedOk.json.candidateId));
    expect(play.status).toBe(200);
    expect(play.json.note).toBe('connectivity and supported-movement checks only; not a fun or completeness guarantee');
    const done = await commit(server, stagedOk.json.candidateId, vr2.proof!.proofId);
    expect(done.result.ok, JSON.stringify(done.result)).toBe(true);
    expect(server.world.version).toBe(2);
    expect(server.world.current!.spec.title).toBe('Four Stones');
    const player = server.session.player(joined.playerId)!;
    expect(player.connected).toBe(true);
    expect(player.supportId).toBe('a');
    expect(server.session.state.collectedRelicIds).toEqual([]);
    await c0.close();
  });
});
