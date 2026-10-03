// Pad relay: accepted controller inputs reach display and director sockets as PadMessages, with no world loaded.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ROUTES, type PadMessage, type ServerMessage } from '@beetle/contracts';
import { createBeetleServer, createFakeClock, type BeetleServer } from './index.ts';
import { PAD_RELAY_MAX_PER_SEC } from './ws.ts';

const DIRECTOR = 'd1rector-token-for-padrelay-0123456789';
const AGENT = 'agent-token-for-padrelay-0123456789abcd';

type Harness = { server: BeetleServer; dataDir: string; clock: ReturnType<typeof createFakeClock>; port: number };
const harnesses: Harness[] = [];
const clients: WsClient[] = [];

async function makeServer(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'beetle-padrelay-test-'));
  const clock = createFakeClock(1_750_000_000_000);
  const server = await createBeetleServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    publicUrl: 'http://127.0.0.1:7700',
    directorToken: DIRECTOR,
    agentToken: AGENT,
    startWorld: 'none',
    loadSnapshot: false,
    tickMode: 'manual',
    clock,
    ollamaBaseUrl: 'http://127.0.0.1:1',
    webDistDir: null,
    logRequests: false,
  });
  const info = await server.start();
  const h = { server, dataDir, clock, port: info.port };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const h of harnesses.splice(0)) {
    await h.server.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  }
});

