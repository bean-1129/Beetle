// One bounded job per director request: deadline, bounded repairs, bounded tool calls, cancellation.
// Model output is parsed as JSON here (syntax and truncation only) and sent to the server, which normalizes and
// validates it with the contract schemas (expandDraft / applyPatch); server issues drive the repair prompt.
// Nothing from the model is executed.
import {
  WORLD_DRAFT_JSON_SCHEMA,
  PATCH_DRAFT_JSON_SCHEMA,
  type DirectorRequest,
  type CommitResult,
  type ValidationCode,
  type WorldSpec,
} from '@beetle/contracts';
import type { EventInput } from '@beetle/observability';
import type { AgentMode } from './config.ts';
import { OllamaError, parseModelJson, type ChatMessage, type OllamaClient } from './ollama.ts';
import { BeetleHttpError, sleep as defaultSleep, type BeetleClient, type IssueList, type ToolCallRecord, type StatusBody } from './tools.ts';
import {
  briefUserPrompt,
  editUserPrompt,
  patchDraftSystemPrompt,
  schemaRepairPrompt,
  summarizeIssues,
  validatorRepairPrompt,
  worldDraftSystemPrompt,
} from './prompts.ts';

export type JobEnv = {
  mode: AgentMode;
  model: string;
  deadlineMs: number;
  maxRepairAttempts: number;
  maxToolCalls: number;
  modelCallTimeoutMs: number;
  /** Bounded retries for malformed or zod-invalid model output per draft (default 2). */
  parseRetries?: number;
  /** Wait before re-committing the same proof after a retryable OCCUPIED_SUPPORT (default 1000 ms). */
  occupiedRetryDelayMs?: number;
};

export type JobDeps = {
  client: BeetleClient;
  ollama: OllamaClient;
  env: JobEnv;
  emit?: (e: EventInput) => void;
  sleep?: (ms: number) => Promise<void>;
  /** External cancellation signal (the worker may learn about cancellation through the status replies too). */
  isCancelled?: () => boolean;
  log?: (line: string) => void;
};

export type JobResult = {
  outcome: 'committed' | 'failed' | 'cancelled';
  worldVersion?: number;
  baseWorldVersion: number;
  reportId?: string;
  error?: { code: string; message: string; objectIds?: string[] };
  validationAttempts: number;
  failedCodes: ValidationCode[];
  modelCalls: number;
  toolCalls: ToolCallRecord[];
  totalMs: number;
};

export class JobFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly objectIds: string[] = []) {
    super(message);
    this.name = 'JobFailure';
  }
}
export class JobCancelled extends Error {
  constructor() { super('request cancelled by the server'); this.name = 'JobCancelled'; }
}

type Ctx = {
  request: DirectorRequest;
  deps: JobDeps;
  label: string;
  startedAt: number;
  deadlineAt: number;
  toolCallsUsed: number;
  modelCalls: number;
  validationAttempts: number;
  failedCodes: Set<ValidationCode>;
  firstModelResponseMs?: number;
  validatedMs?: number;
  committedMs?: number;
  playability?: { ok: boolean; checks: number; failed: number };
  baseWorldVersion: number;
  cancelled: boolean;
  summary: string;
};

