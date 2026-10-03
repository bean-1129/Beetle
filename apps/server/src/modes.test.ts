// Game-mode tests: createBeetleServer on port 0, fake clock, manual ticks. Mode fixtures come from @beetle/world when
// they exist ('trial5', 'hill4', 'race5', 'survival5'); otherwise the spec is garden5 with the mode set inline. Every
// test overrides the parameters it depends on (time limit, hold seconds, hazard rise) so the fixture layout is free.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  GEOMETRY, MOVEMENT_SCALES, PING_LIFETIME_MS, ROUTES, SCORING,
  type CommitResult, type MarkerMessage, type ServerMessage, type SessionState, type TickMessage, type ValidationResult, type WorldSpec,
} from '@beetle/contracts';
import { FIXTURE_NAMES, fixtureWorld, type FixtureName } from '@beetle/world';
import { createBeetleServer, createFakeClock, TICK_MS, type BeetleServer, type BeetleServerOptions } from './index.ts';

const DIRECTOR = 'd1rector-token-for-tests-0123456789ab';
const AGENT = 'agent-token-for-tests-0123456789abcdef';

type Harness = { server: BeetleServer; dataDir: string; clock: ReturnType<typeof createFakeClock>; port: number };
const harnesses: Harness[] = [];

async function makeServer(extra: Partial<BeetleServerOptions> = {}): Promise<Harness> {
  const dataDir = extra.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'beetle-modes-test-'));
  const clock = createFakeClock(1_750_000_000_000);
  const server = await createBeetleServer({
    host: '127.0.0.1',
    port: 0,
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
    dataDir,
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

async function api(server: BeetleServer, method: 'GET' | 'POST', url: string, opts: { body?: unknown; token?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await server.app.inject({ method, url, headers, payload: opts.body === undefined ? undefined : JSON.stringify(opts.body), remoteAddress: '127.0.0.1' });
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

async function commitPatch(server: BeetleServer, ops: unknown[], summary = 'test patch'): Promise<CommitResult> {
  const staged = await agentCall(server, 'POST', ROUTES.agentProposePatch, { requestId: 'req-modes', patch: { summary, ops } });
  expect(staged.status, JSON.stringify(staged.json)).toBe(200);
  const vr = await agentCall(server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId));
  const validation = vr.json as ValidationResult;
  expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
  const res = await withTicks(server, agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: validation.proof!.proofId }));
  return res.json as CommitResult;
}

async function commitWorld(server: BeetleServer, spec: WorldSpec): Promise<CommitResult> {
  // With players connected a new world must be authorised by the director request that owns the candidate.
  const request = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'a hill to hold', authorizeNewWorld: true });
  expect(request.status, JSON.stringify(request.json)).toBe(200);
  const staged = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: request.json.request.id, spec });
  expect(staged.status, JSON.stringify(staged.json)).toBe(200);
  const vr = await agentCall(server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId));
  const validation = vr.json as ValidationResult;
  expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
  const res = await withTicks(server, agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: validation.proof!.proofId }));
  return res.json as CommitResult;
}

async function joinPlayer(server: BeetleServer, slot: 0 | 1) {
  const invite = await directorCall(server, 'POST', ROUTES.directorInvite, { slot });
  expect(invite.status).toBe(200);
  const join = await api(server, 'POST', ROUTES.join, { body: { inviteCode: invite.json.inviteCode } });
  expect(join.status, JSON.stringify(join.json)).toBe(200);
  return join.json as { controllerToken: string; playerId: string; slot: 0 | 1 };
}