async function api(server: BeetleServer, method: 'GET' | 'POST', url: string, opts: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await server.app.inject({ method, url, headers, payload: opts.body === undefined ? undefined : JSON.stringify(opts.body), remoteAddress: '127.0.0.1' });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

async function joinPlayer(server: BeetleServer, slot: 0 | 1) {
  const invite = await api(server, 'POST', ROUTES.directorInvite, { body: { slot }, token: DIRECTOR });
  expect(invite.status, JSON.stringify(invite.json)).toBe(200);
  const join = await api(server, 'POST', ROUTES.join, { body: { inviteCode: invite.json.inviteCode } });
  expect(join.status, JSON.stringify(join.json)).toBe(200);
  return join.json as { controllerToken: string; playerId: string; slot: 0 | 1 };
}

type WsClient = {
  ws: WebSocket;
  received: ServerMessage[];
  send(msg: unknown): void;
  next(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
};

function connectWs(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${ROUTES.ws}`);
    const received: ServerMessage[] = [];
    let cursor = 0;
    const waiters: (() => void)[] = [];
    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as ServerMessage);
      for (const w of waiters.splice(0)) w();
    });
    ws.on('error', reject);
    ws.on('open', () => {
      const client: WsClient = {
        ws,
        received,
        send: (msg) => ws.send(JSON.stringify(msg)),
        next: (predicate, timeoutMs = 3000) => new Promise<ServerMessage>((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for a websocket message')), timeoutMs);
          const check = () => {
            while (cursor < received.length) {
              const m = received[cursor++];
              if (predicate(m)) { clearTimeout(timer); res(m); return; }
            }
            waiters.push(check);
          };
          check();
        }),
        close: () => new Promise<void>((res) => {
          if (ws.readyState === WebSocket.CLOSED) return res();
          ws.once('close', () => res());
          ws.close();
        }),
      };
      clients.push(client);
      resolve(client);
    });
  });
}

const isPad = (m: ServerMessage): m is PadMessage => m.type === 'pad';
const NONE = { sprint: false, slow: false, ping: false, emote: false };

/** Round-trips a ping on the socket so every earlier message from it has been handled by the server. */
async function flush(c: WsClient): Promise<void> {
  const t = Math.floor(Math.random() * 1e9);
  c.send({ type: 'ping', t });
  await c.next((m) => m.type === 'pong' && m.t === t);
}

describe('pad relay with no world', () => {
  it('relays accepted inputs to display and director, zeroes on release and disconnect, and throttles', async () => {
    const h = await makeServer();
    const health = await api(h.server, 'GET', ROUTES.health);
    expect(health.json.hasWorld).toBe(false);

    const joined = await joinPlayer(h.server, 1);
    expect(joined.slot).toBe(1);

    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    expect((await display.next((m) => m.type === 'welcome')).type).toBe('welcome');
    const director = await connectWs(h.port);
    director.send({ type: 'hello', role: 'director', token: DIRECTOR });
    expect((await director.next((m) => m.type === 'welcome')).type).toBe('welcome');

    const controller = await connectWs(h.port);
    controller.send({ type: 'hello', role: 'controller', token: joined.controllerToken });
    const welcome = await controller.next((m) => m.type === 'welcome');
    expect(welcome).toMatchObject({ role: 'controller', playerId: joined.playerId, worldVersion: 0 });

    // A moving pad reaches both screens with the player's slot and axes.
    controller.send({ type: 'input', seq: 1, axes: { x: 0.5, z: -1 }, interact: false, buttons: { sprint: true } });
    for (const screen of [display, director]) {
      const pad = await screen.next(isPad) as PadMessage;
      expect(pad).toEqual({ type: 'pad', playerId: joined.playerId, slot: 1, seq: 1, axes: { x: 0.5, z: -1 }, interact: false, buttons: { ...NONE, sprint: true } });
    }
    // Input is accepted even though there is no 3D world.
    expect(h.server.session.player(joined.playerId)!.lastInputSeq).toBe(1);

    // Stale seq is not relayed; release (zero axes, buttons up) is.
    controller.send({ type: 'input', seq: 1, axes: { x: 1, z: 1 }, interact: false });
    controller.send({ type: 'input', seq: 2, axes: { x: 0, z: 0 }, interact: false });
    const release = await display.next(isPad) as PadMessage;
    expect(release).toMatchObject({ seq: 2, slot: 1, axes: { x: 0, z: 0 }, buttons: NONE });

    // Throttle: within one second at most PAD_RELAY_MAX_PER_SEC pads go out per player; extras are dropped,
    // but zero axes and button changes always go out.
    h.clock.advance(1500);
    const before = display.received.filter(isPad).length;
    let seq = 3;
    for (let i = 0; i < 50; i++) controller.send({ type: 'input', seq: seq++, axes: { x: 0.25, z: 0.5 }, interact: false });
    await flush(controller);
    controller.send({ type: 'input', seq: seq++, axes: { x: 0.25, z: 0.5 }, interact: true });
    controller.send({ type: 'input', seq: seq++, axes: { x: 0, z: 0 }, interact: false });
    await flush(controller);
    await flush(display);
    const burst = display.received.filter(isPad).slice(before);
    const moving = burst.filter((p) => p.axes.x === 0.25 && !p.interact);
    expect(moving.length).toBe(PAD_RELAY_MAX_PER_SEC);
    expect(burst.at(-2)).toMatchObject({ axes: { x: 0.25, z: 0.5 }, interact: true });
    expect(burst.at(-1)).toMatchObject({ axes: { x: 0, z: 0 }, interact: false, seq: seq - 1 });
    expect(burst.length).toBe(PAD_RELAY_MAX_PER_SEC + 2);

    // A new second opens a new window.
    h.clock.advance(1000);
    controller.send({ type: 'input', seq: seq++, axes: { x: -1, z: 0 }, interact: false });
    expect(await display.next(isPad)).toMatchObject({ axes: { x: -1, z: 0 } });
    await director.next((m) => isPad(m) && m.axes.x === -1);

    // Disconnect sends one zeroed pad.
    await controller.close();
    for (const screen of [display, director]) {
      const zero = await screen.next(isPad) as PadMessage;
      expect(zero).toMatchObject({ playerId: joined.playerId, slot: 1, axes: { x: 0, z: 0 }, interact: false, buttons: NONE });
    }
    await flush(display);
    expect(display.received.filter((m) => isPad(m) && m.axes.x === 0 && m.axes.z === 0 && m.seq === seq - 1).length).toBe(1);
  });

  it('does not relay input to controllers and rejects input from displays', async () => {
    const h = await makeServer();
    const a = await joinPlayer(h.server, 0);
    const b = await joinPlayer(h.server, 1);
    const ca = await connectWs(h.port);
    ca.send({ type: 'hello', role: 'controller', token: a.controllerToken });
    await ca.next((m) => m.type === 'welcome');
    const cb = await connectWs(h.port);
    cb.send({ type: 'hello', role: 'controller', token: b.controllerToken });
    await cb.next((m) => m.type === 'welcome');
    const display = await connectWs(h.port);
    display.send({ type: 'hello', role: 'display' });
    await display.next((m) => m.type === 'welcome');

    ca.send({ type: 'input', seq: 1, axes: { x: 1, z: 0 }, interact: false });
    expect(await display.next(isPad)).toMatchObject({ slot: 0, playerId: a.playerId, axes: { x: 1, z: 0 } });
    display.send({ type: 'input', seq: 5, axes: { x: 1, z: 0 }, interact: false });
    expect(await display.next((m) => m.type === 'error')).toMatchObject({ code: 'NOT_A_CONTROLLER' });
    await flush(ca);
    await flush(cb);
    expect(ca.received.some(isPad)).toBe(false);
    expect(cb.received.some(isPad)).toBe(false);
  });
});
