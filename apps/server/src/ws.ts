// WebSocket hub: ws 8 WebSocketServer in noServer mode on the Fastify HTTP server's upgrade event.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ClientMessageSchema, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ROUTES, SIMULATION,
  type ActivityMessage, type AgentActivity, type ClientMessage, type ControllerStatusMessage, type ErrorMessage,
  type PongMessage, type ServerMessage, type TickMessage, type WelcomeMessage, type WorldMessage,
} from '@beetle/contracts';
import { safeEqual } from './auth.ts';
import type { ServerContext } from './context.ts';

export const HELLO_TIMEOUT_MS = 3000;
export const CONTROLLER_STATUS_EVERY_MS = 2000;
export const ACTIVITY_SNAPSHOT_SIZE = 50;

export type SocketRole = 'controller' | 'display' | 'director';

export type Conn = {
  id: number;
  ws: WebSocket;
  role: SocketRole | null;
  playerId: string | null;
  ackedVersion: number | null;
  helloTimer: NodeJS.Timeout | null;
  remoteAddress: string;
  connectedAt: number;
  errorsSent: number;
};

export type WsHub = {
  attach(server: HttpServer): void;
  broadcastTick(message: TickMessage): void;
  broadcastWorld(message: WorldMessage): void;
  broadcastActivity(entries: AgentActivity[]): void;
  broadcastControllers(): void;
  counts(): { controllers: number; displays: number; directors: number; pending: number; total: number };
  readonly connections: Set<Conn>;
  closeAll(): void;
};

type HubContext = Pick<ServerContext, 'session' | 'world' | 'sim' | 'requests' | 'clock' | 'events' | 'secrets' | 'publicUrl' | 'placeAtSpawn'>;