export async function runJob(request: DirectorRequest, deps: JobDeps): Promise<JobResult> {
  const { client, env } = deps;
  const startedAt = Date.now();
  const ctx: Ctx = {
    request, deps, label: env.mode,
    startedAt, deadlineAt: startedAt + env.deadlineMs,
    toolCallsUsed: 0, modelCalls: 0, validationAttempts: 0, failedCodes: new Set(),
    baseWorldVersion: request.worldVersionAtRequest ?? 0, cancelled: false, summary: '',
  };
  client.resetRecords();
  emit(ctx, { name: 'job.start', requestId: request.id, model: env.model, data: { mode: env.mode, kind: request.kind, deadlineMs: env.deadlineMs } });

  let outcome: JobResult['outcome'] = 'failed';
  let worldVersion: number | undefined;
  let error: JobResult['error'];
  try {
    const committed = request.kind === 'brief' ? await runBrief(ctx) : await runEdit(ctx);
    outcome = 'committed';
    worldVersion = committed.worldVersion;
  } catch (err) {
    const classified = classify(err);
    outcome = classified.outcome;
    error = classified.error;
    log(ctx, `job ${outcome}: ${error?.code ?? ''} ${error?.message ?? ''}`);
  }

  // Report and finish (best effort; the world is untouched when the job failed).
  const totalMs = Date.now() - startedAt;
  let reportId: string | undefined;
  try {
    const r = await client.publish_build_report({
      requestId: request.id,
      mode: env.mode,
      model: env.model,
      outcome,
      worldVersion: worldVersion ?? ctx.baseWorldVersion,
      baseWorldVersion: ctx.baseWorldVersion,
      summary: (outcome === 'committed' ? `[${env.mode}] ${ctx.summary || 'committed'}` : `[${env.mode}] ${outcome}: ${error?.code ?? ''} ${error?.message ?? ''}`).slice(0, 600),
      validation: { attempts: ctx.validationAttempts, failedCodes: [...ctx.failedCodes].slice(0, 32) },
      playability: ctx.playability,
      timings: {
        requestedAt: request.createdAt,
        firstModelResponseMs: ctx.firstModelResponseMs,
        validatedMs: ctx.validatedMs,
        committedMs: ctx.committedMs,
        totalMs,
      },
      toolCalls: client.records.slice(0, 64),
    });
    reportId = r.reportId;
  } catch (err) {
    log(ctx, `report publish failed: ${(err as Error).message}`);
  }
  try {
    await client.finish(request.id, {
      outcome,
      worldVersion,
      reportId,
      error: error ? { code: error.code, message: error.message.slice(0, 400) } : undefined,
    });
  } catch (err) {
    log(ctx, `finish failed: ${(err as Error).message}`);
  }
  emit(ctx, {
    name: 'job.finish', requestId: request.id, model: env.model, outcome: outcome === 'committed' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'fail',
    worldVersion, durationMs: totalMs, codes: error ? [error.code] : undefined,
    data: { mode: env.mode, reportId, toolCalls: ctx.toolCallsUsed, modelCalls: ctx.modelCalls, validationAttempts: ctx.validationAttempts },
  });
  return {
    outcome, worldVersion, baseWorldVersion: ctx.baseWorldVersion, reportId, error,
    validationAttempts: ctx.validationAttempts, failedCodes: [...ctx.failedCodes],
    modelCalls: ctx.modelCalls, toolCalls: [...client.records], totalMs,
  };
}

// ---------------- flows ----------------

async function runBrief(ctx: Ctx): Promise<{ worldVersion: number }> {
  const { request } = ctx;
  await status(ctx, { phase: 'planning', message: `drafting a new world with ${ctx.deps.env.model}` });
  const messages: ChatMessage[] = [
    { role: 'system', content: worldDraftSystemPrompt() },
    { role: 'user', content: briefUserPrompt(request.prompt) },
  ];
  const stage = async (draft: Record<string, unknown>) => {
    const res = await tool(ctx, 'propose_world', () => ctx.deps.client.propose_world(request.id, draft));
    if (!res.ok) return { ok: false as const, issues: res.issues };
    ctx.baseWorldVersion = res.baseWorldVersion;
    const islands = Array.isArray(draft.islands) ? draft.islands.length : 0;
    const bridges = Array.isArray(draft.bridges) ? draft.bridges.length : 0;
    ctx.summary = `new world "${String(draft.title ?? '').slice(0, 60)}" with ${islands} islands and ${bridges} bridges`;
    return { ok: true as const, candidateId: res.candidateId };
  };
  return runDraftValidateCommit(ctx, {
    messages, format: WORLD_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
    numPredict: 3072, temperature: 0.4, stage, world: null,
  });
}

