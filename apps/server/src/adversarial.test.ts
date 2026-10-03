// Adversarial review tests: hostile sockets, racing transactions, simulation edge cases, persistence corruption, loop timing.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GEOMETRY, ROUTES, SCORING, SIMULATION, type CommitResult, type ServerMessage, type TickMessage, type ValidationResult, type WorldSpec } from '@beetle/contracts';
import { expandDraft } from '@beetle/world';
import { createBeetleServer, createFakeClock, systemClock, type BeetleServer, type BeetleServerOptions } from './index.ts';

const DIRECTOR = 'd1rector-token-for-adversarial-0123456789';
const AGENT = 'agent-token-for-adversarial-0123456789abcd';

type Harness = { server: BeetleServer; dataDir: string; clock: ReturnType<typeof createFakeClock>; port: number };
const harnesses: Harness[] = [];
const extraDirs: string[] = [];

async function makeServer(extra: Partial<BeetleServerOptions> = {}): Promise<Harness> {
  const dataDir = extra.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'beetle-adversarial-'));
  const clock = createFakeClock(1_760_000_000_000);
  const server = await createBeetleServer({
    host: '127.0.0.1', port: 0, dataDir, publicUrl: 'http://127.0.0.1:7795',
    directorToken: DIRECTOR, agentToken: AGENT, startWorld: 'fixture', loadSnapshot: false,
    tickMode: 'manual', clock, ollamaBaseUrl: 'http://127.0.0.1:1', webDistDir: null, logRequests: false,
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
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Resp = { status: number; json: any };

async function api(server: BeetleServer, method: 'GET' | 'POST', url: string, opts: { body?: unknown; token?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await server.app.inject({ method, url, headers, payload: opts.body === undefined ? undefined : JSON.stringify(opts.body), remoteAddress: '127.0.0.1' });
  let json: unknown = null;
  if (res.body) { try { json = JSON.parse(res.body); } catch { json = res.body; } }
  return { status: res.statusCode, json };
}
const agentCall = (s: BeetleServer, m: 'GET' | 'POST', url: string, body?: unknown) => api(s, m, url, { body, token: AGENT });
const directorCall = (s: BeetleServer, m: 'GET' | 'POST', url: string, body?: unknown) => api(s, m, url, { body, token: DIRECTOR });

async function withTicks<T>(server: BeetleServer, promise: Promise<T>, maxTicks = 400): Promise<T> {
  let settled = false; let value: T | undefined; let error: unknown;
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

async function stagePatch(server: BeetleServer, ops: unknown[], summary = 'adversarial patch') {
  const res = await agentCall(server, 'POST', ROUTES.agentProposePatch, { requestId: 'req-adv', patch: { summary, ops } });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as { candidateId: string; patchId: string; digest: string; baseWorldVersion: number; changedIds: string[] };
}
async function validate(server: BeetleServer, candidateId: string): Promise<ValidationResult> {
  const res = await agentCall(server, 'POST', ROUTES.agentValidate.replace(':id', candidateId));
  expect(res.status).toBe(200);
  return res.json as ValidationResult;
}
const commitCall = (server: BeetleServer, candidateId: string, proofId: string) => agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', candidateId), { proofId });
async function commit(server: BeetleServer, candidateId: string, proofId: string): Promise<{ status: number; result: CommitResult }> {
  const res = await withTicks(server, commitCall(server, candidateId, proofId));
  return { status: res.status, result: res.json as CommitResult };
}
async function stageValidate(server: BeetleServer, ops: unknown[], summary?: string) {
  const staged = await stagePatch(server, ops, summary);
  const vr = await validate(server, staged.candidateId);
  expect(vr.ok, JSON.stringify(vr.issues)).toBe(true);
  return { staged, proofId: vr.proof!.proofId };
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
  sendRaw(data: string | Buffer, binary?: boolean): void;
  next(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  received(): ServerMessage[];
  closed: Promise<number>;
  close(): Promise<void>;
};
function connectWs(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${ROUTES.ws}`);
    const queue: ServerMessage[] = [];
    const all: ServerMessage[] = [];
    const waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)));
    ws.on('message', (data) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(data.toString()) as ServerMessage; } catch { return; }
      all.push(msg);
      if (all.length > 2000) all.splice(0, 500);
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else { queue.push(msg); if (queue.length > 500) queue.splice(0, 100); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (msg) => ws.send(JSON.stringify(msg)),
      sendRaw: (data, binary = false) => ws.send(data, { binary }),
      received: () => all,
      closed,
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
  const player = server.session.player(playerId)!;
  const compiled = server.world.current?.compiled;
  player.x = x; player.z = z; player.vx = 0; player.vz = 0; player.status = 'active';
  player.supportId = compiled ? compiled.supportAt(x, z) : null;
}
function relicPos(server: BeetleServer, id: string) {
  const w = server.world.current!;
  const r = w.spec.relics.find((x) => x.id === id)!;
  return w.compiled.worldPos(r.supportingSurfaceId, r.localPosition)!;
}
function gatePos(server: BeetleServer) {
  const w = server.world.current!;
  return w.compiled.worldPos(w.spec.gate.supportingSurfaceId, w.spec.gate.localPosition)!;
}
/** Sends one input and waits until the server applied it. */
async function input(server: BeetleServer, c: WsClient, playerId: string, seq: number, axes: { x: number; z: number }, interact: boolean) {
  c.send({ type: 'input', seq, axes, interact });
  for (let i = 0; i < 200; i += 1) {
    if (server.session.player(playerId)!.lastInputSeq >= seq) return;
    await sleep(2);
  }
  throw new Error(`input seq ${seq} was not applied`);
}

/** 8 islands, 16 bridges (7 spokes, 7 ring edges, 2 chords), 3 relics, gate: the largest world the limits allow. */
function sixteenBridgeWorld(): WorldSpec {
  const ring = 7;
  const islands = [{ id: 'hub', name: 'Hub', center: { x: 0, z: 0 }, radius: 9 }];
  for (let i = 0; i < ring; i += 1) {
    const a = (i / ring) * Math.PI * 2;
    islands.push({ id: `ring-${i}`, name: `Ring ${i}`, center: { x: Math.round(Math.cos(a) * 30 * 100) / 100, z: Math.round(Math.sin(a) * 30 * 100) / 100 }, radius: 6 });
  }
  const bridges: { id: string; from: string; to: string; width: number }[] = [];
  for (let i = 0; i < ring; i += 1) bridges.push({ id: `spoke-${i}`, from: 'hub', to: `ring-${i}`, width: 2.4 });
  for (let i = 0; i < ring; i += 1) bridges.push({ id: `edge-${i}`, from: `ring-${i}`, to: `ring-${(i + 1) % ring}`, width: 2.4 });
  bridges.push({ id: 'chord-0', from: 'ring-0', to: 'ring-2', width: 2.4 });
  bridges.push({ id: 'chord-1', from: 'ring-3', to: 'ring-5', width: 2.4 });
  expect(bridges.length).toBe(16);
  const draft = {
    title: 'Sixteen bridges', islands, bridges,
    spawns: [{ islandId: 'hub', localPosition: { x: -2, z: -2 } }, { islandId: 'hub', localPosition: { x: 2, z: -2 } }],
    relics: [
      { id: 'relic-a', name: 'A', islandId: 'ring-1', localPosition: { x: 0, z: 0 } },
      { id: 'relic-b', name: 'B', islandId: 'ring-3', localPosition: { x: 0, z: 0 } },
      { id: 'relic-c', name: 'C', islandId: 'ring-5', localPosition: { x: 0, z: 0 } },
    ],
    gate: { islandId: 'ring-6', localPosition: { x: 0, z: 0 } },
    hazard: 'water', decorations: [],
  };
  const expanded = expandDraft(draft, { seed: 7, worldId: 'sixteen', worldVersion: 1 });
  if (!expanded.ok) throw new Error('draft did not expand: ' + JSON.stringify(expanded.issues));
  return expanded.spec;
}

// ---------------------------------------------------------------------------------------------

describe('hostile websocket clients never stall the loop', () => {
  it('garbage, binary, oversized, flooding, backwards seq, invalid axes, double hello, revoked token, silent display, mid-tick drop', async () => {
    const h = await makeServer({ tickMode: 'interval', clock: systemClock });
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const p1 = await joinPlayer(server, 1);
    const good = await connectController(h, p0.controllerToken);
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    await display.next((m) => m.type === 'welcome');
    await display.next((m) => m.type === 'world'); // never acked on purpose
    const tickAtStart = server.session.state.tick;

    // 1. Garbage and binary frames: one error reply each, socket stays open.
    const chaos = await connectWs(h.port);
    chaos.sendRaw('this is not json {{{');
    const e1 = await chaos.next((m) => m.type === 'error');
    expect(e1).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
    chaos.sendRaw(Buffer.from([0, 1, 2, 3, 255]), true);
    const e2 = await chaos.next((m) => m.type === 'error');
    expect(e2).toMatchObject({ code: 'INVALID_MESSAGE' });
    chaos.send({ type: 'input', seq: 1, axes: { x: 0, z: 0 }, interact: false });
    expect(((await chaos.next((m) => m.type === 'error')) as { code: string }).code).toBe('HELLO_REQUIRED');
    // 2. A 5 KB JSON message closes the socket with 1009.
    chaos.send({ type: 'hello', role: 'display', worldVersion: 0, pad: 'x'.repeat(5000) });
    expect(await chaos.closed).toBe(1009);

    // 3. A controller that floods, rewinds seq, sends NaN / out-of-range axes and says hello twice.
    const flood = await connectController(h, p1.controllerToken);
    for (let i = 1; i <= 200; i += 1) flood.send({ type: 'input', seq: i, axes: { x: 1, z: 0 }, interact: false });
    await sleep(80);
    const player1 = server.session.player(p1.playerId)!;
    const rt1 = server.session.runtime.get(p1.playerId)!;
    expect(rt1.droppedInputs).toBeGreaterThan(0);
    expect(player1.lastInputSeq).toBeLessThanOrEqual(2 * SIMULATION.inputRateLimitPerSec);
    expect(player1.lastInputSeq).toBeGreaterThan(0);
    const seqBefore = player1.lastInputSeq;
    await sleep(1000);
    flood.send({ type: 'input', seq: 3, axes: { x: -1, z: 0 }, interact: true }); // backwards
    flood.send({ type: 'input', seq: 0, axes: { x: -1, z: 0 }, interact: true });
    flood.send({ type: 'input', seq: seqBefore + 500, axes: { x: NaN, z: 0 }, interact: false }); // serialises as null
    flood.send({ type: 'input', seq: seqBefore + 501, axes: { x: 2, z: 0 }, interact: false });
    flood.send({ type: 'input', seq: seqBefore + 502, axes: { x: 0.5, z: -0.5 }, interact: false, extra: 1 });
    flood.send({ type: 'input', seq: 1.5, axes: { x: 0, z: 0 }, interact: false });
    flood.send({ type: 'input', seq: -1, axes: { x: 0, z: 0 }, interact: false });
    flood.send({ type: 'hello', role: 'controller', token: p1.controllerToken });
    await sleep(60);
    const errors = flood.received().filter((m) => m.type === 'error') as { code: string }[];
    expect(errors.filter((e) => e.code === 'INVALID_MESSAGE').length).toBe(5);
    expect(errors.some((e) => e.code === 'ALREADY_HELLO')).toBe(true);
    expect(player1.lastInputSeq).toBe(seqBefore);
    expect(rt1.interact).toBe(false);
    expect(rt1.axes.x).toBe(1);
    expect(flood.ws.readyState).toBe(WebSocket.OPEN);

    // 4. Re-inviting the slot revokes the old token: the old socket is dropped and a hello with the old token is refused.
    const p1b = await joinPlayer(server, 1);
    expect(await flood.closed).toBe(4002);
    const reused = await connectWs(h.port);
    reused.send({ type: 'hello', role: 'controller', token: p1.controllerToken });
    expect(((await reused.next((m) => m.type === 'error')) as { code: string }).code).toBe('AUTH');
    expect(await reused.closed).toBe(4001);
    const fresh = await connectController(h, p1b.controllerToken);
    expect(player1.lastInputSeq).toBe(0); // a new socket is a new seq stream
    fresh.send({ type: 'input', seq: 1, axes: { x: 0, z: 1 }, interact: false });
    await sleep(40);
    expect(player1.lastInputSeq).toBe(1);

    // 5. A commit with a display that never acks still lands and the loop keeps going.
    const { staged, proofId } = await stageValidate(server, [{ op: 'set_title', title: 'Chaos survived' }]);
    const res = await commitCall(server, staged.candidateId, proofId);
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    expect(res.json.worldVersion).toBe(2);
    const worldMsg = await display.next((m) => m.type === 'world' && (m as any).reason === 'commit');
    expect((worldMsg as any).version).toBe(2);
    await sleep(SIMULATION.displayAckTimeoutMs + 200);
    const presented = server.events.recent(200, (e) => e.name === 'commit.presented');
    expect(presented.length).toBe(1);
    expect(presented[0].outcome).toBe('fail');
    expect((presented[0] as { data?: { reason?: string } }).data?.reason).toBe('display_ack_timeout');
    expect(presented[0].worldVersion).toBe(2);

    // 6. A socket that dies mid-stream (no close frame) and a good client that keeps receiving ticks.
    fresh.ws.terminate();
    await sleep(80);
    const t1 = (await good.next((m) => m.type === 'tick' && (m as TickMessage).worldVersion === 2)) as TickMessage;
    await sleep(120);
    const t2 = (await good.next((m) => m.type === 'tick' && (m as TickMessage).tick > t1.tick + 2)) as TickMessage;
    expect(t2.tick).toBeGreaterThan(t1.tick);
    expect(t2.worldVersion).toBe(2);
    expect(typeof (t2 as TickMessage).lastInputSeq).toBe('number');
    expect(server.session.state.tick - tickAtStart).toBeGreaterThan(20);
    expect(server.session.player(p0.playerId)!.connected).toBe(true);
    expect(server.events.recent(500, (e) => e.name === 'ws.error' || e.name === 'sim.error').length).toBe(0);
    const health = await api(server, 'GET', ROUTES.health);
    expect(health.json.ok).toBe(true);
    expect(health.json.worldVersion).toBe(2);
    await good.close();
    await display.close();
  }, 20000);
});

describe('transactions under pressure', () => {
  it('two proofs for one candidate: the second commit is an idempotent replay, not a second bump', async () => {
    const { server } = await makeServer();
    const staged = await stagePatch(server, [{ op: 'set_title', title: 'Twice validated' }]);
    const va = await validate(server, staged.candidateId);
    const vb = await validate(server, staged.candidateId);
    expect(va.ok && vb.ok).toBe(true);
    expect(va.proof!.proofId).not.toBe(vb.proof!.proofId);
    const first = await commit(server, staged.candidateId, va.proof!.proofId);
    expect(first.result).toMatchObject({ ok: true, worldVersion: 2, idempotentReplay: false });
    const second = await commit(server, staged.candidateId, vb.proof!.proofId);
    expect(second.status).toBe(200);
    expect(second.result).toMatchObject({ ok: true, worldVersion: 2, idempotentReplay: true });
    expect(server.world.version).toBe(2);
  });

  it('a world candidate is refused while a controller is connected and the request did not authorise a reset', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const req = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'edit', prompt: 'please tweak' });
    expect(req.status).toBe(200);
    const spec = { ...server.world.current!.spec, title: 'Sneaky reset' };
    const staged = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: req.json.request.id, spec });
    expect(staged.status).toBe(200);
    const vr = await validate(server, staged.json.candidateId);
    expect(vr.ok).toBe(true);
    const res = await commit(server, staged.json.candidateId, vr.proof!.proofId);
    expect(res.result.ok).toBe(false);
    if (res.result.ok) throw new Error('unreachable');
    expect(res.result.code).toBe('UNSUPPORTED_OPERATION');
    expect(server.world.version).toBe(1);
    expect(server.session.state.collectedRelicIds).toEqual([]);
    await c0.close();
  });

  it('undo twice in a row keeps bumping the version and never un-collects a relic', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const east = relicPos(server, 'relic-east');
    setPosition(server, p0.playerId, east.x, east.z);
    await input(server, c0, p0.playerId, 1, { x: 0, z: 0 }, true);
    server.tick();
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east']);

    const a = await stageValidate(server, [{ op: 'set_title', title: 'Step one' }]);
    expect((await commit(server, a.staged.candidateId, a.proofId)).result.ok).toBe(true);
    const b = await stageValidate(server, [{ op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple', width: 2.4 }]);
    expect((await commit(server, b.staged.candidateId, b.proofId)).result.ok).toBe(true);
    expect(server.world.version).toBe(3);

    setPosition(server, p0.playerId, 0, 0);
    server.tick();
    const u1 = await withTicks(server, directorCall(server, 'POST', ROUTES.directorUndo));
    expect(u1.json.ok, JSON.stringify(u1.json)).toBe(true);
    expect(u1.json.worldVersion).toBe(4);
    expect(server.world.current!.spec.bridges.some((x) => x.id === 'bridge-east-temple')).toBe(false);
    expect(server.world.current!.spec.title).toBe('Step one');
    const u2 = await withTicks(server, directorCall(server, 'POST', ROUTES.directorUndo));
    expect(u2.json.ok, JSON.stringify(u2.json)).toBe(true);
    expect(u2.json.worldVersion).toBe(5);
    expect(server.world.current!.spec.title.endsWith('(fixture)')).toBe(true);
    expect(server.world.current!.spec.worldVersion).toBe(5);
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east']);
    expect(server.session.state.relicTombstones['relic-east']).toMatchObject({ byPlayerId: p0.playerId });
    expect(server.session.state.score).toBe(SCORING.relic);
    const u3 = await withTicks(server, directorCall(server, 'POST', ROUTES.directorUndo));
    expect(u3.json.ok).toBe(false);
    expect(u3.json.code).toBe('UNSUPPORTED_OPERATION');
    expect(server.world.version).toBe(5);
    await c0.close();
  });

  it('undo that would strand a player on a bridge the previous spec lacks is refused and the world is untouched', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const b = await stageValidate(server, [{ op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple', width: 2.4 }]);
    expect((await commit(server, b.staged.candidateId, b.proofId)).result.ok).toBe(true);
    const compiled = server.world.current!.compiled;
    const bridge = server.world.current!.spec.bridges.find((x) => x.id === 'bridge-east-temple')!;
    const mid = { x: (bridge.endpoints[0].point.x + bridge.endpoints[1].point.x) / 2, z: (bridge.endpoints[0].point.z + bridge.endpoints[1].point.z) / 2 };
    expect(compiled.supportAt(mid.x, mid.z)).toBe('bridge-east-temple');
    setPosition(server, p0.playerId, mid.x, mid.z);
    server.tick();
    expect(server.session.player(p0.playerId)!.supportId).toBe('bridge-east-temple');
    const specBefore = JSON.stringify(server.world.current!.spec);
    const undo = await withTicks(server, directorCall(server, 'POST', ROUTES.directorUndo));
    expect(undo.status).toBe(200);
    expect(undo.json.ok).toBe(false);
    expect(['OCCUPIED_SUPPORT', 'PLAYER_CUT_OFF']).toContain(undo.json.code);
    expect(undo.json.objectIds).toContain(p0.playerId);
    expect(server.world.version).toBe(2);
    expect(JSON.stringify(server.world.current!.spec)).toBe(specBefore);
    expect(server.session.player(p0.playerId)!.status).toBe('active');
    await c0.close();
  });

  it('a commit lands while a player is falling off the bridge it removes; the player respawns on the new world', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const { staged, proofId } = await stageValidate(server, [
      { op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple', width: 2.4 },
      { op: 'remove_bridge', id: 'bridge-north' },
    ]);
    setPosition(server, p0.playerId, 0, 14);
    server.tick();
    expect(server.session.player(p0.playerId)!.supportId).toBe('bridge-north');
    await input(server, c0, p0.playerId, 1, { x: 1, z: 0 }, false);
    let falling = false;
    for (let i = 0; i < 40 && !falling; i += 1) {
      await input(server, c0, p0.playerId, 2 + i, { x: 1, z: 0 }, false);
      server.tick();
      falling = server.session.player(p0.playerId)!.status === 'falling';
    }
    expect(falling).toBe(true);
    expect(server.session.player(p0.playerId)!.supportId).toBeNull();
    // Defined behaviour: a falling player is not a blocker; the commit proceeds and the player respawns at spawn.
    const res = await commit(server, staged.candidateId, proofId);
    expect(res.result.ok, JSON.stringify(res.result)).toBe(true);
    if (!res.result.ok) throw new Error('unreachable');
    expect(res.result.deferredMs).toBe(0);
    expect(server.world.current!.spec.bridges.some((x) => x.id === 'bridge-north')).toBe(false);
    const ticksNeeded = Math.ceil((GEOMETRY.fallDurationMs + GEOMETRY.respawnDurationMs) / (1000 / SIMULATION.tickHz)) + 3;
    server.tick(ticksNeeded);
    const p = server.session.player(p0.playerId)!;
    expect(p.status).toBe('active');
    expect(p.supportId).toBe('centre');
    expect(p.respawns).toBe(1);
    expect(p.y).toBe(0);
    const spawn = server.sim.spawnFor(0).pos;
    expect(p.x).toBeCloseTo(spawn.x, 3);
    expect(p.z).toBeCloseTo(spawn.z, 3);
    await c0.close();
  });

  it('50 sequential patch commits: versions strictly increase, a snapshot per version, no stale compiled worlds pinned', async () => {
    const { server, dataDir } = await makeServer();
    let last = server.world.version;
    for (let i = 0; i < 50; i += 1) {
      const { staged, proofId } = await stageValidate(server, [{ op: 'set_title', title: `Patch number ${i}` }]);
      const res = await commit(server, staged.candidateId, proofId);
      expect(res.result.ok, JSON.stringify(res.result)).toBe(true);
      if (!res.result.ok) throw new Error('unreachable');
      expect(res.result.worldVersion).toBe(last + 1);
      last = res.result.worldVersion;
      expect(server.world.current!.spec.worldVersion).toBe(last);
    }
    expect(last).toBe(51);
    for (let i = 0; i < 100; i += 1) {
      if (existsSync(path.join(dataDir, 'snapshots', 'world-v51.json'))) break;
      await sleep(20);
    }
    for (let v = 2; v <= 51; v += 1) expect(existsSync(path.join(dataDir, 'snapshots', `world-v${v}.json`)), `world-v${v}.json`).toBe(true);
    expect(server.world.history.length).toBeLessThanOrEqual(50);
    const all = [...((server.candidates as unknown as { candidates: Map<string, { compiled: unknown; baseWorldVersion: number }> }).candidates.values())];
    expect(all.length).toBe(50);
    expect(all.filter((c) => c.compiled !== null).length).toBe(0);
    expect(server.candidates.size()).toBeLessThanOrEqual(200);
  });

  it('the same candidate committed twice concurrently lands once and replays once', async () => {
    const { server } = await makeServer();
    const a = await stageValidate(server, [{ op: 'set_title', title: 'Double submit' }]);
    const both = await withTicks(server, Promise.all([commitCall(server, a.staged.candidateId, a.proofId), commitCall(server, a.staged.candidateId, a.proofId)]));
    const results = both.map((r) => r.json as CommitResult);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.idempotentReplay : null)).sort()).toEqual([false, true]);
    expect(server.world.version).toBe(2);
    expect(server.events.recent(50, (e) => e.name === 'commit.ok').length).toBe(1);
  });

  it('two valid candidates on the same base committed concurrently: exactly one lands, the other is STALE_WORLD_VERSION', async () => {
    const { server } = await makeServer();
    const a = await stageValidate(server, [{ op: 'set_title', title: 'Candidate A' }]);
    const b = await stageValidate(server, [{ op: 'add_bridge', id: 'bridge-east-temple', from: 'east', to: 'temple', width: 2.4 }]);
    const both = await withTicks(server, Promise.all([commitCall(server, a.staged.candidateId, a.proofId), commitCall(server, b.staged.candidateId, b.proofId)]));
    const results = both.map((r) => r.json as CommitResult);
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok) as Extract<CommitResult, { ok: false }>[];
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].code).toBe('STALE_WORLD_VERSION');
    expect(server.world.version).toBe(2);
    const title = server.world.current!.spec.title;
    const hasBridge = server.world.current!.spec.bridges.some((x) => x.id === 'bridge-east-temple');
    expect(title === 'Candidate A' ? !hasBridge : hasBridge).toBe(true);
  });
});

describe('simulation edge cases', () => {
  it('a diagonal walk off a bridge edge falls, and the hazard respawn restores the spawn support', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    setPosition(server, p0.playerId, 0.9, 14);
    server.tick();
    const player = server.session.player(p0.playerId)!;
    expect(player.supportId).toBe('bridge-north');
    let seq = 1;
    let fellAt = -1;
    for (let i = 0; i < 30; i += 1) {
      await input(server, c0, p0.playerId, seq++, { x: 1, z: 1 }, false);
      server.tick();
      if (player.status === 'falling') { fellAt = i; break; }
    }
    expect(fellAt).toBeGreaterThanOrEqual(0);
    expect(fellAt).toBeLessThan(10);
    expect(player.supportId).toBeNull();
    expect(player.vx).toBe(0);
    expect(server.events.recent(50, (e) => e.name === 'player.fell').length).toBe(1);
    server.tick(Math.ceil(GEOMETRY.fallDurationMs / (1000 / SIMULATION.tickHz)) + 1);
    expect(player.status).toBe('respawning');
    expect(player.supportId).toBe('centre');
    expect(player.respawns).toBe(1);
    expect(player.lavaFalls).toBe(0);
    expect(server.session.state.score).toBe(0);
    server.tick(Math.ceil(GEOMETRY.respawnDurationMs / (1000 / SIMULATION.tickHz)) + 1);
    expect(player.status).toBe('active');
    expect(player.supportId).toBe('centre');
    await c0.close();
  });

  it('lava penalties clamp the score at 0 and count lava falls', async () => {
    const h = await makeServer();
    const { server } = h;
    const { staged, proofId } = await stageValidate(server, [{ op: 'set_hazard', kind: 'lava' }]);
    expect((await commit(server, staged.candidateId, proofId)).result.ok).toBe(true);
    expect(server.world.current!.spec.hazard.kind).toBe('lava');
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const player = server.session.player(p0.playerId)!;
    for (let round = 0; round < 3; round += 1) {
      setPosition(server, p0.playerId, 30, 30); // nothing under here
      server.tick();
      expect(player.status).toBe('falling');
      server.tick(Math.ceil((GEOMETRY.fallDurationMs + GEOMETRY.respawnDurationMs) / (1000 / SIMULATION.tickHz)) + 2);
      expect(player.status).toBe('active');
      expect(server.session.state.score).toBe(0);
    }
    expect(player.lavaFalls).toBe(3);
    expect(player.respawns).toBe(3);
    expect(server.session.state.score).toBeGreaterThanOrEqual(0);
    await c0.close();
  });

  it('gate unlocks only after all three relics; the win is awarded once with both players in the trigger', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const p1 = await joinPlayer(server, 1);
    const c0 = await connectController(h, p0.controllerToken);
    const c1 = await connectController(h, p1.controllerToken);
    server.tick();
    let seq = 1;
    for (const id of ['relic-east', 'relic-west']) {
      const pos = relicPos(server, id);
      setPosition(server, p0.playerId, pos.x, pos.z);
      await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, false);
      server.tick();
      await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, true);
      server.tick();
    }
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east', 'relic-west']);
    expect(server.session.state.gateUnlocked).toBe(false);
    const gate = gatePos(server);
    setPosition(server, p0.playerId, gate.x, gate.z);
    setPosition(server, p1.playerId, gate.x + 0.5, gate.z);
    server.tick(3);
    expect(server.session.state.won).toBe(false);
    expect(server.session.state.score).toBe(2 * SCORING.relic);
    // Nobody in the trigger when the third relic unlocks the gate: unlock alone never wins.
    setPosition(server, p0.playerId, 0, 0);
    const south = relicPos(server, 'relic-south');
    setPosition(server, p1.playerId, south.x, south.z);
    await input(server, c1, p1.playerId, 1, { x: 0, z: 0 }, false);
    server.tick();
    await input(server, c1, p1.playerId, 2, { x: 0, z: 0 }, true);
    server.tick();
    expect(server.session.state.gateUnlocked).toBe(true);
    expect(server.session.state.won).toBe(false);
    expect(server.events.recent(200, (e) => e.name === 'gate.unlocked').length).toBe(1);
    // Both players step into the trigger in the same tick: one win, one bonus.
    setPosition(server, p0.playerId, gate.x + 0.5, gate.z);
    setPosition(server, p1.playerId, gate.x - 0.5, gate.z);
    server.tick();
    expect(server.session.state.won).toBe(true);
    expect(server.session.state.score).toBe(3 * SCORING.relic + SCORING.win);
    server.tick(10);
    expect(server.session.state.score).toBe(3 * SCORING.relic + SCORING.win);
    expect(server.events.recent(200, (e) => e.name === 'session.won').length).toBe(1);
    const tick = server.sim.buildTickMessage(server.clock.now());
    expect(tick.gate).toEqual({ unlocked: true, won: true });
    await c0.close();
    await c1.close();
  });

  it('holding interact across ticks collects one relic per press, even when carried onto another relic', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const east = relicPos(server, 'relic-east');
    const west = relicPos(server, 'relic-west');
    setPosition(server, p0.playerId, east.x, east.z);
    let seq = 1;
    await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, true);
    server.tick();
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east']);
    for (let i = 0; i < 5; i += 1) {
      await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, true);
      server.tick();
    }
    setPosition(server, p0.playerId, west.x, west.z);
    for (let i = 0; i < 5; i += 1) {
      await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, true);
      server.tick();
    }
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east']);
    await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, false);
    server.tick();
    await input(server, c0, p0.playerId, seq++, { x: 0, z: 0 }, true);
    server.tick();
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east', 'relic-west']);
    expect(server.session.state.score).toBe(2 * SCORING.relic);
    await c0.close();
  });
});

describe('persistence under restart and corruption', () => {
  it('a restart restores the version, collected relics, tombstones and score from the snapshots', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'beetle-adversarial-persist-'));
    extraDirs.push(dataDir);
    const h = await makeServer({ dataDir });
    const { server } = h;
    const p0 = await joinPlayer(server, 0);
    const c0 = await connectController(h, p0.controllerToken);
    server.tick();
    const east = relicPos(server, 'relic-east');
    setPosition(server, p0.playerId, east.x, east.z);
    await input(server, c0, p0.playerId, 1, { x: 0, z: 0 }, true);
    server.tick();
    expect(server.session.state.collectedRelicIds).toEqual(['relic-east']);
    const { staged, proofId } = await stageValidate(server, [{ op: 'set_title', title: 'Persist me' }]);
    expect((await commit(server, staged.candidateId, proofId)).result.ok).toBe(true);
    const tombstone = server.session.state.relicTombstones['relic-east'];
    await c0.close();
    harnesses.splice(harnesses.indexOf(h), 1);
    await server.stop();
    expect(existsSync(path.join(dataDir, 'snapshots', 'session.json'))).toBe(true);

    const h2 = await makeServer({ dataDir, loadSnapshot: true });
    expect(h2.server.world.version).toBe(2);
    expect(h2.server.world.current!.spec.title).toBe('Persist me');
    expect(h2.server.session.state.worldVersion).toBe(2);
    expect(h2.server.session.state.collectedRelicIds).toEqual(['relic-east']);
    expect(h2.server.session.state.relicTombstones['relic-east']).toEqual(tombstone);
    expect(h2.server.session.state.score).toBe(SCORING.relic);
    expect(h2.server.session.state.players.every((p) => !p.connected && p.status === 'disconnected')).toBe(true);
    expect(h2.server.startupNotes().some((n) => n.startsWith('session: restored 1 collected relic'))).toBe(true);
    h2.server.tick();
    const tick = h2.server.sim.buildTickMessage(h2.server.clock.now());
    expect(tick.relics['relic-east']).toBe('collected');
    expect(tick.worldVersion).toBe(2);
    // The next commit continues from the restored version.
    const next = await stageValidate(h2.server, [{ op: 'set_title', title: 'After restart' }]);
    expect((await commit(h2.server, next.staged.candidateId, next.proofId)).result).toMatchObject({ ok: true, worldVersion: 3 });
  });

  it('a corrupt world-current.json does not crash startup: fixture fallback with a persistence.error event', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'beetle-adversarial-corrupt-'));
    extraDirs.push(dataDir);
    mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });
    writeFileSync(path.join(dataDir, 'snapshots', 'world-current.json'), '{"version": 7, "spec": {"islands": [}}}} garbage', 'utf8');
    writeFileSync(path.join(dataDir, 'snapshots', 'session.json'), 'not json either', 'utf8');
    const { server } = await makeServer({ dataDir, loadSnapshot: true });
    expect(server.world.hasWorld).toBe(true);
    expect(server.world.version).toBe(1);
    expect(server.world.current!.spec.title.endsWith('(fixture)')).toBe(true);
    const errs = server.events.recent(50, (e) => e.name === 'persistence.error');
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(String((errs[0] as { data?: { file?: string } }).data?.file)).toContain('world-current.json');
    expect(server.startupNotes().some((n) => n.includes('world-current.json') && n.startsWith('persistence:'))).toBe(true);
    const health = await api(server, 'GET', ROUTES.health);
    expect(health.json).toMatchObject({ ok: true, hasWorld: true, worldVersion: 1 });

    // A well-formed file with an invalid spec is also reported, not trusted.
    const dataDir2 = mkdtempSync(path.join(os.tmpdir(), 'beetle-adversarial-corrupt2-'));
    extraDirs.push(dataDir2);
    mkdirSync(path.join(dataDir2, 'snapshots'), { recursive: true });
    writeFileSync(path.join(dataDir2, 'snapshots', 'world-current.json'), JSON.stringify({ version: 9, spec: { worldId: 'x', islands: [] } }), 'utf8');
    const second = await makeServer({ dataDir: dataDir2, loadSnapshot: true });
    expect(second.server.world.version).toBe(1);
    expect(second.server.events.recent(50, (e) => e.name === 'persistence.error').length).toBe(1);
  });
});

describe('health agentConnected during a long job', () => {
  it('stays true while a claimed request is unfinished or a status update is recent, and drops 30 s after the job ends', async () => {
    const { server, clock } = await makeServer();
    const healthy = async () => (await api(server, 'GET', ROUTES.health)).json.agentConnected as boolean;
    expect(await healthy()).toBe(false);
    const req = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'edit', prompt: 'add a bridge east to temple' });
    expect(req.status).toBe(200);
    const claim = await agentCall(server, 'POST', ROUTES.agentRequestsClaim, { workerId: 'worker-adv' });
    expect(claim.status).toBe(200);
    expect(claim.json.request.id).toBe(req.json.request.id);
    expect(await healthy()).toBe(true);
    // A long model call: no claim long-poll for two minutes, the request is still planning.
    clock.advance(120_000);
    expect(await healthy()).toBe(true);
    const status = await agentCall(server, 'POST', ROUTES.agentRequestStatus.replace(':id', req.json.request.id), { phase: 'validating', message: 'Validating candidate' });
    expect(status.status).toBe(200);
    clock.advance(120_000);
    expect(await healthy()).toBe(true); // still claimed and unfinished (validating)
    const finish = await agentCall(server, 'POST', ROUTES.agentRequestFinish.replace(':id', req.json.request.id), { outcome: 'failed', error: { code: 'INTERNAL', message: 'model gave up' } });
    expect(finish.status).toBe(200);
    expect(await healthy()).toBe(true); // finish counts as a status update
    clock.advance(29_000);
    expect(await healthy()).toBe(true);
    clock.advance(2_000);
    expect(await healthy()).toBe(false); // no active job, no claim, no status for > 30 s
    // A status update on a finished request still proves the agent is alive, without reopening the request.
    const late = await agentCall(server, 'POST', ROUTES.agentRequestStatus.replace(':id', req.json.request.id), { phase: 'planning', message: 'late' });
    expect(late.status).toBe(200);
    expect(await healthy()).toBe(true);
    expect((await directorCall(server, 'GET', ROUTES.directorRequestById.replace(':id', req.json.request.id))).json.request.status).toBe('failed');
    clock.advance(31_000);
    expect(await healthy()).toBe(false);
  });
});

describe('loop timing', () => {
  it('averages a few milliseconds or less per tick with two moving players on a 16-bridge world', async () => {
    const spec = sixteenBridgeWorld();
    expect(spec.bridges.length).toBe(16);
    expect(spec.islands.length).toBe(8);
    const h = await makeServer({ startWorld: spec });
    const { server } = h;
    const check = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: 'req-timing', spec });
    expect(check.status).toBe(200);
    const vr = await validate(server, check.json.candidateId);
    expect(vr.ok, JSON.stringify(vr.issues)).toBe(true);
    const p0 = await joinPlayer(server, 0);
    const p1 = await joinPlayer(server, 1);
    const c0 = await connectController(h, p0.controllerToken);
    const c1 = await connectController(h, p1.controllerToken);
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    await display.next((m) => m.type === 'welcome');
    server.tick();
    const samples: number[] = [];
    let seq = 1;
    for (let i = 0; i < 300; i += 1) {
      if (i % 10 === 0) {
        const dir = { x: Math.cos(i / 20), z: Math.sin(i / 20) };
        await input(server, c0, p0.playerId, seq, dir, i % 40 === 0);
        await input(server, c1, p1.playerId, seq, { x: -dir.x, z: -dir.z }, false);
        seq += 1;
      }
      const t0 = performance.now();
      server.tick();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const max = samples[samples.length - 1];
    // eslint-disable-next-line no-console
    console.log(`[timing] 300 ticks, 16 bridges, 2 players: avg ${avg.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${max.toFixed(3)} ms`);
    expect(avg).toBeLessThan(3);
    expect(p95).toBeLessThan(10);
    expect(server.session.state.tick).toBeGreaterThanOrEqual(300);
    const ticks = display.received().filter((m) => m.type === 'tick');
    expect(ticks.length).toBeGreaterThan(200);
    await c0.close();
    await c1.close();
    await display.close();
  });
});
