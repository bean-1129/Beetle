/** Structured JSONL event written by server and agent. Args/results are bounded and sanitized before logging. */
export type BeetleEvent = {
  ts: number; // wall clock ms
  mono: number; // monotonic ms since process start
  source: 'server' | 'agent' | 'benchmark' | 'test';
  name: string; // e.g. request.created, tool.call, validate.result, commit.ok, commit.deferred, model.call
  requestId?: string;
  sessionId?: string;
  worldVersion?: number;
  model?: string;
  tool?: string;
  outcome?: 'ok' | 'fail' | 'deferred' | 'retry' | 'cancelled';
  codes?: string[];
  durationMs?: number;
  data?: Record<string, unknown>; // sanitized, bounded (max 4 KB serialized)
};
