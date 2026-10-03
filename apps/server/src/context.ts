// Shared server context passed to the HTTP routes, plus a small JSONL event logger (data/events/server.jsonl).
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from './config.ts';
import type { Secrets } from './secrets.ts';

export type ServerEvent = {
  name: string;
  ts: number;
  source: 'server';
  model?: string;
  outcome?: 'ok' | 'fail' | 'cancelled';
  durationMs?: number;
  data?: Record<string, unknown>;
};

export type EventInput = Omit<ServerEvent, 'ts' | 'source'> & { ts?: number };

export type EventLog = {
  emit(event: EventInput): ServerEvent;
  recent(limit?: number, filter?: (e: ServerEvent) => boolean): ServerEvent[];
  flush(): Promise<void>;
  readonly filePath: string | null;
};

export type ServerContext = {
  config: ServerConfig;
  secrets: Secrets;
  events: EventLog;
};

// Prompts, model replies and tokens never reach the log: such keys are redacted wherever they appear.
const SECRET_KEY = /token|secret|password|authorization|cookie|prompt|system|content|messages/i;
const MAX_DATA_BYTES = 4096;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 512 ? value.slice(0, 512) + '...' : value;
  return value;
}

/** Strips query strings (tokens) from URLs before logging. */
export function redactUrl(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) + '?[redacted]' : url;
}

export function createEventLog(opts: { filePath: string | null; ringSize?: number }): EventLog {
  const ring: ServerEvent[] = [];
  const ringSize = opts.ringSize ?? 1000;
  const filePath = opts.filePath;
  let queue: Promise<void> = filePath
    ? mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined, () => undefined)
    : Promise.resolve();

  function emit(input: EventInput): ServerEvent {
    let data = input.data ? (sanitize(input.data) as Record<string, unknown>) : undefined;
    if (data) {
      const serialized = JSON.stringify(data);
      if (serialized.length > MAX_DATA_BYTES) data = { truncated: true };
    }
    const event: ServerEvent = { ...input, data, ts: input.ts ?? Date.now(), source: 'server' };
    if (data === undefined) delete event.data;
    ring.push(event);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    if (filePath) {
      const line = JSON.stringify(event) + '\n';
      queue = queue.then(() => appendFile(filePath, line, 'utf8')).catch(() => undefined);
    }
    return event;
  }

  return {
    emit,
    recent: (limit = 100, filter) => (filter ? ring.filter(filter) : ring).slice(-limit),
    flush: () => queue,
    filePath,
  };
}
