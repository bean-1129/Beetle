// Structured JSONL events and measurement helpers. Server and agent only (uses node:fs).
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BeetleEvent } from '@beetle/contracts';

export type EventInput = Omit<BeetleEvent, 'ts' | 'mono' | 'source'> & Partial<Pick<BeetleEvent, 'ts' | 'mono'>>;

export type EventLog = {
  emit(event: EventInput): BeetleEvent;
  recent(limit?: number, filter?: (e: BeetleEvent) => boolean): BeetleEvent[];
  onEvent(cb: (e: BeetleEvent) => void): () => void;
  flush(): Promise<void>;
  readonly filePath: string | null;
};

const SECRET_KEY = /token|secret|password|authorization|apikey|api_key|cookie|invite/i;
const MAX_DATA_BYTES = 4096;

/** Redact secret-looking keys and bound the size of any nested value. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 512 ? value.slice(0, 512) + '…' : value;
  return value;
}

/** Strip query strings (invite codes, tokens) from URLs before logging. */
export function redactUrl(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) + '?[redacted]' : url;
}

export function monoNow(): number {
  return performance.now();
}

export function createEventLog(opts: { filePath: string | null; source: BeetleEvent['source']; ringSize?: number }): EventLog {
  const ring: BeetleEvent[] = [];
  const ringSize = opts.ringSize ?? 1000;
  const listeners = new Set<(e: BeetleEvent) => void>();
  let queue: Promise<void> = opts.filePath ? mkdir(dirname(opts.filePath), { recursive: true }).then(() => undefined).catch(() => undefined) : Promise.resolve();

  function emit(input: EventInput): BeetleEvent {
    let data = input.data ? (sanitize(input.data) as Record<string, unknown>) : undefined;
    if (data) {
      const serialized = JSON.stringify(data);
      if (serialized.length > MAX_DATA_BYTES) data = { truncated: true, preview: serialized.slice(0, MAX_DATA_BYTES) };
    }
    const event: BeetleEvent = { ...input, data, ts: input.ts ?? Date.now(), mono: input.mono ?? monoNow(), source: opts.source };
    ring.push(event);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    for (const cb of listeners) {
      try { cb(event); } catch { /* listener errors never break the emitter */ }
    }
    if (opts.filePath) {
      const line = JSON.stringify(event) + '\n';
      queue = queue.then(() => appendFile(opts.filePath as string, line, 'utf8')).catch(() => undefined);
    }
    return event;
  }

  return {
    emit,
    recent: (limit = 100, filter) => {
      const list = filter ? ring.filter(filter) : ring;
      return list.slice(-limit);
    },
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    flush: () => queue,
    filePath: opts.filePath,
  };
}

/** Phase timer for honest measurements: cold load, planning, validation, safe-commit wait, render prep, end-to-end. */
export class Stopwatch {
  private readonly start = monoNow();
  private readonly marks: { name: string; atMs: number }[] = [];
  mark(name: string): number {
    const atMs = monoNow() - this.start;
    this.marks.push({ name, atMs });
    return atMs;
  }
  elapsedMs(): number {
    return monoNow() - this.start;
  }
  /** Durations between consecutive marks plus total. */
  report(): { phases: { name: string; ms: number }[]; totalMs: number } {
    const phases: { name: string; ms: number }[] = [];
    let prev = 0;
    for (const m of this.marks) {
      phases.push({ name: m.name, ms: Math.round((m.atMs - prev) * 10) / 10 });
      prev = m.atMs;
    }
    return { phases, totalMs: Math.round(this.elapsedMs() * 10) / 10 };
  }
}

/** Summary statistics for benchmark output. Reports ranges, not single best runs. */
export function summarize(values: number[]): { n: number; min: number; p50: number; max: number; mean: number } {
  if (values.length === 0) return { n: 0, min: 0, p50: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1], mean: Math.round(mean * 10) / 10 };
}
