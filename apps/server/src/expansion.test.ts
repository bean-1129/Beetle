// Streaming generation: frontier detection, the automatic request scheduler and the director settings route.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES, STREAMING, type AgentActivity, type DirectorRequest, type ValidationResult, type WorldSpec } from '@beetle/contracts';
import { compileWorld, fixtureWorld } from '@beetle/world';
import { createBeetleServer, createFakeClock, type BeetleServer, type BeetleServerOptions } from './index.ts';
import { EXPANSION_POLL_MS, createExpansionState, findFrontier, shouldRequest } from './expansion.ts';

const DIRECTOR = 'd1rector-token-for-tests-0123456789ab';
const AGENT = 'agent-token-for-tests-0123456789abcdef';

type Harness = { server: BeetleServer; dataDir: string; clock: ReturnType<typeof createFakeClock> };
const harnesses: Harness[] = [];

async function makeServer(extra: Partial<BeetleServerOptions> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'beetle-expansion-test-'));
  const clock = createFakeClock(1_750_000_000_000);
  const server = await createBeetleServer({
    host: '127.0.0.1', port: 0, dataDir, publicUrl: 'http://127.0.0.1:7700', directorToken: DIRECTOR, agentToken: AGENT,
    startWorld: 'fixture', fixtureName: 'seed2', loadSnapshot: false, tickMode: 'manual', clock,
    ollamaBaseUrl: 'http://127.0.0.1:1', webDistDir: null, logRequests: false, ...extra,
  });
  await server.start();
  const h = { server, dataDir, clock };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  }
});

async function api(server: BeetleServer, method: 'GET' | 'POST', url: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await server.app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body), remoteAddress: '127.0.0.1' });
  let json: unknown = null;
  if (res.body) { try { json = JSON.parse(res.body); } catch { json = res.body; } }
  return { status: res.statusCode, json };
}
const agent = (s: BeetleServer, m: 'GET' | 'POST', u: string, b?: unknown) => api(s, m, u, b, AGENT);
const director = (s: BeetleServer, m: 'GET' | 'POST', u: string, b?: unknown) => api(s, m, u, b, DIRECTOR);

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
  if (!settled) throw new Error('promise did not settle');
  if (error) throw error;
  return value as T;
}

/** Puts slot 0 connected and active at (x, z). */
function placePlayer(h: Harness, x: number, z: number): void {
  const now = h.clock.now();
  const s = h.server.session;
  const p = s.ensurePlayer(0, now);
  s.markConnected(p, now);
  const compiled = h.server.world.current!.compiled;
  s.place(p, { x, z }, compiled.supportAt(x, z), now);
}

/** Advances past the poll throttle and runs one tick. */
function step(h: Harness, ms = EXPANSION_POLL_MS + 50): void {
  h.clock.advance(ms);
  h.server.tick();
}

const autos = (h: Harness): DirectorRequest[] => h.server.requests.list().filter((r) => r.auto === true);