async function runEdit(ctx: Ctx): Promise<{ worldVersion: number }> {
  const { request } = ctx;
  await status(ctx, { phase: 'planning', message: 'reading the current world', tool: 'read_world_state' });
  const world = await tool(ctx, 'read_world_state', () => ctx.deps.client.read_world_state());
  if (!world.hasWorld || !world.spec) throw new JobFailure('NO_WORLD', 'no world is loaded; an edit needs an existing world');
  ctx.baseWorldVersion = world.version;
  await status(ctx, { phase: 'planning', message: `drafting a patch for v${world.version} with ${ctx.deps.env.model}` });
  const messages: ChatMessage[] = [
    { role: 'system', content: patchDraftSystemPrompt({ spec: world.spec, summary: world.summary }) },
    { role: 'user', content: editUserPrompt(request.prompt) },
  ];
  const stage = async (draft: Record<string, unknown>) => {
    const res = await tool(ctx, 'propose_patch', () => ctx.deps.client.propose_patch(request.id, draft));
    if (!res.ok) return { ok: false as const, issues: res.issues };
    ctx.baseWorldVersion = res.baseWorldVersion;
    ctx.summary = String(draft.summary ?? 'patch').slice(0, 240);
    return { ok: true as const, candidateId: res.candidateId };
  };
  return runDraftValidateCommit(ctx, {
    messages, format: PATCH_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
    numPredict: 1536, temperature: 0.2, stage, world: world.spec,
  });
}

type StageFn = (draft: Record<string, unknown>) => Promise<{ ok: true; candidateId: string } | { ok: false; issues: IssueList }>;

async function runDraftValidateCommit(ctx: Ctx, args: {
  messages: ChatMessage[]; format: Record<string, unknown>; numPredict: number; temperature: number; stage: StageFn; world: WorldSpec | null;
}): Promise<{ worldVersion: number }> {
  const { env, client } = ctx.deps;
  const messages = [...args.messages];
  let repairs = 0;
  let draft = await draftWithFormat(ctx, messages, args.format, args.numPredict, args.temperature);

  for (;;) {
    checkCancelled(ctx);
    const staged = await args.stage(draft);
    let issues: IssueList;
    let candidateId: string | null = null;
    if (!staged.ok) {
      issues = staged.issues;
      ctx.validationAttempts++;
    } else {
      candidateId = staged.candidateId;
      await status(ctx, { phase: 'validating', message: 'validating the candidate', tool: 'validate_candidate' });
      const v = await tool(ctx, 'validate_candidate', () => client.validate_candidate(staged.candidateId));
      ctx.validationAttempts++;
      emit(ctx, { name: 'validate.result', requestId: ctx.request.id, outcome: v.ok ? 'ok' : 'fail', codes: v.issues.map((i) => i.code), durationMs: v.durationMs });
      if (v.ok && v.proofId) {
        ctx.validatedMs = Date.now() - ctx.startedAt;
        const play = await playability(ctx, candidateId);
        if (play.ok) return commitWithProof(ctx, candidateId, v.proofId, async () => {
          const again = await args.stage(draft);
          return again.ok ? again.candidateId : null;
        });
        issues = play.issues;
      } else {
        issues = v.issues;
      }
    }
    for (const i of issues) ctx.failedCodes.add(i.code);
    if (repairs >= env.maxRepairAttempts) {
      throw new JobFailure('VALIDATION_FAILED', `rejected after ${repairs} repair${repairs === 1 ? '' : 's'}: ${summarizeIssues(issues)}`, issues.flatMap((i) => i.objectIds).slice(0, 16));
    }
    repairs++;
    await status(ctx, {
      phase: 'repairing', message: `repair ${repairs} of ${env.maxRepairAttempts}: ${summarizeIssues(issues)}`.slice(0, 400),
      codes: issues.map((i) => i.code).slice(0, 16), objectIds: issues.flatMap((i) => i.objectIds).slice(0, 32),
    });
    messages.push({ role: 'assistant', content: JSON.stringify(draft) });
    messages.push({ role: 'user', content: validatorRepairPrompt(issues, args.world) });
    trimMessages(messages);
    draft = await draftWithFormat(ctx, messages, args.format, args.numPredict, args.temperature);
  }
}

