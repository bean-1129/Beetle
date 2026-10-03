// Adversarial game-mode tests: edge cases around timers, reconnects, mode patches/undo, ties, submersion, buttons and
// the objective field. Same harness as modes.test.ts (createBeetleServer on port 0, fake clock, manual ticks).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  GEOMETRY, MOVEMENT_SCALES, PLAYER_COLORS, ROUTES, SCORING,
  type CommitResult, type MarkerMessage, type ServerMessage, type SessionState, type TickMessage, type ValidationResult, type WorldSpec,
} from '@beetle/contracts';
import { fixtureWorld } from '@beetle/world';
import { createBeetleServer, createFakeClock, TICK_MS, type BeetleServer, type BeetleServerOptions } from './index.ts';
import { SUBMERGE_PLANE_ELEVATION } from './simulation.ts';

const DIRECTOR = 'd1rector-token-for-tests-0123456789ab';
const AGENT = 'agent-token-for-tests-0123456789abcdef';

type Harness = { server: BeetleServer; dataDir: string; clock: ReturnType<typeof createFakeClock>; port: number };
const harnesses: Harness[] = [];

async function makeServer(extra: Partial<BeetleServerOptions> = {}): Promise<Harness> {
  const dataDir = extra.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'beetle-modes-adv-test-'));
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
  const staged = await agentCall(server, 'POST', ROUTES.agentProposePatch, { requestId: 'req-adv', patch: { summary, ops } });
  expect(staged.status, JSON.stringify(staged.json)).toBe(200);
  const vr = await agentCall(server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId));
  const validation = vr.json as ValidationResult;
  expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
  const res = await withTicks(server, agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: validation.proof!.proofId }));
  return res.json as CommitResult;
}

async function commitWorld(server: BeetleServer, spec: WorldSpec): Promise<CommitResult> {
  const request = await directorCall(server, 'POST', ROUTES.directorRequest, { kind: 'brief', prompt: 'another world', authorizeNewWorld: true });
  expect(request.status, JSON.stringify(request.json)).toBe(200);
  const staged = await agentCall(server, 'POST', ROUTES.agentProposeWorld, { requestId: request.json.request.id, spec });
  expect(staged.status, JSON.stringify(staged.json)).toBe(200);
  const vr = await agentCall(server, 'POST', ROUTES.agentValidate.replace(':id', staged.json.candidateId));
  const validation = vr.json as ValidationResult;
  expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
  const res = await withTicks(server, agentCall(server, 'POST', ROUTES.agentCommit.replace(':id', staged.json.candidateId), { proofId: validation.proof!.proofId }));
  return res.json as CommitResult;
}

async function undo(server: BeetleServer): Promise<CommitResult> {
  const res = await withTicks(server, directorCall(server, 'POST', ROUTES.directorUndo));
  return res.json as CommitResult;
}

async function joinPlayer(server: BeetleServer, slot: 0 | 1) {
  const invite = await directorCall(server, 'POST', ROUTES.directorInvite, { slot });
  expect(invite.status).toBe(200);
  const join = await api(server, 'POST', ROUTES.join, { body: { inviteCode: invite.json.inviteCode } });
  expect(join.status, JSON.stringify(join.json)).toBe(200);
  return join.json as { controllerToken: string; playerId: string; slot: 0 | 1 };
}