async function finish(h: Harness, id: string, outcome: 'committed' | 'failed', worldVersion?: number) {
  const res = await agent(h.server, 'POST', ROUTES.agentRequestFinish.replace(':id', id), worldVersion === undefined ? { outcome } : { outcome, worldVersion });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

describe('findFrontier and shouldRequest (pure)', () => {
  const compiled = compileWorld(fixtureWorld('seed2'));
  const at = (x: number, z: number, status = 'active') => ({ id: 'player-0', x, z, status, supportId: compiled.supportAt(x, z) });

  it('fires only near a rim with no crossing toward it', () => {
    expect(findFrontier(compiled, at(0, 0))).toBeNull();
    expect(findFrontier(compiled, at(0, -3))).toBeNull(); // 6 m from a 9 m rim
    expect(findFrontier(compiled, at(0, -7))).toEqual({ islandId: 'haven', direction: 'south', playerId: 'player-0' });
    expect(findFrontier(compiled, at(7, 0))).toEqual({ islandId: 'haven', direction: 'east', playerId: 'player-0' });
    expect(findFrontier(compiled, at(0, 7))).toBeNull(); // the grove bridge leaves haven to the north
    expect(findFrontier(compiled, at(5, 5))).toBeNull(); // 45 degrees from the bridge endpoint still counts as a crossing
    expect(findFrontier(compiled, at(0, -7, 'fallen'))).toBeNull();
    expect(findFrontier(compiled, { ...at(0, -7), supportId: null })).toBeNull();
  });

  it('honours streaming, autoExpand, the island cap, one in-flight request and the cooldown', () => {
    const st = createExpansionState();
    const gate = { streaming: true, islandCount: 2, autoExpand: true };
    expect(shouldRequest(st, 1000, gate)).toBe(true);
    expect(shouldRequest(st, 1000, { ...gate, streaming: false })).toBe(false);
    expect(shouldRequest(st, 1000, { ...gate, autoExpand: false })).toBe(false);
    expect(shouldRequest(st, 1000, { ...gate, islandCount: STREAMING.maxIslands })).toBe(false);
    st.inFlightRequestId = 'req-1';
    expect(shouldRequest(st, 1000, gate)).toBe(false);
    st.inFlightRequestId = null;
    st.lastRequestAt = 1000;
    expect(shouldRequest(st, 1000 + STREAMING.cooldownMs - 1, gate)).toBe(false);
    expect(shouldRequest(st, 1000 + STREAMING.cooldownMs, gate)).toBe(true);
  });
});

describe('automatic expansion through the server', () => {
  it('a player at the island centre produces no request', async () => {
    const h = await makeServer();
    placePlayer(h, 0, 0);
    for (let i = 0; i < 5; i += 1) step(h);
    expect(autos(h)).toHaveLength(0);
  });

  it('a player at the rim away from any bridge produces exactly one automatic edit request', async () => {
    const h = await makeServer();
    const seen: string[] = [];
    h.server.events.onEvent((e) => { seen.push(e.name); });
    placePlayer(h, 0, -7);
    step(h);
    for (let i = 0; i < 10; i += 1) step(h, 200); // throttled: many ticks, still one request
    for (let i = 0; i < 3; i += 1) step(h);
    const list = autos(h);
    expect(list).toHaveLength(1);
    const req = list[0];
    expect(req.kind).toBe('edit');
    expect(req.status).toBe('queued');
    expect(req.autoReason).toEqual({ islandId: 'haven', direction: 'south', playerId: 'player-0' });
    expect(req.prompt).toBe('Extend the world: add one or two new islands beyond island "haven" toward the south, each 5 to 9 m radius, with a crossing from "haven" (use add_island with bridgeFrom "haven"), one decoration on each, keep everything else unchanged.');
    expect(h.server.expansion.state.inFlightRequestId).toBe(req.id);
    const activity = h.server.requests.recentActivity(10, req.id) as (AgentActivity & { auto?: boolean; autoReason?: unknown })[];
    expect(activity[0].message.startsWith('Extend the world to the south')).toBe(true);
    expect(activity[0].auto).toBe(true);
    expect(activity[0].autoReason).toEqual({ islandId: 'haven', direction: 'south', playerId: 'player-0' });
    const byId = await director(h.server, 'GET', ROUTES.directorRequestById.replace(':id', req.id));
    expect(byId.status).toBe(200);
    expect(JSON.stringify(byId.json)).toContain('"auto":true');
    expect(JSON.stringify(byId.json)).toContain('"autoReason":{"islandId":"haven","direction":"south","playerId":"player-0"}');
    // The agent claims it like any edit.
    const claim = await agent(h.server, 'POST', ROUTES.agentRequestsClaim, { workerId: 'w1' });
    expect(claim.status).toBe(200);
    expect(JSON.stringify(claim.json)).toContain(req.id);
    expect(seen.filter((n) => n === 'expansion.requested')).toHaveLength(1);
    await finish(h, req.id, 'failed');
    expect(seen.filter((n) => n === 'expansion.settled')).toHaveLength(1);
  });

  it('a second approach within cooldownMs produces none; after the cooldown it can request again', async () => {
    const h = await makeServer();
    placePlayer(h, 0, -7);
    step(h);
    const [first] = autos(h);
    expect(first).toBeDefined();
    await finish(h, first.id, 'failed');
    expect(h.server.expansion.state.inFlightRequestId).toBeNull();
    placePlayer(h, 0, 0);
    step(h);
    placePlayer(h, 7, 0);
    step(h);
    step(h);
    expect(autos(h)).toHaveLength(1);
    h.clock.advance(STREAMING.cooldownMs);
    step(h);
    const list = autos(h);
    expect(list).toHaveLength(2);
    expect(list[1].autoReason).toEqual({ islandId: 'haven', direction: 'east', playerId: 'player-0' });
  });

  it('autoExpand false produces none; the setting shows in health and persists in the session snapshot', async () => {
    const h = await makeServer();
    expect((await api(h.server, 'POST', ROUTES.directorSettings, { autoExpand: false })).status).toBe(401);
    expect((await agent(h.server, 'POST', ROUTES.directorSettings, { autoExpand: false })).status).toBe(403);
    expect((await director(h.server, 'POST', ROUTES.directorSettings, { autoExpand: 'no' })).status).toBe(400);
    expect((await api(h.server, 'GET', ROUTES.health)).json.settings).toEqual({ autoExpand: true });
    const res = await director(h.server, 'POST', ROUTES.directorSettings, { autoExpand: false });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, settings: { autoExpand: false } });
    expect((await api(h.server, 'GET', ROUTES.health)).json.settings).toEqual({ autoExpand: false });
    placePlayer(h, 0, -7);
    for (let i = 0; i < 4; i += 1) step(h);
    expect(autos(h)).toHaveLength(0);
    await h.server.stop();
    const saved = JSON.parse(readFileSync(path.join(h.dataDir, 'snapshots', 'session.json'), 'utf8')) as { settings?: { autoExpand: boolean } };
    expect(saved.settings).toEqual({ autoExpand: false });
    // A restarted server restores the flag with the session.
    const fresh = h.server.session.snapshot();
    const { SessionStore } = await import('./session.ts');
    const restored = new SessionStore();
    restored.restore(fresh, fresh.worldId, []);
    expect(restored.settings.autoExpand).toBe(false);
  });

  it('after a committed add_island patch the state clears and the new island can request again', async () => {
    const h = await makeServer();
    placePlayer(h, 0, -7);
    step(h);
    const [first] = autos(h);
    expect(first?.autoReason?.islandId).toBe('haven');
    const claim = await agent(h.server, 'POST', ROUTES.agentRequestsClaim, { workerId: 'w1' });
    expect(claim.status).toBe(200);
    placePlayer(h, -2, -2); // off the changed rim so the commit is not deferred
    const staged = await agent(h.server, 'POST', ROUTES.agentProposePatch, {
      requestId: first.id,
      patch: { summary: 'extend south', ops: [{ op: 'add_island', id: 'south-isle', center: { x: 0, z: -22 }, radius: 6, bridgeFrom: 'haven' }] },
    });
    expect(staged.status, JSON.stringify(staged.json)).toBe(200);
    const vr = (await agent(h.server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId))).json as ValidationResult;
    expect(vr.ok, JSON.stringify(vr)).toBe(true);
    const committed = await withTicks(h.server, agent(h.server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: vr.proof!.proofId }));
    expect(committed.json.ok, JSON.stringify(committed.json)).toBe(true);
    await finish(h, first.id, 'committed', committed.json.worldVersion);
    expect(h.server.expansion.state.inFlightRequestId).toBeNull();
    expect(h.server.world.current!.spec.islands.map((i) => i.id)).toContain('south-isle');
    // The haven's south rim now has a crossing: no request there.
    h.clock.advance(STREAMING.cooldownMs);
    placePlayer(h, 0, -7);
    step(h);
    expect(autos(h)).toHaveLength(1);
    // The new island's far rim is a frontier.
    placePlayer(h, 0, -26);
    step(h);
    const list = autos(h);
    expect(list).toHaveLength(2);
    expect(list[1].autoReason).toEqual({ islandId: 'south-isle', direction: 'south', playerId: 'player-0' });
  });

  it('a world with 24 islands never requests', async () => {
    const spec = fixtureWorld('seed2') as WorldSpec;
    const extra: WorldSpec['islands'] = [];
    for (const x of [-52, -26, 0, 26, 52]) {
      for (const z of [-52, -26, 0, 26, 52]) {
        if (x === 0 && (z === 0 || z === 26)) continue;
        if (extra.length < 22) extra.push({ id: `isle-${extra.length}`, name: `Isle ${extra.length}`, center: { x, z }, radius: 5, topElevation: 0 });
      }
    }
    const big: WorldSpec = { ...spec, islands: [...spec.islands, ...extra] };
    expect(big.islands).toHaveLength(STREAMING.maxIslands);
    const h = await makeServer({ startWorld: big });
    placePlayer(h, 0, -7);
    for (let i = 0; i < 4; i += 1) step(h);
    h.clock.advance(STREAMING.cooldownMs);
    step(h);
    expect(autos(h)).toHaveLength(0);
  });

  it('a non-streaming world never requests', async () => {
    const h = await makeServer({ fixtureName: 'garden5' });
    expect(h.server.world.current!.spec.streaming).not.toBe(true);
    const compiled = h.server.world.current!.compiled;
    const island = compiled.surfaces.find((s) => s.kind === 'island')!;
    if (island.kind !== 'island') throw new Error('no island');
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      placePlayer(h, island.center.x + dx * (island.radius - 1), island.center.z + dz * (island.radius - 1));
      step(h);
    }
    expect(autos(h)).toHaveLength(0);
  });

  it('a world candidate commit resets expansion state', async () => {
    const h = await makeServer();
    placePlayer(h, 0, -7);
    step(h);
    expect(h.server.expansion.state.inFlightRequestId).not.toBeNull();
    const staged = await agent(h.server, 'POST', ROUTES.agentProposeWorld, { requestId: 'req-new', spec: { ...fixtureWorld('seed2'), worldId: 'seed2-b', title: 'Second Seed' } });
    expect(staged.status, JSON.stringify(staged.json)).toBe(200);
    const vr = (await agent(h.server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId))).json as ValidationResult;
    expect(vr.ok, JSON.stringify(vr)).toBe(true);
    // A new world is only installed with nobody connected (or an authorised brief).
    h.server.session.markDisconnected(h.server.session.playerForSlot(0)!, h.clock.now());
    const committed = await withTicks(h.server, agent(h.server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: vr.proof!.proofId }));
    expect(committed.json.ok, JSON.stringify(committed.json)).toBe(true);
    expect(h.server.expansion.state).toEqual({ lastRequestAt: 0, inFlightRequestId: null });
  });
});