type WsClient = { send(msg: unknown): void; next(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>; close(): Promise<void> };

function connectWs(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${ROUTES.ws}`);
    const queue: ServerMessage[] = [];
    const waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else {
        queue.push(msg);
        if (queue.length > 500) queue.splice(0, 100);
      }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
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

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 4));
  }
}

function setPosition(server: BeetleServer, playerId: string, x: number, z: number): void {
  const player = server.session.player(playerId);
  if (!player) throw new Error('unknown player ' + playerId);
  const compiled = server.world.current?.compiled;
  player.x = x; player.z = z; player.vx = 0; player.vz = 0;
  player.status = 'active';
  player.supportId = compiled ? compiled.supportAt(x, z) : null;
}

/** A joined player with a live controller socket. Inputs are confirmed applied before returning. */
class Pad {
  seq = 0;
  private constructor(readonly h: Harness, readonly client: WsClient, readonly playerId: string) {}

  static async join(h: Harness, slot: 0 | 1): Promise<Pad> {
    const joined = await joinPlayer(h.server, slot);
    const client = await connectWs(h.port);
    client.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    await client.next((m) => m.type === 'welcome');
    return new Pad(h, client, joined.playerId);
  }

  get player() {
    return this.h.server.session.player(this.playerId)!;
  }

  /** Sends one input (buttons omitted = an older controller) and waits until the server applied it. */
  async input(axes: { x: number; z: number }, interact: boolean, buttons?: Record<string, boolean>): Promise<void> {
    this.seq += 1;
    const seq = this.seq;
    this.client.send(buttons ? { type: 'input', seq, axes, interact, buttons } : { type: 'input', seq, axes, interact });
    await waitFor(() => this.player.lastInputSeq >= seq, `input ${seq}`);
  }

  /** Press and release interact across two ticks. */
  async press(): Promise<void> {
    await this.input({ x: 0, z: 0 }, true);
    this.h.server.tick();
    await this.input({ x: 0, z: 0 }, false);
    this.h.server.tick();
  }

  async collectAt(pos: { x: number; z: number }): Promise<void> {
    setPosition(this.h.server, this.playerId, pos.x, pos.z);
    await this.press();
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function relicPos(server: BeetleServer, id: string): { x: number; z: number } {
  const active = server.world.current!;
  const relic = active.spec.relics.find((r) => r.id === id);
  if (!relic) throw new Error('unknown relic ' + id);
  const pos = active.compiled.worldPos(relic.supportingSurfaceId, relic.localPosition);
  if (!pos) throw new Error('relic off-island ' + id);
  return pos;
}

function gatePos(server: BeetleServer): { x: number; z: number } {
  const active = server.world.current!;
  const pos = active.compiled.worldPos(active.spec.gate.supportingSurfaceId, active.spec.gate.localPosition);
  if (!pos) throw new Error('gate off-island');
  return pos;
}

const objective = (server: BeetleServer) => server.session.state.objective!;
const state = (server: BeetleServer): SessionState => server.session.state;

function tickUntil(server: BeetleServer, cond: () => boolean, maxTicks: number, what: string): number {
  for (let i = 1; i <= maxTicks; i += 1) {
    server.tick();
    if (cond()) return i;
  }
  throw new Error(`${what} did not happen within ${maxTicks} ticks`);
}

/** The named fixture when @beetle/world ships it, else garden5 with the inline change. */
function modeSpec(name: string, inline: (garden5: WorldSpec) => WorldSpec): WorldSpec {
  if ((FIXTURE_NAMES as readonly string[]).includes(name)) {
    try { return fixtureWorld(name as FixtureName); } catch { /* fall back */ }
  }
  return inline(fixtureWorld('garden5'));
}

const HAZARD_RISE = { afterSec: 5, metersPerSec: 0.5, maxElevation: -0.6 };

function trialSpec(timeLimitSec: number): WorldSpec {
  const base = modeSpec('trial5', (g) => ({ ...g, mode: { kind: 'time_trial' } }));
  return { ...base, mode: { ...(base.mode ?? {}), kind: 'time_trial', timeLimitSec } };
}
function hillSpec(holdSeconds: number): WorldSpec {
  const base = modeSpec('hill4', (g) => ({ ...g, mode: { kind: 'king_of_the_hill' } }));
  return { ...base, mode: { kind: 'king_of_the_hill', holdSeconds } };
}
function raceSpec(): WorldSpec {
  const base = modeSpec('race5', (g) => ({ ...g, mode: { kind: 'checkpoint_race' } }));
  return { ...base, mode: { kind: 'checkpoint_race' } };
}
function survivalSpec(): WorldSpec {
  const base = modeSpec('survival5', (g) => ({ ...g, mode: { kind: 'survival' } }));
  return { ...base, mode: { kind: 'survival' }, hazard: { ...base.hazard, planeElevation: -2.5, rise: HAZARD_RISE } };
}

// ---------------------------------------------------------------------------------------------

describe('time_trial', () => {
  it('counts down from the first input, broadcasts remainingSec, and once expired blocks the win', async () => {
    const h = await makeServer({ startWorld: trialSpec(20) });
    const { server } = h;
    const spec = server.world.current!.spec;
    const pad = await Pad.join(h, 0);
    server.tick(5);
    expect(objective(server)).toMatchObject({ kind: 'time_trial', remainingSec: 20, lost: false });
    server.tick(40);
    expect(objective(server).remainingSec).toBe(20); // no input yet: the clock has not started

    for (const relic of spec.relics) await pad.collectAt(relicPos(server, relic.id));
    expect(state(server).collectedRelicIds).toHaveLength(3);
    expect(state(server).score).toBe(3 * SCORING.relic);
    expect(state(server).gateUnlocked).toBe(true);
    expect(objective(server).remainingSec).toBeLessThan(20);
    expect(objective(server).remainingSec).toBeGreaterThan(19);

    const ticks = tickUntil(server, () => objective(server).lost === true, 700, 'time trial expiry');
    expect(ticks).toBeGreaterThan(550);
    expect(objective(server)).toMatchObject({ kind: 'time_trial', remainingSec: 0, lost: true });
    expect(state(server).won).toBe(false);

    // The gate is open but the win is disabled; players keep moving; the score is unchanged.
    const gate = gatePos(server);
    setPosition(server, pad.playerId, gate.x, gate.z);
    server.tick(3);
    expect(state(server).won).toBe(false);
    expect(state(server).score).toBe(3 * SCORING.relic);
    await pad.input({ x: 0, z: 1 }, false);
    const before = pad.player.z;
    server.tick(2);
    expect(pad.player.z).toBeGreaterThan(before);

    const tick = (await pad.client.next((m) => m.type === 'tick' && (m as TickMessage).objective?.lost === true)) as TickMessage;
    expect(tick.objective).toMatchObject({ kind: 'time_trial', remainingSec: 0, lost: true });
    await pad.close();
  });

  it('an expired timer disables relic pickup until a set_mode patch restarts the clock', async () => {
    const h = await makeServer({ startWorld: trialSpec(20) });
    const { server } = h;
    const spec = server.world.current!.spec;
    const pad = await Pad.join(h, 0);
    await pad.input({ x: 0, z: 0 }, false); // first input starts the countdown
    tickUntil(server, () => objective(server).lost === true, 700, 'time trial expiry');

    await pad.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).collectedRelicIds).toEqual([]);
    expect(state(server).score).toBe(0);

    const result = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 25 } }], 'restart the clock');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(objective(server).lost).toBe(false);
    expect(objective(server).remainingSec).toBeGreaterThan(24);
    await pad.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).collectedRelicIds).toEqual([spec.relics[0].id]);
    expect(state(server).score).toBe(SCORING.relic);
    await pad.close();
  });
});

describe('king_of_the_hill', () => {
  it('never locks the gate, accumulates holdSec on the hill and wins at holdTarget; relics stay bonuses', async () => {
    const h = await makeServer({ startWorld: hillSpec(3) });
    const { server } = h;
    const spec = server.world.current!.spec;
    const pad = await Pad.join(h, 0);
    const other = await joinPlayer(server, 1); // joined, no controller: never counts as active
    server.tick();
    expect(state(server).gateUnlocked).toBe(true);
    expect(objective(server)).toMatchObject({ kind: 'king_of_the_hill', holdTarget: 3, holdSec: { [pad.playerId]: 0, [other.playerId]: 0 } });

    await pad.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).score).toBe(SCORING.relic);

    const gate = gatePos(server);
    setPosition(server, pad.playerId, gate.x, gate.z);
    server.tick(45);
    expect(objective(server).holdSec![pad.playerId]).toBeCloseTo(1.5, 1);
    expect(state(server).won).toBe(false);

    tickUntil(server, () => state(server).won, 60, 'hill win');
    expect(objective(server).holdSec![pad.playerId]).toBeGreaterThanOrEqual(3);
    expect(objective(server).holdSec![other.playerId]).toBe(0);
    expect(state(server).score).toBe(SCORING.relic + SCORING.win);
    expect(state(server).gateUnlocked).toBe(true);
    const won = server.events.recent(50, (e) => e.name === 'session.won');
    expect(won.at(-1)?.data?.playerId).toBe(pad.playerId);
    await pad.close();
  });
});

describe('checkpoint_race', () => {
  it('only the next checkpoint can be collected; the gate unlocks after the last one', async () => {
    const h = await makeServer({ startWorld: raceSpec() });
    const { server } = h;
    const order = server.world.current!.spec.relics.map((r) => r.id);
    const pad = await Pad.join(h, 0);
    server.tick();
    expect(objective(server)).toMatchObject({ kind: 'checkpoint_race', nextCheckpointId: order[0] });

    await pad.collectAt(relicPos(server, order[1])); // out of order: refused
    expect(state(server).collectedRelicIds).toEqual([]);
    expect(objective(server).nextCheckpointId).toBe(order[0]);

    await pad.collectAt(relicPos(server, order[0]));
    expect(state(server).collectedRelicIds).toEqual([order[0]]);
    expect(objective(server).nextCheckpointId).toBe(order[1]);
    expect(state(server).gateUnlocked).toBe(false);

    await pad.collectAt(relicPos(server, order[2])); // still out of order
    expect(state(server).collectedRelicIds).toEqual([order[0]]);

    await pad.collectAt(relicPos(server, order[1]));
    expect(objective(server).nextCheckpointId).toBe(order[2]);
    expect(state(server).gateUnlocked).toBe(false);
    await pad.collectAt(relicPos(server, order[2]));
    expect(objective(server).nextCheckpointId).toBeNull();
    expect(state(server).gateUnlocked).toBe(true);

    const gate = gatePos(server);
    setPosition(server, pad.playerId, gate.x, gate.z);
    server.tick(2);
    expect(state(server).won).toBe(true);
    expect(state(server).score).toBe(3 * SCORING.relic + SCORING.win);
    await pad.close();
  });
});

describe('survival', () => {
  it('raises the hazard after afterSec, submerges bridges so players on them fall, and wins after one relic', async () => {
    const h = await makeServer({ startWorld: survivalSpec() });
    const { server } = h;
    const spec = server.world.current!.spec;
    const pad = await Pad.join(h, 0);
    server.tick();
    expect(objective(server)).toMatchObject({ kind: 'survival', hazardElevation: -2.5, lost: false, relicsRequired: 1 });
    expect(typeof objective(server).remainingSec).toBe('number');

    const bridge = spec.bridges[0];
    const mid = { x: (bridge.endpoints[0].point.x + bridge.endpoints[1].point.x) / 2, z: (bridge.endpoints[0].point.z + bridge.endpoints[1].point.z) / 2 };
    setPosition(server, pad.playerId, mid.x, mid.z);
    server.tick();
    expect(pad.player.supportId).toBe(bridge.id);

    await pad.input({ x: 0, z: 0 }, false); // starts the survival clock
    server.tick(100); // 3.3 s: still before afterSec
    expect(objective(server).hazardElevation).toBe(-2.5);
    expect(pad.player.status).toBe('active');
    expect(pad.player.supportId).toBe(bridge.id);

    const risingAt = tickUntil(server, () => objective(server).hazardElevation! > -2.5, 100, 'hazard rise');
    expect(risingAt).toBeGreaterThan(40);
    expect(pad.player.status).toBe('active'); // deck still clear of the water

    tickUntil(server, () => objective(server).hazardElevation! > -1.0, 200, 'bridge submersion');
    expect(pad.player.status).toBe('falling');
    expect(pad.player.supportId).toBeNull();
    const submerged = server.events.recent(50, (e) => e.name === 'hazard.bridges');
    expect(submerged.at(-1)?.data?.submerged).toBe(true);
    expect(submerged.at(-1)?.data?.bridgeIds).toContain(bridge.id);

    server.tick(60); // fall + respawn: back on the spawn island
    expect(pad.player.status).toBe('active');
    expect(pad.player.supportId).not.toBeNull();
    expect(spec.islands.some((i) => i.id === pad.player.supportId)).toBe(true);
    expect(pad.player.respawns).toBe(1);

    tickUntil(server, () => objective(server).hazardElevation === -0.6, 200, 'hazard cap');
    server.tick(30);
    expect(objective(server).hazardElevation).toBe(-0.6);
    expect(pad.player.status).toBe('active'); // islands never submerge

    await pad.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).gateUnlocked).toBe(true); // survival needs one relic by default
    const gate = gatePos(server);
    setPosition(server, pad.playerId, gate.x, gate.z);
    server.tick(2);
    expect(state(server).won).toBe(true);
    expect(objective(server).lost).toBe(false);
    await pad.close();
  });
});

describe('mode changes and persistence', () => {
  it('a set_mode patch keeps players, relics, score and sockets; a world commit resets them', async () => {
    const h = await makeServer();
    const { server } = h;
    const p0 = await Pad.join(h, 0);
    const p1 = await Pad.join(h, 1);
    server.tick();
    expect(objective(server)).toMatchObject({ kind: 'relic_hunt', relicsRequired: 3 });

    await p0.collectAt(relicPos(server, 'relic-east'));
    setPosition(server, p1.playerId, -3, 3);
    server.tick();
    expect(state(server).score).toBe(SCORING.relic);
    const positions = state(server).players.map((p) => ({ id: p.id, x: p.x, z: p.z, connected: p.connected }));

    const patched = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 30 } }], 'make it a time trial');
    expect(patched.ok, JSON.stringify(patched)).toBe(true);
    expect(server.world.version).toBe(2);
    expect(state(server).collectedRelicIds).toEqual(['relic-east']);
    expect(state(server).score).toBe(SCORING.relic);
    expect(state(server).players.map((p) => ({ id: p.id, x: p.x, z: p.z, connected: p.connected }))).toEqual(positions);
    expect(objective(server)).toMatchObject({ kind: 'time_trial', lost: false });
    expect(objective(server).remainingSec).toBeLessThanOrEqual(30);
    expect(objective(server).remainingSec).toBeGreaterThan(29);
    await p1.input({ x: 0, z: 0 }, false); // the controller socket is still bound
    expect(p1.player.lastInputSeq).toBe(p1.seq);
    const world = await api(server, 'GET', ROUTES.world);
    expect(world.json.summary.mode).toMatchObject({ kind: 'time_trial', timeLimitSec: 30 });
    expect(world.json.summary.biome).toBe('garden');

    const koth: WorldSpec = { ...fixtureWorld('garden5'), worldId: 'garden5-hill', title: 'Hill', mode: { kind: 'king_of_the_hill', holdSeconds: 5 } };
    const committed = await commitWorld(server, koth);
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    expect(server.world.version).toBe(3);
    expect(state(server).collectedRelicIds).toEqual([]);
    expect(state(server).score).toBe(0);
    expect(state(server).gateUnlocked).toBe(true);
    expect(objective(server)).toEqual({ kind: 'king_of_the_hill', holdSec: { [p0.playerId]: 0, [p1.playerId]: 0 }, holdTarget: 5 });
    expect(state(server).players.every((p) => p.connected && p.supportId === 'centre')).toBe(true);
    await p0.close();
    await p1.close();
  });

  it('persists the objective in the session snapshot and restores it on restart', async () => {
    const h = await makeServer();
    const { server } = h;
    const pad = await Pad.join(h, 0);
    const patched = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 20 } }]);
    expect(patched.ok).toBe(true);
    await pad.input({ x: 0, z: 0 }, false);
    server.tick(170); // a session snapshot is written every 5 s of simulated time
    await pad.close();
    await server.stop();

    const file = path.join(h.dataDir, 'snapshots', 'session.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as SessionState;
    expect(saved.objective).toMatchObject({ kind: 'time_trial', lost: false });
    expect(saved.objective!.remainingSec).toBeLessThan(20);
    expect(saved.objective!.remainingSec).toBeGreaterThan(10);

    const restarted = await makeServer({ dataDir: h.dataDir, loadSnapshot: true, startWorld: undefined });
    expect(restarted.server.startupNotes().some((n) => n.includes('restored'))).toBe(true);
    expect(restarted.server.world.version).toBe(2);
    restarted.server.tick();
    const restored = objective(restarted.server);
    expect(restored.kind).toBe('time_trial');
    expect(Math.abs(restored.remainingSec! - saved.objective!.remainingSec!)).toBeLessThan(0.2);
    restarted.server.tick(30);
    expect(objective(restarted.server).remainingSec).toBeLessThan(restored.remainingSec!); // the clock keeps running
  });
});

describe('movement speed', () => {
  it.each([7, 3])('moves at movement.speed = %s m/s', async (speed) => {
    const h = await makeServer({ startWorld: { ...fixtureWorld('garden5'), movement: { speed } } });
    const { server } = h;
    const pad = await Pad.join(h, 0);
    server.tick();
    expect(pad.player.supportId).toBe('centre');
    await pad.input({ x: 1, z: 0 }, false);
    const x0 = pad.player.x;
    server.tick(10);
    const moved = pad.player.x - x0;
    expect(moved).toBeCloseTo((speed * 10 * TICK_MS) / 1000, 1);
    expect(pad.player.status).toBe('active');
    await pad.close();
  });
});

describe('startup fixtures', () => {
  it('BEETLE_START_WORLD=fixture:<name> loads that fixture; unknown names fall back to garden5 with a note', async () => {
    const unknown = await makeServer({ env: { BEETLE_START_WORLD: 'fixture:not-a-fixture' }, startWorld: undefined });
    expect(unknown.server.world.current!.spec.worldId).toBe('garden5');
    expect(unknown.server.startupNotes().some((n) => n.includes('unknown fixture "not-a-fixture"'))).toBe(true);
    expect(unknown.server.startupNotes().some((n) => n.includes('fixture garden5 as version 1'))).toBe(true);

    const named = await makeServer({ env: { BEETLE_START_WORLD: 'fixture:hill4' }, startWorld: undefined });
    expect(named.server.world.hasWorld).toBe(true);
    const notes = named.server.startupNotes();
    if ((FIXTURE_NAMES as readonly string[]).includes('hill4')) {
      expect(notes.some((n) => n.includes('fixture hill4 as version 1'))).toBe(true);
      expect(named.server.world.current!.spec.title.endsWith('(fixture)')).toBe(true);
      const world = await api(named.server, 'GET', ROUTES.world);
      expect(world.json.summary.mode.kind).toBe('king_of_the_hill');
    } else {
      expect(notes.some((n) => n.includes('unknown fixture "hill4"'))).toBe(true);
    }
  });
});

describe('controller buttons', () => {
  it('sprint and slow scale the speed and show in the player view; inputs without buttons keep working', async () => {
    const h = await makeServer();
    const { server } = h;
    const pad = await Pad.join(h, 0);
    server.tick();
    const run = async (buttons?: Record<string, boolean>) => {
      setPosition(server, pad.playerId, -2, -2);
      await pad.input({ x: 1, z: 0 }, false, buttons);
      const x0 = pad.player.x;
      server.tick(10);
      return pad.player.x - x0;
    };
    const base = (GEOMETRY.playerSpeed * 10 * TICK_MS) / 1000;
    expect(await run()).toBeCloseTo(base, 1);
    expect(server.sim.buildTickMessage(h.clock.now()).players[0]).toMatchObject({ sprinting: false, slow: false, emote: null });
    expect(await run({ sprint: true })).toBeCloseTo(base * MOVEMENT_SCALES.sprint, 1);
    expect(server.sim.buildTickMessage(h.clock.now()).players[0]).toMatchObject({ sprinting: true, slow: false });
    expect(await run({ slow: true })).toBeCloseTo(base * MOVEMENT_SCALES.slow, 1);
    expect(server.sim.buildTickMessage(h.clock.now()).players[0]).toMatchObject({ sprinting: false, slow: true });
    expect(await run({ sprint: true, slow: true })).toBeCloseTo(base * MOVEMENT_SCALES.sprint, 1); // sprint wins
    const tick = (await pad.client.next((m) => m.type === 'tick' && (m as TickMessage).players[0]?.sprinting === true)) as TickMessage;
    expect(tick.players[0].slow).toBe(false);

    // Malformed buttons fail the schema: the input is dropped with an error and the previous state stands.
    pad.client.send({ type: 'input', seq: 999, axes: { x: 0, z: 0 }, interact: false, buttons: { sprint: 'yes' } });
    const err = await pad.client.next((m) => m.type === 'error');
    expect(err.type).toBe('error');
    expect(pad.player.lastInputSeq).toBeLessThan(999);
    await pad.close();
  });

  it('ping broadcasts a marker to display and director sockets at most once per second; emote waves for 1.5 s', async () => {
    const h = await makeServer();
    const { server } = h;
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    await display.next((m) => m.type === 'welcome');
    const director = await connectWs(h.port);
    director.send({ type: 'hello', role: 'director', token: DIRECTOR });
    await director.next((m) => m.type === 'welcome');
    const pad = await Pad.join(h, 0);
    server.tick();
    setPosition(server, pad.playerId, 1.5, -2.5);

    await pad.input({ x: 0, z: 0 }, false, { ping: true });
    server.tick();
    const marker = (await display.next((m) => m.type === 'marker')) as MarkerMessage;
    expect(marker).toEqual({ type: 'marker', playerId: pad.playerId, color: pad.player.color, x: 1.5, z: -2.5, until: h.clock.now() + PING_LIFETIME_MS });
    const forDirector = (await director.next((m) => m.type === 'marker')) as MarkerMessage;
    expect(forDirector).toEqual(marker);
    await expect(pad.client.next((m) => m.type === 'marker', 120)).rejects.toThrow(); // controllers do not get beacons

    // Holding is not a new press, and a second press inside one second is dropped.
    server.tick(3);
    await pad.input({ x: 0, z: 0 }, false, { ping: false });
    server.tick();
    await pad.input({ x: 0, z: 0 }, false, { ping: true });
    server.tick();
    expect(server.events.recent(50, (e) => e.name === 'player.ping')).toHaveLength(1);
    await pad.input({ x: 0, z: 0 }, false, { ping: false });
    server.tick(30); // more than a second later
    await pad.input({ x: 0, z: 0 }, false, { ping: true });
    server.tick();
    expect(server.events.recent(50, (e) => e.name === 'player.ping')).toHaveLength(2);
    const second = (await display.next((m) => m.type === 'marker')) as MarkerMessage;
    expect(second.until).toBeGreaterThan(marker.until);

    await pad.input({ x: 0, z: 0 }, false, { emote: true });
    server.tick();
    expect(server.sim.buildTickMessage(h.clock.now()).players[0].emote).toBe('wave');
    server.tick(40); // 1.33 s: still waving
    expect(server.sim.buildTickMessage(h.clock.now()).players[0].emote).toBe('wave');
    server.tick(10); // past 1.5 s
    expect(server.sim.buildTickMessage(h.clock.now()).players[0].emote).toBeNull();
    await pad.close();
    await display.close();
    await director.close();
  });
});