type WsClient = { send(msg: unknown): void; next(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>; close(): Promise<void>; isOpen(): boolean };

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
      isOpen: () => ws.readyState === WebSocket.OPEN,
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

class Pad {
  seq = 0;
  private constructor(readonly h: Harness, public client: WsClient, readonly playerId: string, readonly token: string) {}

  static async join(h: Harness, slot: 0 | 1): Promise<Pad> {
    const joined = await joinPlayer(h.server, slot);
    const client = await connectWs(h.port);
    client.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    await client.next((m) => m.type === 'welcome');
    return new Pad(h, client, joined.playerId, joined.controllerToken);
  }

  get player() {
    return this.h.server.session.player(this.playerId)!;
  }

  /** Drops the socket and opens a new one with the same controller token (a reloaded phone). */
  async reconnect(): Promise<void> {
    await this.client.close();
    this.client = await connectWs(this.h.port);
    this.client.send({ type: 'hello', role: 'controller', token: this.token, lastSeq: this.seq });
    await this.client.next((m) => m.type === 'welcome');
  }

  async input(axes: { x: number; z: number }, interact: boolean, buttons?: Record<string, boolean>): Promise<void> {
    this.seq += 1;
    const seq = this.seq;
    this.client.send(buttons ? { type: 'input', seq, axes, interact, buttons } : { type: 'input', seq, axes, interact });
    await waitFor(() => this.player.lastInputSeq >= seq, `input ${seq}`);
  }

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

function expectFiniteObjective(server: BeetleServer): void {
  const o = objective(server);
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number') expect(Number.isFinite(v), `${k} is ${v}`).toBe(true);
    if (k === 'holdSec') for (const [id, sec] of Object.entries(v as Record<string, number>)) expect(Number.isFinite(sec), `holdSec[${id}]`).toBe(true);
  }
}

const HAZARD_RISE = { afterSec: 5, metersPerSec: 0.5, maxElevation: -0.6 };

function trialSpec(timeLimitSec: number): WorldSpec {
  const base = fixtureWorld('trial5');
  return { ...base, mode: { ...(base.mode ?? {}), kind: 'time_trial', timeLimitSec } };
}
function hillSpec(holdSeconds: number): WorldSpec {
  return { ...fixtureWorld('hill4'), mode: { kind: 'king_of_the_hill', holdSeconds } };
}
function raceSpec(): WorldSpec {
  return { ...fixtureWorld('race5'), mode: { kind: 'checkpoint_race' } };
}
function survivalSpec(): WorldSpec {
  const base = fixtureWorld('survival5');
  return { ...base, mode: { kind: 'survival' }, hazard: { ...base.hazard, planeElevation: -2.5, rise: HAZARD_RISE } };
}

// ---------------------------------------------------------------------------------------------

describe('time_trial (adversarial)', () => {
  it('the timer does not start on join, on ticks or on a reconnect; only the first input starts it', async () => {
    const h = await makeServer({ startWorld: trialSpec(20) });
    const { server } = h;
    const pad = await Pad.join(h, 0);
    server.tick(60);
    expect(objective(server)).toMatchObject({ kind: 'time_trial', remainingSec: 20, lost: false });
    await pad.reconnect(); // hello is not an input
    server.tick(60);
    expect(objective(server).remainingSec).toBe(20);
    expect(server.events.recent(50, (e) => e.name === 'objective.started')).toHaveLength(0);
    await pad.input({ x: 0, z: 0 }, false);
    server.tick(30);
    expect(objective(server).remainingSec).toBeCloseTo(19, 0);
    expect(server.events.recent(50, (e) => e.name === 'objective.started')).toHaveLength(1);
    await pad.close();
  });

  it('after expiry a reconnected controller still cannot collect, and the lost state survives a restart', async () => {
    const h = await makeServer(); // garden5; the committed set_mode is what the world snapshot restores on restart
    const { server } = h;
    const pad = await Pad.join(h, 0);
    const patched = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 20 } }]);
    expect(patched.ok).toBe(true);
    const spec = server.world.current!.spec;
    await pad.input({ x: 0, z: 0 }, false);
    tickUntil(server, () => objective(server).lost === true, 700, 'expiry');
    await pad.reconnect();
    server.tick(2);
    expect(objective(server)).toMatchObject({ lost: true, remainingSec: 0 });
    await pad.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).collectedRelicIds).toEqual([]);
    expect(state(server).score).toBe(0);

    server.tick(170); // session snapshot written
    await pad.close();
    await server.stop();
    const saved = JSON.parse(readFileSync(path.join(h.dataDir, 'snapshots', 'session.json'), 'utf8')) as SessionState;
    expect(saved.objective).toMatchObject({ kind: 'time_trial', lost: true, remainingSec: 0 });

    const r = await makeServer({ dataDir: h.dataDir, loadSnapshot: true, startWorld: undefined });
    r.server.tick();
    expect(objective(r.server)).toMatchObject({ kind: 'time_trial', lost: true, remainingSec: 0 });
    const again = await Pad.join(r, 0);
    await again.collectAt(relicPos(r.server, spec.relics[0].id));
    expect(state(r.server).collectedRelicIds).toEqual([]);
    expect(objective(r.server).remainingSec).toBe(0);
    await again.close();
  });

  it('a set_mode back to relic_hunt clears lost and re-enables pickups and the win; undo restores the trial', async () => {
    const h = await makeServer({ startWorld: trialSpec(20) });
    const { server } = h;
    const spec = server.world.current!.spec;
    const pad = await Pad.join(h, 0);
    await pad.input({ x: 0, z: 0 }, false);
    tickUntil(server, () => objective(server).lost === true, 700, 'expiry');

    const back = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'relic_hunt' } }], 'back to relic hunt');
    expect(back.ok, JSON.stringify(back)).toBe(true);
    expect(objective(server)).toEqual({ kind: 'relic_hunt', relicsRequired: 3 });
    for (const relic of spec.relics) await pad.collectAt(relicPos(server, relic.id));
    expect(state(server).collectedRelicIds).toHaveLength(3);
    expect(state(server).gateUnlocked).toBe(true);
    const gate = gatePos(server);
    setPosition(server, pad.playerId, gate.x, gate.z);
    server.tick(2);
    expect(state(server).won).toBe(true);
    expect(state(server).score).toBe(3 * SCORING.relic + SCORING.win);

    // Undo of the set_mode: the previous mode comes back as a fresh runtime (clock at the full limit, not lost).
    // Documented: a player standing inside the gate block radius makes undo refuse with PLAYER_CUT_OFF (the live
    // check assumes a locked gate), so the player steps off first.
    const spawn = server.sim.spawnFor(0).pos;
    setPosition(server, pad.playerId, spawn.x, spawn.z);
    server.tick();
    const undone = await undo(server);
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    expect(server.world.current!.spec.mode).toEqual(spec.mode);
    expect(objective(server)).toMatchObject({ kind: 'time_trial', lost: false, relicsRequired: 3 });
    expect(objective(server).remainingSec).toBeGreaterThan(19);
    expect(state(server).collectedRelicIds).toHaveLength(3); // relics and score stay across the undo
    expect(state(server).score).toBe(3 * SCORING.relic + SCORING.win);
    // Documented: `won` is session state and survives a set_mode/undo like the score, so the timer stays parked at
    // the full limit and no second win is possible until a new world is committed.
    expect(state(server).won).toBe(true);
    await pad.input({ x: 0, z: 0 }, false);
    server.tick(30);
    expect(objective(server).remainingSec).toBe(20);
    expect(server.events.recent(100, (e) => e.name === 'session.won')).toHaveLength(1);
    await pad.close();
  });

  it('undo of a set_mode restores the previous mode behaviour (relic_hunt has no clock)', async () => {
    const h = await makeServer();
    const { server } = h;
    const pad = await Pad.join(h, 0);
    const patched = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 20 } }]);
    expect(patched.ok).toBe(true);
    await pad.input({ x: 0, z: 0 }, false);
    tickUntil(server, () => objective(server).lost === true, 700, 'expiry');
    const undone = await undo(server);
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    expect(server.world.version).toBe(3);
    expect(objective(server)).toEqual({ kind: 'relic_hunt', relicsRequired: 3 });
    server.tick(100);
    expect(objective(server).remainingSec).toBeUndefined();
    await pad.collectAt(relicPos(server, 'relic-east'));
    expect(state(server).collectedRelicIds).toEqual(['relic-east']);
    await pad.close();
  });

  it('a set_mode that restates the same mode restarts the clock (the patch, not the diff, resets the runtime)', async () => {
    const h = await makeServer({ startWorld: trialSpec(20) });
    const { server } = h;
    const spec = server.world.current!.spec;
    const pad = await Pad.join(h, 0);
    await pad.input({ x: 0, z: 0 }, false);
    tickUntil(server, () => objective(server).lost === true, 700, 'expiry');
    const same = await commitPatch(server, [{ op: 'set_mode', mode: { ...spec.mode! } }], 'restart');
    expect(same.ok, JSON.stringify(same)).toBe(true);
    expect(objective(server).lost).toBe(false);
    expect(objective(server).remainingSec).toBeGreaterThan(19);
    await pad.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).collectedRelicIds).toEqual([spec.relics[0].id]);
    await pad.close();
  });

  it('timer state survives a snapshot restart mid-run and keeps counting from where it was', async () => {
    const h = await makeServer();
    const { server } = h;
    const pad = await Pad.join(h, 0);
    const patched = await commitPatch(server, [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 30 } }]);
    expect(patched.ok).toBe(true);
    await pad.input({ x: 0, z: 0 }, false);
    server.tick(160); // ~5.3 s: a snapshot is written at the 5 s mark
    const before = objective(server).remainingSec!;
    await pad.close();
    await server.stop();
    const r = await makeServer({ dataDir: h.dataDir, loadSnapshot: true, startWorld: undefined });
    r.server.tick();
    expectFiniteObjective(r.server);
    const restored = objective(r.server);
    expect(restored.kind).toBe('time_trial');
    expect(restored.lost).toBe(false);
    expect(restored.remainingSec).toBeLessThanOrEqual(30);
    expect(Math.abs(restored.remainingSec! - before)).toBeLessThan(0.5);
    let last = restored.remainingSec!;
    for (let i = 0; i < 60; i += 1) {
      r.server.tick();
      expect(objective(r.server).remainingSec).toBeLessThanOrEqual(last);
      last = objective(r.server).remainingSec!;
    }
    expect(last).toBeLessThan(restored.remainingSec!);
  });
});