async function playability(ctx: Ctx, candidateId: string): Promise<{ ok: true } | { ok: false; issues: IssueList }> {
  await status(ctx, { phase: 'validating', message: 'running connectivity and supported-movement checks', tool: 'run_playability_checks' });
  const p = await tool(ctx, 'run_playability_checks', () => ctx.deps.client.run_playability_checks(candidateId));
  ctx.playability = { ok: p.ok, checks: p.checks, failed: p.failed.length };
  if (p.ok) return { ok: true };
  const issues: IssueList = p.failed.map((f) => ({ code: 'INTERNAL' as ValidationCode, message: `playability check "${f.name}" failed: ${f.detail}`, objectIds: f.objectIds }));
  for (const r of p.routes.unreachable) issues.push({ code: 'INTERNAL' as ValidationCode, message: `route ${r.fromId} to ${r.toId} not walkable`, objectIds: [r.fromId, r.toId] });
  if (issues.length === 0) issues.push({ code: 'INTERNAL' as ValidationCode, message: 'playability report not ok', objectIds: [] });
  return { ok: false, issues };
}

async function commitWithProof(ctx: Ctx, candidateIdIn: string, proofIdIn: string, restage: () => Promise<string | null>): Promise<{ worldVersion: number }> {
  const { client, env } = ctx.deps;
  const sleep = ctx.deps.sleep ?? defaultSleep;
  let candidateId = candidateIdIn;
  let proofId = proofIdIn;
  let recommitted = false;
  let rounds = 0;
  for (;;) {
    checkCancelled(ctx);
    await status(ctx, { phase: 'awaiting_safe_commit', message: 'committing at the next safe tick', tool: 'commit_candidate' });
    const res: CommitResult = await tool(ctx, 'commit_candidate', () => client.commit_candidate(candidateId, proofId));
    if (res.ok) {
      ctx.committedMs = Date.now() - ctx.startedAt;
      emit(ctx, { name: 'commit.ok', requestId: ctx.request.id, worldVersion: res.worldVersion, outcome: 'ok', durationMs: res.deferredMs, data: { idempotentReplay: res.idempotentReplay, patchId: res.patchId } });
      await status(ctx, { phase: 'committed', message: `[${ctx.label}] committed v${res.worldVersion}${res.deferredMs > 0 ? ` after waiting ${res.deferredMs} ms for a safe tick` : ''}`, tool: 'commit_candidate' });
      return { worldVersion: res.worldVersion };
    }
    ctx.failedCodes.add(res.code);
    emit(ctx, { name: res.retryable ? 'commit.deferred' : 'commit.rejected', requestId: ctx.request.id, outcome: res.retryable ? 'deferred' : 'fail', codes: [res.code], data: { objectIds: res.objectIds } });
    if (res.code === 'OCCUPIED_SUPPORT' && res.retryable && !recommitted) {
      recommitted = true;
      await status(ctx, { phase: 'awaiting_safe_commit', message: `a player stands on a changed surface; retrying in ${env.occupiedRetryDelayMs ?? 1000} ms`, codes: [res.code], objectIds: res.objectIds.slice(0, 32) });
      await sleep(env.occupiedRetryDelayMs ?? 1000);
      continue;
    }
    const canRetryFromValidate = (res.code === 'OCCUPIED_SUPPORT' || res.code === 'VALIDATION_EXPIRED' || res.code === 'STALE_WORLD_VERSION') && rounds < 2 && remainingMs(ctx) > 2000;
    if (!canRetryFromValidate) throw new JobFailure(res.code, res.message, res.objectIds);
    rounds++;
    recommitted = false;
    if (res.code === 'STALE_WORLD_VERSION') {
      await status(ctx, { phase: 'validating', message: 'world changed underneath; restaging the same change against the current version', codes: [res.code] });
      const again = await restage();
      if (!again) throw new JobFailure(res.code, 'restaging after a stale version was rejected', res.objectIds);
      candidateId = again;
    } else {
      await status(ctx, { phase: 'validating', message: 'revalidating with the live session', codes: [res.code], objectIds: res.objectIds.slice(0, 32) });
    }
    const v = await tool(ctx, 'validate_candidate', () => client.validate_candidate(candidateId));
    ctx.validationAttempts++;
    emit(ctx, { name: 'validate.result', requestId: ctx.request.id, outcome: v.ok ? 'ok' : 'fail', codes: v.issues.map((i) => i.code), durationMs: v.durationMs });
    if (!v.ok || !v.proofId) {
      for (const i of v.issues) ctx.failedCodes.add(i.code);
      throw new JobFailure(v.issues[0]?.code ?? 'VALIDATION_FAILED', `revalidation failed: ${summarizeIssues(v.issues)}`, v.issues.flatMap((i) => i.objectIds).slice(0, 16));
    }
    proofId = v.proofId;
  }
}

