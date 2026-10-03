// Claim loop: long-poll the server, run one job at a time, write events to data/events/agent.jsonl.
import { resolve } from 'node:path';
import type { DirectorRequest } from '@beetle/contracts';
import { createEventLog, type EventLog } from '@beetle/observability';
import type { AgentConfig } from './config.ts';
import type { JobResult } from './jobs.ts';
import type { BeetleClient } from './tools.ts';

export type JobRunner = { mode: 'direct' | 'openclaw'; run(request: DirectorRequest): Promise<JobResult> };

export type WorkerOptions = {
  config: AgentConfig;
  client: BeetleClient;
  runner: JobRunner;
  eventLog?: EventLog;
  log?: (line: string) => void;
  /** Process one request and stop. */
  once?: boolean;
  /** Called between claims so tests can stop the loop. */
  shouldStop?: () => boolean;
  claimTimeoutMs?: number;
  idleDelayMs?: number;
};

export function createAgentEventLog(config: AgentConfig): EventLog {
  return createEventLog({ filePath: resolve(config.dataDir, 'events', 'agent.jsonl'), source: 'agent' });
}

export type WorkerHandle = { stop(): void; done: Promise<{ processed: number }> };

export function startWorker(opts: WorkerOptions): WorkerHandle {
  const log = opts.log ?? ((l: string) => console.log(l));
  const events = opts.eventLog ?? createAgentEventLog(opts.config);
  let stopped = false;
  let processed = 0;
  const idle = opts.idleDelayMs ?? 500;

  const done = (async () => {
    events.emit({ name: 'worker.start', data: { mode: opts.runner.mode, workerId: opts.config.workerId, model: opts.config.model } });
    log(`[${opts.runner.mode}] worker ${opts.config.workerId} polling ${opts.config.serverUrl} for requests (model ${opts.config.model})`);
    while (!stopped && !opts.shouldStop?.()) {
      let request: DirectorRequest | null = null;
      try {
        request = await opts.client.claim(opts.config.workerId, opts.claimTimeoutMs);
      } catch (err) {
        log(`[${opts.runner.mode}] claim failed: ${(err as Error).message}; retrying`);
        events.emit({ name: 'worker.claim', outcome: 'fail', data: { message: (err as Error).message } });
        await delay(Math.max(idle, 1000));
        continue;
      }
      if (!request) { if (idle > 0) await delay(idle); continue; }
      events.emit({ name: 'request.claimed', requestId: request.id, worldVersion: request.worldVersionAtRequest, data: { kind: request.kind, mode: opts.runner.mode } });
      log(`[${opts.runner.mode}] claimed ${request.id} (${request.kind})`);
      try {
        const result = await opts.runner.run(request);
        processed++;
        log(`[${opts.runner.mode}] ${request.id} ${result.outcome}${result.worldVersion !== undefined ? ' v' + result.worldVersion : ''}${result.error ? ' ' + result.error.code + ': ' + result.error.message : ''} (${result.totalMs} ms)`);
      } catch (err) {
        processed++;
        log(`[${opts.runner.mode}] ${request.id} crashed: ${(err as Error).message}`);
        events.emit({ name: 'job.crash', requestId: request.id, outcome: 'fail', data: { message: (err as Error).message } });
        try { await opts.client.finish(request.id, { outcome: 'failed', error: { code: 'INTERNAL', message: String((err as Error).message).slice(0, 400) } }); } catch { /* best effort */ }
      }
      if (opts.once) break;
    }
    events.emit({ name: 'worker.stop', data: { processed } });
    await events.flush();
    return { processed };
  })();

  return { stop: () => { stopped = true; }, done };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