describe('king_of_the_hill (adversarial)', () => {
  it('two players on the hill accumulate independently; leaving or falling keeps the hold (it never resets)', async () => {
    const h = await makeServer({ startWorld: hillSpec(10) });
    const { server } = h;
    const p0 = await Pad.join(h, 0);
    const p1 = await Pad.join(h, 1);
    const gate = gatePos(server);
    setPosition(server, p0.playerId, gate.x, gate.z);
    setPosition(server, p1.playerId, gate.x + 0.5, gate.z);
    server.tick(30);
    expect(objective(server).holdSec![p0.playerId]).toBeCloseTo(1, 1);
    expect(objective(server).holdSec![p1.playerId]).toBeCloseTo(1, 1);

    // p0 walks off the hill: p0's hold freezes, p1's keeps growing.
    const spawn = server.sim.spawnFor(0).pos;
    setPosition(server, p0.playerId, spawn.x, spawn.z);
    server.tick(15);
    expect(objective(server).holdSec![p0.playerId]).toBeCloseTo(1, 1);
    expect(objective(server).holdSec![p1.playerId]).toBeCloseTo(1.5, 1);

    // p0 falls into the hazard and respawns: the hold is kept (documented behaviour: hold never resets mid-round).
    setPosition(server, p0.playerId, 59, 59);
    tickUntil(server, () => p0.player.status === 'falling', 5, 'fall');
    tickUntil(server, () => p0.player.status === 'active', 80, 'respawn');
    expect(p0.player.respawns).toBe(1);
    expect(objective(server).holdSec![p0.playerId]).toBeCloseTo(1, 1);
    // hold never decreases within a hold
    setPosition(server, p0.playerId, gate.x, gate.z);
    let last = objective(server).holdSec![p0.playerId];
    for (let i = 0; i < 30; i += 1) {
      server.tick();
      const now = objective(server).holdSec![p0.playerId];
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBeCloseTo(2, 1);
    await p0.close();
    await p1.close();
  });

  it('a tie on the same tick awards the win once to slot 0; relics still score 10 each', async () => {
    const h = await makeServer({ startWorld: hillSpec(3) });
    const { server } = h;
    const spec = server.world.current!.spec;
    const p0 = await Pad.join(h, 0);
    const p1 = await Pad.join(h, 1);
    await p1.collectAt(relicPos(server, spec.relics[0].id));
    expect(state(server).score).toBe(SCORING.relic);
    const gate = gatePos(server);
    setPosition(server, p0.playerId, gate.x, gate.z);
    setPosition(server, p1.playerId, gate.x, gate.z);
    tickUntil(server, () => state(server).won, 120, 'hill win');
    server.tick(30);
    const wins = server.events.recent(200, (e) => e.name === 'session.won');
    expect(wins).toHaveLength(1);
    expect(wins[0]?.data?.playerId).toBe(p0.playerId);
    expect(state(server).score).toBe(SCORING.relic + SCORING.win);
    expect(objective(server).holdSec![p0.playerId]).toBeGreaterThanOrEqual(3);
    expect(objective(server).holdSec![p1.playerId]).toBeGreaterThanOrEqual(2.9);
    // relics still award after the win
    await p0.collectAt(relicPos(server, spec.relics[1].id));
    expect(state(server).score).toBe(2 * SCORING.relic + SCORING.win);
    await p0.close();
    await p1.close();
  });
});

describe('checkpoint_race (adversarial)', () => {
  it('two players pressing on the same checkpoint in one tick award it once', async () => {
    const h = await makeServer({ startWorld: raceSpec() });
    const { server } = h;
    const order = server.world.current!.spec.relics.map((r) => r.id);
    const p0 = await Pad.join(h, 0);
    const p1 = await Pad.join(h, 1);
    const pos = relicPos(server, order[0]);
    setPosition(server, p0.playerId, pos.x, pos.z);
    setPosition(server, p1.playerId, pos.x, pos.z);
    await p0.input({ x: 0, z: 0 }, true);
    await p1.input({ x: 0, z: 0 }, true);
    server.tick();
    expect(state(server).collectedRelicIds).toEqual([order[0]]);
    expect(state(server).score).toBe(SCORING.relic);
    expect(state(server).relicTombstones[order[0]]?.byPlayerId).toBe(p0.playerId);
    expect(objective(server).nextCheckpointId).toBe(order[1]);
    expect(server.events.recent(50, (e) => e.name === 'relic.collected')).toHaveLength(1);
    await p0.close();
    await p1.close();
  });

  it('a move_relic patch during the race keeps the order; all checkpoints open the gate and reaching it wins', async () => {
    const h = await makeServer({ startWorld: raceSpec() });
    const { server } = h;
    const spec = server.world.current!.spec;
    const order = spec.relics.map((r) => r.id);
    const pad = await Pad.join(h, 0);
    await pad.collectAt(relicPos(server, order[0]));
    expect(objective(server).nextCheckpointId).toBe(order[1]);

    const last = spec.relics.find((r) => r.id === order[2])!;
    const moved = await commitPatch(server, [{ op: 'move_relic', id: last.id, islandId: last.supportingSurfaceId, localPosition: { x: last.localPosition.x + 0.8, z: last.localPosition.z } }], 'nudge the last checkpoint');
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    expect(server.world.current!.spec.relics.map((r) => r.id)).toEqual(order);
    expect(objective(server)).toMatchObject({ kind: 'checkpoint_race', nextCheckpointId: order[1] });
    expect(state(server).collectedRelicIds).toEqual([order[0]]);

    await pad.collectAt(relicPos(server, order[2])); // moved, but still out of order
    expect(state(server).collectedRelicIds).toEqual([order[0]]);
    await pad.collectAt(relicPos(server, order[1]));
    expect(objective(server).nextCheckpointId).toBe(order[2]);
    await pad.collectAt(relicPos(server, order[2]));
    expect(objective(server).nextCheckpointId).toBeNull();
    expect(state(server).gateUnlocked).toBe(true);
    const gate = gatePos(server);
    setPosition(server, pad.playerId, gate.x, gate.z);
    server.tick(2);
    expect(state(server).won).toBe(true);
    expect(server.events.recent(100, (e) => e.name === 'session.won')).toHaveLength(1);
    await pad.close();
  });
});

describe('survival (adversarial)', () => {
  it('the plane never exceeds maxElevation, bridges submerge exactly past -1.0, islands stay safe', async () => {
    const h = await makeServer({ startWorld: survivalSpec() });
    const { server } = h;
    const spec = server.world.current!.spec;
    const p0 = await Pad.join(h, 0);
    const p1 = await Pad.join(h, 1);
    const bridge = spec.bridges[0];
    const mid = { x: (bridge.endpoints[0].point.x + bridge.endpoints[1].point.x) / 2, z: (bridge.endpoints[0].point.z + bridge.endpoints[1].point.z) / 2 };
    setPosition(server, p0.playerId, mid.x, mid.z);
    const spawn = server.sim.spawnFor(1).pos;
    setPosition(server, p1.playerId, spawn.x, spawn.z);
    await p0.input({ x: 0, z: 0 }, false);
    await p1.input({ x: 0, z: 0 }, false);

    let previous = objective(server).hazardElevation!;
    let submergedAt: number | null = null;
    for (let i = 0; i < 400; i += 1) {
      server.tick();
      expectFiniteObjective(server);
      const e = objective(server).hazardElevation!;
      expect(e).toBeLessThanOrEqual(HAZARD_RISE.maxElevation);
      expect(e).toBeGreaterThanOrEqual(previous);
      previous = e;
      const events = server.events.recent(500, (ev) => ev.name === 'hazard.bridges' && ev.data?.submerged === true);
      if (submergedAt === null && events.length > 0) {
        submergedAt = i;
        expect(e).toBeGreaterThan(SUBMERGE_PLANE_ELEVATION);
        expect(events).toHaveLength(1);
      } else if (submergedAt === null) {
        expect(e).toBeLessThanOrEqual(SUBMERGE_PLANE_ELEVATION);
        expect(p0.player.status).toBe('active');
      }
      expect(p1.player.supportId).not.toBeNull(); // the island player never loses support
      expect(p1.player.respawns).toBe(0);
    }
    expect(submergedAt).not.toBeNull();
    expect(objective(server).hazardElevation).toBe(HAZARD_RISE.maxElevation);
    expect(p0.player.respawns).toBe(1);
    expect(server.events.recent(500, (ev) => ev.name === 'hazard.bridges')).toHaveLength(1);
    await p0.close();
    await p1.close();
  });

  it('a new world resets the rise clock; a set_hazard patch keeps the mode and the rise', async () => {
    const h = await makeServer({ startWorld: survivalSpec() });
    const { server } = h;
    const pad = await Pad.join(h, 0);
    await pad.input({ x: 0, z: 0 }, false);
    tickUntil(server, () => objective(server).hazardElevation! > -1.0, 400, 'rise');
    const remainingBefore = objective(server).remainingSec!;

    // set_hazard water during survival: the mode and the rise are untouched; the plane keeps rising from where it is.
    const risen = objective(server).hazardElevation!;
    const hz = await commitPatch(server, [{ op: 'set_hazard', kind: 'water' }], 'water');
    expect(hz.ok, JSON.stringify(hz)).toBe(true);
    expect(server.world.current!.spec.hazard.kind).toBe('water');
    expect(server.world.current!.spec.hazard.rise).toEqual(HAZARD_RISE);
    expect(objective(server).kind).toBe('survival');
    expect(objective(server).hazardElevation).toBeGreaterThanOrEqual(risen);
    expect(objective(server).remainingSec).toBeLessThanOrEqual(remainingBefore);
    server.tick(10);
    expect(objective(server).hazardElevation).toBeGreaterThan(risen);
    expect(server.events.recent(500, (ev) => ev.name === 'hazard.bridges')).toHaveLength(1); // bridges stay submerged

    const fresh = await commitWorld(server, { ...survivalSpec(), worldId: 'survival5-b', title: 'Survival B' });
    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expect(objective(server)).toMatchObject({ kind: 'survival', hazardElevation: -2.5, lost: false, remainingSec: 120 });
    server.tick(30); // no fresh input since the commit: the new clock has not started
    expect(objective(server).remainingSec).toBe(120);
    await pad.input({ x: 0, z: 0 }, false);
    server.tick(100); // the clock runs again; still before afterSec
    expect(objective(server).hazardElevation).toBe(-2.5);
    expect(objective(server).remainingSec).toBeLessThan(120);
    expect(objective(server).remainingSec).toBeGreaterThan(116);
    await pad.close();
  });
});

describe('buttons (adversarial)', () => {
  it('sprint ~1.35x, slow ~0.5x, both = sprint; unknown button keys are rejected without a disconnect', async () => {
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
    const base = await run();
    expect(base).toBeCloseTo((GEOMETRY.playerSpeed * 10 * TICK_MS) / 1000, 1);
    expect((await run({ sprint: true })) / base).toBeCloseTo(MOVEMENT_SCALES.sprint, 2);
    expect((await run({ slow: true })) / base).toBeCloseTo(MOVEMENT_SCALES.slow, 2);
    expect((await run({ sprint: true, slow: true })) / base).toBeCloseTo(MOVEMENT_SCALES.sprint, 2);

    pad.client.send({ type: 'input', seq: 500, axes: { x: 0, z: 0 }, interact: false, buttons: { sprint: true, jump: true } });
    const err = await pad.client.next((m) => m.type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });
    expect(pad.player.lastInputSeq).toBeLessThan(500);
    expect(pad.client.isOpen()).toBe(true);
    await pad.input({ x: 0, z: 1 }, false, { sprint: true }); // the socket still works
    expect(pad.player.lastInputSeq).toBe(pad.seq);
    expect(pad.player.connected).toBe(true);
    await pad.close();
  });

  it('ping markers go to displays only, once per second per player (two players may ping in the same tick), in the player colour; emote waves 1.5 s', async () => {
    const h = await makeServer();
    const { server } = h;
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    await display.next((m) => m.type === 'welcome');
    const p0 = await Pad.join(h, 0);
    const p1 = await Pad.join(h, 1);
    server.tick();
    await p0.input({ x: 0, z: 0 }, false, { ping: true });
    await p1.input({ x: 0, z: 0 }, false, { ping: true });
    server.tick();
    const m0 = (await display.next((m) => m.type === 'marker' && (m as MarkerMessage).playerId === p0.playerId)) as MarkerMessage;
    const m1 = (await display.next((m) => m.type === 'marker' && (m as MarkerMessage).playerId === p1.playerId)) as MarkerMessage;
    expect(m0.color).toBe(PLAYER_COLORS[0]);
    expect(m1.color).toBe(PLAYER_COLORS[1]);
    await expect(p0.client.next((m) => m.type === 'marker', 100)).rejects.toThrow();
    await expect(p1.client.next((m) => m.type === 'marker', 100)).rejects.toThrow();

    // Re-pressing inside one second is dropped per player; p1's limit does not affect p0.
    await p0.input({ x: 0, z: 0 }, false, { ping: false });
    server.tick();
    await p0.input({ x: 0, z: 0 }, false, { ping: true });
    server.tick();
    expect(server.events.recent(50, (e) => e.name === 'player.ping')).toHaveLength(2);
    await p0.input({ x: 0, z: 0 }, false, { ping: false });
    server.tick(30);
    await p0.input({ x: 0, z: 0 }, false, { ping: true });
    server.tick();
    expect(server.events.recent(50, (e) => e.name === 'player.ping' && e.data?.playerId === p0.playerId)).toHaveLength(2);
    expect(server.events.recent(50, (e) => e.name === 'player.ping' && e.data?.playerId === p1.playerId)).toHaveLength(1);

    await p1.input({ x: 0, z: 0 }, false, { emote: true });
    server.tick();
    expect(server.sim.playerViews()[1].emote).toBe('wave');
    expect(server.sim.playerViews()[0].emote).toBeNull();
    server.tick(44); // 1.47 s
    expect(server.sim.playerViews()[1].emote).toBe('wave');
    server.tick(2);
    expect(server.sim.playerViews()[1].emote).toBeNull();
    await p0.close();
    await p1.close();
    await display.close();
  });
});