export function createWsHub(ctx: HubContext): WsHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES * 4 });
  const connections = new Set<Conn>();
  let nextId = 1;
  let lastControllersAt = 0;

  function send(conn: Conn, message: ServerMessage | string): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    } catch {
      /* a failing socket closes itself */
    }
  }

  function sendError(conn: Conn, code: string, message: string): void {
    conn.errorsSent += 1;
    if (conn.errorsSent > 50) return;
    const err: ErrorMessage = { type: 'error', code, message };
    send(conn, err);
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const host = (req.headers.host ?? '').toLowerCase();
    if (originHost && originHost === host) return true;
    try {
      const pub = new URL(ctx.publicUrl());
      if (originHost === pub.host.toLowerCase()) return true;
    } catch {
      /* no public URL host */
    }
    return false;
  }

  function controllersMessage(): ControllerStatusMessage {
    const now = ctx.clock.now();
    return {
      type: 'controllers',
      players: ctx.session.playersInSlotOrder().map((p) => ({
        id: p.id,
        label: p.label,
        connected: p.connected,
        lastInputAgeMs: p.connected && p.lastInputAtMs > 0 ? Math.max(0, now - p.lastInputAtMs) : null,
      })),
    };
  }

  function broadcastControllers(): void {
    lastControllersAt = ctx.clock.now();
    const json = JSON.stringify(controllersMessage());
    for (const conn of connections) {
      if (conn.role === 'display' || conn.role === 'director') send(conn, json);
    }
  }

  function welcome(conn: Conn, role: SocketRole): void {
    const state = ctx.session.state;
    const msg: WelcomeMessage = {
      type: 'welcome',
      role,
      protocolVersion: PROTOCOL_VERSION,
      worldVersion: ctx.world.version,
      tick: state.tick,
      tickHz: SIMULATION.tickHz,
    };
    if (conn.playerId) {
      const player = ctx.session.player(conn.playerId);
      if (player) {
        msg.playerId = player.id;
        msg.playerLabel = player.label;
        msg.playerColor = player.color;
      }
    }
    send(conn, msg);
  }

  function sendSnapshot(conn: Conn): void {
    const world = ctx.sim.worldMessage('snapshot');
    if (world) send(conn, world);
    const entries = ctx.requests.recentActivity(ACTIVITY_SNAPSHOT_SIZE);
    const activity: ActivityMessage = { type: 'activity', entries };
    send(conn, activity);
    send(conn, controllersMessage());
  }

  function bindController(conn: Conn, token: string): void {
    const player = ctx.session.playerForToken(token);
    if (!player) {
      sendError(conn, 'AUTH', 'unknown controller token');
      conn.ws.close(4001, 'unknown controller token');
      return;
    }
    const now = ctx.clock.now();
    for (const other of connections) {
      if (other !== conn && other.playerId === player.id) {
        other.playerId = null;
        other.role = null;
        try { other.ws.close(4002, 'replaced by a newer controller'); } catch { /* ignore */ }
      }
    }
    conn.role = 'controller';
    conn.playerId = player.id;
    const wasConnected = player.connected;
    ctx.session.markConnected(player, now);
    if (player.supportId === null && player.status !== 'falling') ctx.placeAtSpawn(player.id);
    ctx.events.emit({ name: 'player.join', sessionId: ctx.session.state.sessionId, worldVersion: ctx.world.version, data: { playerId: player.id, slot: player.slot, reconnect: wasConnected, remote: conn.remoteAddress } });
    welcome(conn, 'controller');
    broadcastControllers();
  }

  function handleHello(conn: Conn, msg: Extract<ClientMessage, { type: 'hello' }>): void {
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    if (conn.role) {
      sendError(conn, 'ALREADY_HELLO', 'hello already received');
      return;
    }
    if (msg.role === 'controller') {
      bindController(conn, msg.token);
      return;
    }
    if (msg.role === 'director') {
      if (!safeEqual(msg.token, ctx.secrets.directorToken)) {
        sendError(conn, 'AUTH', 'director token rejected');
        conn.ws.close(4001, 'director token rejected');
        return;
      }
      conn.role = 'director';
      welcome(conn, 'director');
      sendSnapshot(conn);
      return;
    }
    conn.role = 'display';
    conn.ackedVersion = msg.worldVersion ?? null;
    welcome(conn, 'display');
    sendSnapshot(conn);
  }

  function handleInput(conn: Conn, msg: Extract<ClientMessage, { type: 'input' }>): void {
    if (conn.role !== 'controller' || !conn.playerId) {
      sendError(conn, 'NOT_A_CONTROLLER', 'input is only accepted from controllers');
      return;
    }
    const player = ctx.session.player(conn.playerId);
    if (!player) return;
    const now = ctx.clock.now();
    const rt = ctx.session.runtimeOf(player, now);
    if (now - rt.windowStartMs >= 1000) {
      rt.windowStartMs = now;
      rt.windowCount = 0;
    }
    rt.windowCount += 1;
    if (rt.windowCount > SIMULATION.inputRateLimitPerSec) {
      rt.droppedInputs += 1;
      return;
    }
    if (msg.seq <= player.lastInputSeq) return;
    player.lastInputSeq = msg.seq;
    player.lastInputAtMs = now;
    rt.axes = { x: clamp(msg.axes.x), z: clamp(msg.axes.z) };
    rt.interact = msg.interact;
  }

  function handleMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    const size = Array.isArray(data) ? data.reduce((n, b) => n + b.byteLength, 0) : data.byteLength;
    if (size > MAX_MESSAGE_BYTES) {
      conn.ws.close(1009, 'message too large');
      return;
    }
    if (isBinary) {
      sendError(conn, 'INVALID_MESSAGE', 'binary frames are not supported');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data));
    } catch {
      sendError(conn, 'INVALID_MESSAGE', 'message is not JSON');
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      sendError(conn, 'INVALID_MESSAGE', 'message does not match the protocol');
      return;
    }
    const msg = result.data;
    if (msg.type === 'hello') {
      handleHello(conn, msg);
      return;
    }
    if (!conn.role) {
      sendError(conn, 'HELLO_REQUIRED', 'send hello first');
      return;
    }
    switch (msg.type) {
      case 'input':
        handleInput(conn, msg);
        return;
      case 'ping': {
        const pong: PongMessage = { type: 'pong', t: msg.t, serverMs: ctx.clock.now() };
        send(conn, pong);
        return;
      }
      case 'ack':
        conn.ackedVersion = msg.worldVersion;
        return;
      case 'resync': {
        const world = ctx.sim.worldMessage('resync');
        if (world) send(conn, world);
        else sendError(conn, 'NO_WORLD', 'no world to resync');
        return;
      }
      default:
        return;
    }
  }

  function onClose(conn: Conn): void {
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    connections.delete(conn);
    if (conn.role === 'controller' && conn.playerId) {
      const player = ctx.session.player(conn.playerId);
      const stillBound = [...connections].some((c) => c !== conn && c.playerId === conn.playerId);
      if (player && !stillBound) {
        ctx.session.markDisconnected(player, ctx.clock.now());
        ctx.events.emit({ name: 'player.leave', sessionId: ctx.session.state.sessionId, worldVersion: ctx.world.version, data: { playerId: player.id, slot: player.slot } });
        broadcastControllers();
      }
    }
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const conn: Conn = {
      id: nextId++,
      ws,
      role: null,
      playerId: null,
      ackedVersion: null,
      helloTimer: null,
      remoteAddress: req.socket.remoteAddress ?? '',
      connectedAt: ctx.clock.now(),
      errorsSent: 0,
    };
    connections.add(conn);
    conn.helloTimer = setTimeout(() => {
      conn.helloTimer = null;
      if (!conn.role) {
        try { ws.close(4000, 'hello timeout'); } catch { /* ignore */ }
      }
    }, HELLO_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => {
      try {
        handleMessage(conn, data, isBinary);
      } catch (err) {
        ctx.events.emit({ name: 'ws.error', outcome: 'fail', data: { message: err instanceof Error ? err.message : String(err) } });
      }
    });
    ws.on('close', () => onClose(conn));
    ws.on('error', () => { /* close follows */ });
  });

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== ROUTES.ws) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      ctx.events.emit({ name: 'ws.origin_rejected', outcome: 'fail', data: { origin: String(req.headers.origin ?? ''), host: String(req.headers.host ?? '') } });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  return {
    connections,
    attach(server: HttpServer) {
      server.on('upgrade', handleUpgrade);
    },
    broadcastTick(message: TickMessage) {
      const json = JSON.stringify(message);
      for (const conn of connections) {
        if (!conn.role) continue;
        if (conn.role === 'controller' && conn.playerId) {
          const player = ctx.session.player(conn.playerId);
          send(conn, { ...message, lastInputSeq: player?.lastInputSeq ?? 0 });
        } else {
          send(conn, json);
        }
      }
      if (message.serverMs - lastControllersAt >= CONTROLLER_STATUS_EVERY_MS) broadcastControllers();
    },
    broadcastWorld(message: WorldMessage) {
      const json = JSON.stringify(message);
      for (const conn of connections) {
        if (conn.role === 'display' || conn.role === 'director') send(conn, json);
      }
    },
    broadcastActivity(entries: AgentActivity[]) {
      if (!entries.length) return;
      const msg: ActivityMessage = { type: 'activity', entries };
      const json = JSON.stringify(msg);
      for (const conn of connections) {
        if (conn.role === 'display' || conn.role === 'director') send(conn, json);
      }
    },
    broadcastControllers,
    counts() {
      let controllers = 0, displays = 0, directors = 0, pending = 0;
      for (const conn of connections) {
        if (conn.role === 'controller') controllers += 1;
        else if (conn.role === 'display') displays += 1;
        else if (conn.role === 'director') directors += 1;
        else pending += 1;
      }
      return { controllers, displays, directors, pending, total: connections.size };
    },
    closeAll() {
      for (const conn of connections) {
        if (conn.helloTimer) clearTimeout(conn.helloTimer);
        try { conn.ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
      }
      connections.clear();
      wss.close();
    },
  };
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function clamp(n: number): number {
  return Math.max(-1, Math.min(1, n));
}
