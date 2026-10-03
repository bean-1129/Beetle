import { ROUTES } from '@beetle/contracts';
import type {
  ActivityMessage, AgentActivity, ClientMessage, ControllerStatusMessage, ErrorMessage, HelloMessage,
  PongMessage, ServerMessage, TickMessage, WelcomeMessage, WorldMessage,
} from '@beetle/contracts';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export type SocketOptions = {
  /** Built on every (re)connect so controllers can include their latest seq. */
  hello: () => HelloMessage;
  url?: string;
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

type Handlers = {
  tick: (m: TickMessage) => void;
  world: (m: WorldMessage) => void;
  welcome: (m: WelcomeMessage) => void;
  activity: (m: ActivityMessage) => void;
  error: (m: ErrorMessage) => void;
  pong: (m: PongMessage) => void;
  controllers: (m: ControllerStatusMessage) => void;
  state: (s: ConnectionState) => void;
  rtt: (ms: number) => void;
  message: (m: ServerMessage) => void;
};
type HandlerName = keyof Handlers;

export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${ROUTES.ws}`;
}

/**
 * Typed WebSocket client with reconnect and backoff (1 s to 10 s), world version tracking,
 * resync requests and a ping/pong round trip measurement labelled "WebSocket RTT".
 */
export class BeetleSocket {
  readonly options: Required<Omit<SocketOptions, 'url'>> & { url: string };
  state: ConnectionState = 'closed';
  /** Version of the spec we currently hold, or -1 when we have none. */
  worldVersion = -1;
  world: WorldMessage | null = null;
  tick: TickMessage | null = null;
  welcome: WelcomeMessage | null = null;
  rttMs: number | null = null;
  lastTickAt = 0;
  activity: AgentActivity[] = [];
  controllers: ControllerStatusMessage['players'] = [];

  private ws: WebSocket | null = null;
  private handlers: { [K in HandlerName]: Set<Handlers[K]> } = {
    tick: new Set(), world: new Set(), welcome: new Set(), activity: new Set(), error: new Set(),
    pong: new Set(), controllers: new Set(), state: new Set(), rtt: new Set(), message: new Set(),
  };
  private backoffMs: number;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private pendingPing: number | null = null;
  private closedByUser = false;
  private resyncRequestedFor = -1;
  private lastResyncAt = 0;
  private attempts = 0;
  private openedAt = 0;

  constructor(options: SocketOptions) {
    this.options = {
      hello: options.hello,
      url: options.url ?? defaultWsUrl(),
      pingIntervalMs: options.pingIntervalMs ?? 2000,
      minBackoffMs: options.minBackoffMs ?? 1000,
      maxBackoffMs: options.maxBackoffMs ?? 10000,
    };
    this.backoffMs = this.options.minBackoffMs;
  }

  on<K extends HandlerName>(name: K, fn: Handlers[K]): () => void {
    const set = this.handlers[name] as Set<Handlers[K]>;
    set.add(fn);
    return () => { set.delete(fn); };
  }

  private emit<K extends HandlerName>(name: K, arg: Parameters<Handlers[K]>[0]): void {
    for (const fn of this.handlers[name] as Set<(a: unknown) => void>) {
      try { fn(arg); } catch (err) { console.error('[beetle ws] handler failed', err); }
    }
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    this.attempts += 1;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch (err) {
      console.error('[beetle ws] cannot open socket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoffMs = this.options.minBackoffMs;
      // A fresh socket gets a fresh snapshot: accept whatever version the server holds now.
      this.worldVersion = -1;
      this.resyncRequestedFor = -1;
      this.openedAt = performance.now();
      this.setState('connected');
      this.sendRaw(this.options.hello());
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try { msg = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
      this.handle(msg);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.closedByUser) { this.setState('closed'); return; }
      this.scheduleReconnect();
    };
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    this.setState('closed');
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    return this.sendRaw(msg);
  }

  private sendRaw(msg: ClientMessage): boolean {
    if (!this.isOpen || !this.ws) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    if (this.reconnectTimer !== null) return;
    const jitter = Math.random() * 250;
    const delay = Math.min(this.options.maxBackoffMs, this.backoffMs) + jitter;
    this.backoffMs = Math.min(this.options.maxBackoffMs, this.backoffMs * 2);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const tickPing = () => {
      if (!this.isOpen) return;
      const t = performance.now();
      this.pendingPing = t;
      this.sendRaw({ type: 'ping', t });
    };
    tickPing();
    this.pingTimer = window.setInterval(tickPing, this.options.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.pendingPing = null;
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.welcome = msg;
        this.emit('welcome', msg);
        break;
      }
      case 'world': {
        if (typeof msg.version !== 'number' || !msg.spec) return;
        if (msg.version < this.worldVersion) return; // older than what we hold: ignore
        this.worldVersion = msg.version;
        this.world = msg;
        this.emit('world', msg);
        if (this.welcome?.role === 'display') this.sendRaw({ type: 'ack', worldVersion: msg.version });
        break;
      }
      case 'tick': {
        this.tick = msg;
        this.lastTickAt = performance.now();
        if (msg.worldVersion > this.worldVersion) this.requestResync(msg.worldVersion);
        this.emit('tick', msg);
        break;
      }
      case 'pong': {
        if (typeof msg.t === 'number') {
          const rtt = Math.max(0, performance.now() - msg.t);
          this.rttMs = rtt;
          this.emit('rtt', rtt);
        }
        this.pendingPing = null;
        this.emit('pong', msg);
        break;
      }
      case 'activity': {
        const entries = Array.isArray(msg.entries) ? msg.entries : [];
        for (const e of entries) {
          if (!e || typeof e.id !== 'string') continue;
          if (this.activity.some((x) => x.id === e.id)) continue;
          this.activity.push(e);
        }
        if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
        this.emit('activity', msg);
        break;
      }
      case 'controllers': {
        this.controllers = Array.isArray(msg.players) ? msg.players : [];
        this.emit('controllers', msg);
        break;
      }
      case 'error': {
        this.emit('error', msg);
        break;
      }
      default:
        break;
    }
    this.emit('message', msg);
  }

  private requestResync(serverVersion: number): void {
    const now = performance.now();
    // right after hello the snapshot is already on its way; only ask when it did not arrive
    if (this.worldVersion < 0 && now - this.openedAt < 1500) return;
    if (this.resyncRequestedFor === serverVersion && now - this.lastResyncAt < 3000) return;
    this.resyncRequestedFor = serverVersion;
    this.lastResyncAt = now;
    this.sendRaw({ type: 'resync', haveVersion: Math.max(0, this.worldVersion) });
  }
}