describe('objective field (adversarial)', () => {
  it('is finite in every mode, remainingSec never increases while running and holdSec never decreases', async () => {
    for (const spec of [trialSpec(20), hillSpec(5), raceSpec(), survivalSpec(), fixtureWorld('garden5')]) {
      const h = await makeServer({ startWorld: spec });
      const { server } = h;
      const pad = await Pad.join(h, 0);
      await pad.input({ x: 0, z: 0 }, false);
      const gate = gatePos(server);
      setPosition(server, pad.playerId, gate.x, gate.z);
      let remaining = Number.POSITIVE_INFINITY;
      let hold = 0;
      for (let i = 0; i < 90; i += 1) {
        server.tick();
        expectFiniteObjective(server);
        const o = objective(server);
        if (o.remainingSec !== undefined) {
          expect(o.remainingSec).toBeLessThanOrEqual(remaining);
          remaining = o.remainingSec;
        }
        if (o.holdSec) {
          expect(o.holdSec[pad.playerId]).toBeGreaterThanOrEqual(hold);
          hold = o.holdSec[pad.playerId];
        }
        const tick = server.sim.buildTickMessage(h.clock.now()) as TickMessage;
        expect(JSON.stringify(tick.objective)).not.toContain('NaN');
      }
      await pad.close();
      await server.stop();
      harnesses.splice(harnesses.indexOf(h), 1);
      rmSync(h.dataDir, { recursive: true, force: true });
    }
  });
});