// ---------------- model boundary ----------------

async function draftWithFormat(ctx: Ctx, messages: ChatMessage[], format: Record<string, unknown>, numPredict: number, temperature: number): Promise<Record<string, unknown>> {
  const { env, ollama } = ctx.deps;
  const retries = env.parseRetries ?? 2;
  const working = [...messages];
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    checkCancelled(ctx);
    const remaining = remainingMs(ctx);
    if (remaining <= 0) throw new JobFailure('DEADLINE_EXCEEDED', `request deadline of ${env.deadlineMs} ms passed before the model answered`);
    const timeoutMs = Math.max(1, Math.min(env.modelCallTimeoutMs, remaining));
    ctx.modelCalls++;
    const t0 = Date.now();
    let res;
    try {
      res = await ollama.chat({ messages: working, format, numPredict, temperature, think: false, timeoutMs });
    } catch (err) {
      const e = err as OllamaError;
      emit(ctx, { name: 'model.call', requestId: ctx.request.id, model: env.model, outcome: 'fail', durationMs: Date.now() - t0, data: { mode: env.mode, kind: e.kind ?? 'error', message: e.message } });
      if (e instanceof OllamaError) {
        if (e.kind === 'timeout') throw new JobFailure('MODEL_TIMEOUT', e.message);
        if (e.kind === 'unreachable') throw new JobFailure('MODEL_UNREACHABLE', e.message);
        throw new JobFailure('MODEL_ERROR', e.message);
      }
      throw err;
    }
    if (ctx.firstModelResponseMs === undefined) ctx.firstModelResponseMs = Date.now() - ctx.startedAt;
    emit(ctx, { name: 'model.call', requestId: ctx.request.id, model: env.model, outcome: 'ok', durationMs: res.wallMs, data: { mode: env.mode, promptTokens: res.promptTokens, outputTokens: res.outputTokens, loadMs: res.loadMs, doneReason: res.doneReason, attempt } });
    // Local check: JSON syntax and truncation only. Schema validation and normalization happen on the server.
    const parsed = parseModelJson(res.content);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) return parsed.value as Record<string, unknown>;
    lastError = parsed.ok ? 'malformed JSON (expected a JSON object)' : parsed.error;
    log(ctx, `model output rejected (attempt ${attempt + 1} of ${retries + 1}): ${lastError}`);
    if (attempt < retries) {
      await status(ctx, { phase: 'repairing', message: `model output was not valid JSON, asking again (${attempt + 1} of ${retries}): ${lastError}`.slice(0, 400) });
      working.push({ role: 'assistant', content: res.content.slice(0, 6000) });
      working.push({ role: 'user', content: schemaRepairPrompt(lastError) });
      trimMessages(working);
    }
  }
  throw new JobFailure('MODEL_OUTPUT_INVALID', `model output was not valid JSON ${retries + 1} times: ${lastError}`);
}

