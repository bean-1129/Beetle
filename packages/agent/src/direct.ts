// Mode 'direct': the dev harness. Runs the bounded job in-process with Ollama structured output.
// Labelled 'direct' in every report, status message and event. Never presented as OpenClaw.
import type { DirectorRequest } from '@beetle/contracts';
import type { EventInput } from '@beetle/observability';
import type { AgentConfig } from './config.ts';
import { createOllamaClient, type OllamaClient } from './ollama.ts';
import { runJob, type JobResult } from './jobs.ts';
import type { BeetleClient } from './tools.ts';

export type DirectRunnerDeps = {
  config: AgentConfig;
  client: BeetleClient;
  ollama?: OllamaClient;
  emit?: (e: EventInput) => void;
  log?: (line: string) => void;
  isCancelled?: () => boolean;
};

export function createDirectRunner(deps: DirectRunnerDeps) {
  const ollama = deps.ollama ?? createOllamaClient({ baseUrl: deps.config.ollamaBaseUrl, model: deps.config.model, defaultTimeoutMs: deps.config.modelCallTimeoutMs });
  return {
    mode: 'direct' as const,
    run(request: DirectorRequest): Promise<JobResult> {
      return runJob(request, {
        client: deps.client,
        ollama,
        env: {
          mode: 'direct',
          model: deps.config.model,
          deadlineMs: deps.config.requestDeadlineMs,
          maxRepairAttempts: deps.config.maxRepairAttempts,
          maxToolCalls: deps.config.maxToolCalls,
          modelCallTimeoutMs: deps.config.modelCallTimeoutMs,
        },
        emit: deps.emit,
        log: deps.log,
        isCancelled: deps.isCancelled,
      });
    },
  };
}