/** Keep the system prompt, the original user message, and the last assistant/user pair. */
function trimMessages(messages: ChatMessage[]) {
  if (messages.length <= 4) return;
  messages.splice(2, messages.length - 4);
}

// ---------------- helpers ----------------

async function tool<T>(ctx: Ctx, name: string, fn: () => Promise<T>): Promise<T> {
  checkCancelled(ctx);
  if (remainingMs(ctx) <= 0) throw new JobFailure('DEADLINE_EXCEEDED', `request deadline of ${ctx.deps.env.deadlineMs} ms passed before ${name}`);
  if (ctx.toolCallsUsed >= ctx.deps.env.maxToolCalls) throw new JobFailure('TOOL_BUDGET_EXCEEDED', `tool call budget of ${ctx.deps.env.maxToolCalls} reached before ${name}`);
  ctx.toolCallsUsed++;
  ctx.deps.client.setCallTimeout(Math.max(1000, remainingMs(ctx)));
  const t0 = Date.now();
  try {
    const out = await fn();
    emit(ctx, { name: 'tool.call', requestId: ctx.request.id, tool: name, outcome: 'ok', durationMs: Date.now() - t0, data: { mode: ctx.deps.env.mode } });
    return out;
  } catch (err) {
    emit(ctx, { name: 'tool.call', requestId: ctx.request.id, tool: name, outcome: 'fail', durationMs: Date.now() - t0, data: { mode: ctx.deps.env.mode, message: (err as Error).message } });
    if (err instanceof BeetleHttpError) throw new JobFailure('TOOL_HTTP_ERROR', `${name} failed: HTTP ${err.status || 'network'} ${safeBody(err.body)}`);
    throw err;
  }
}

async function status(ctx: Ctx, body: StatusBody) {
  checkCancelled(ctx);
  const message = body.message.startsWith('[') ? body.message : `[${ctx.label}] ${body.message}`;
  try {
    const r = await ctx.deps.client.status(ctx.request.id, { ...body, message: message.slice(0, 400) });
    if (r.cancelled) ctx.cancelled = true;
  } catch (err) {
    log(ctx, `status post failed: ${(err as Error).message}`);
  }
  emit(ctx, { name: 'agent.status', requestId: ctx.request.id, codes: body.codes, tool: body.tool, data: { mode: ctx.label, phase: body.phase, message } });
  checkCancelled(ctx);
}

function checkCancelled(ctx: Ctx) {
  if (ctx.cancelled || ctx.deps.isCancelled?.()) throw new JobCancelled();
}

function remainingMs(ctx: Ctx): number {
  return ctx.deadlineAt - Date.now();
}

function emit(ctx: Ctx, e: EventInput) {
  try { ctx.deps.emit?.(e); } catch { /* never break the job on logging */ }
}

function log(ctx: Ctx, line: string) {
  try { ctx.deps.log?.(`[${ctx.label}] ${ctx.request.id} ${line}`); } catch { /* ignore */ }
}

function safeBody(body: unknown): string {
  try { return JSON.stringify(body).slice(0, 200); } catch { return ''; }
}

function classify(err: unknown): { outcome: JobResult['outcome']; error: JobResult['error'] } {
  if (err instanceof JobCancelled) return { outcome: 'cancelled', error: { code: 'CANCELLED', message: err.message } };
  if (err instanceof JobFailure) return { outcome: 'failed', error: { code: err.code, message: err.message, objectIds: err.objectIds } };
  if (err instanceof OllamaError) return { outcome: 'failed', error: { code: err.kind === 'timeout' ? 'MODEL_TIMEOUT' : err.kind === 'unreachable' ? 'MODEL_UNREACHABLE' : 'MODEL_ERROR', message: err.message } };
  if (err instanceof BeetleHttpError) return { outcome: 'failed', error: { code: 'TOOL_HTTP_ERROR', message: err.message } };
  return { outcome: 'failed', error: { code: 'INTERNAL', message: (err as Error)?.message ?? String(err) } };
}
