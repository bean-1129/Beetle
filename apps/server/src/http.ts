// Fastify routes: public, director (director token) and agent (loopback + agent token).
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AGENT_PHASES, AgentStatusBodySchema, CommitBodySchema, DirectorRequestBodySchema, JoinRequestSchema, ProposePatchBodySchema,
  ProposeWorldBodySchema, ReportBodySchema, ROUTES, canonicalJson,
  type AgentPhase, type BuildReport, type CommitResult, type ValidationCode, type WorldSpec,
} from '@beetle/contracts';
import { redactUrl } from '@beetle/observability';
import { bearerToken, isLoopback, safeEqual } from './auth.ts';
import { shortId } from './clock.ts';
import type { ServerContext } from './context.ts';
import { directoryExists } from './persistence.ts';

const JOIN_RATE_LIMIT = 10;
const JOIN_RATE_WINDOW_MS = 60_000;

const InviteBodySchema = z.object({ slot: z.union([z.literal(0), z.literal(1)]).optional() }).strict();
const ClaimBodySchema = z.object({ workerId: z.string().min(1).max(64) }).strict();
const FinishBodySchema = z.object({
  outcome: z.enum(['committed', 'failed', 'cancelled']),
  worldVersion: z.number().int().min(0).optional(),
  reportId: z.string().max(64).optional(),
  error: z.object({ code: z.string().max(40), message: z.string().max(400) }).strict().optional(),
}).strict();
const ActivityQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

type Params = { id: string };

export async function registerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const joinHits = new Map<string, number[]>();

  // Lenient JSON: an empty body on a JSON POST means {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('body is not valid JSON') as Error & { statusCode?: number; code?: string };
      err.statusCode = 400;
      err.code = 'INVALID_SCHEMA';
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      ctx.events.emit({ name: 'http.error', outcome: 'fail', data: { method: req.method, url: redactUrl(req.url), message: err.message } });
    }
    void reply.code(status).send({ code: status === 400 ? 'INVALID_SCHEMA' : status === 413 ? 'RESOURCE_LIMIT' : 'INTERNAL', message: status >= 500 ? 'internal error' : err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ code: 'NOT_FOUND', message: `no route for ${req.method} ${redactUrl(req.url)}` });
  });

  if (ctx.config.logRequests) {
    app.addHook('onResponse', (req, reply, done) => {
      if (!req.url.startsWith(ROUTES.health)) {
        const ms = Math.round(reply.elapsedTime);
        console.log(`[beetle] ${req.method} ${redactUrl(req.url)} ${reply.statusCode} ${ms}ms`);
      }
      done();
    });
  }

  // ---- auth helpers ----
  function requireDirector(req: FastifyRequest, reply: FastifyReply): boolean {
    const token = bearerToken(req.headers as Record<string, unknown>);
    if (!token) {
      void reply.code(401).send({ code: 'AUTH', message: 'director token required' });
      return false;
    }
    if (!safeEqual(token, ctx.secrets.directorToken)) {
      void reply.code(403).send({ code: 'AUTH', message: 'this token cannot use director routes' });
      return false;
    }
    return true;
  }

  function requireAgent(req: FastifyRequest, reply: FastifyReply): boolean {
    const remote = req.ip || req.socket?.remoteAddress || '';
    if (!isLoopback(remote)) {
      void reply.code(403).send({ code: 'AUTH', message: 'agent routes accept loopback connections only' });
      return false;
    }
    const token = bearerToken(req.headers as Record<string, unknown>);
    if (!token) {
      void reply.code(401).send({ code: 'AUTH', message: 'agent token required' });
      return false;
    }
    if (!safeEqual(token, ctx.secrets.agentToken)) {
      void reply.code(403).send({ code: 'AUTH', message: 'this token cannot use agent routes' });
      return false;
    }
    return true;
  }

  function invalid(reply: FastifyReply, error: z.ZodError): void {
    void reply.code(400).send({
      code: 'INVALID_SCHEMA',
      message: error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      issues: error.issues.slice(0, 32).map((i) => ({ code: 'INVALID_SCHEMA', message: `${i.path.join('.')}: ${i.message}`, objectIds: [] })),
    });
  }

  function worldPayload() {
    const active = ctx.world.current;
    return {
      hasWorld: active !== null,
      version: ctx.world.version,
      spec: active ? active.spec : null,
      summary: ctx.summary(),
    };
  }

  // ---- public ----
  app.get(ROUTES.health, async () => {
    const model = await ctx.modelStatus();
    return {
      ok: true,
      worldVersion: ctx.world.version,
      hasWorld: ctx.world.hasWorld,
      players: ctx.session.state.players.length,
      connectedControllers: ctx.session.connectedControllers(),
      model,
      agentConnected: ctx.requests.agentConnected(),
      publicUrl: ctx.publicUrl(),
      uptimeMs: Math.max(0, Date.now() - ctx.startedAt),
    };
  });

  app.get(ROUTES.world, async () => worldPayload());

  app.post(ROUTES.join, async (req, reply) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const hits = (joinHits.get(ip) ?? []).filter((t) => now - t < JOIN_RATE_WINDOW_MS);
    if (hits.length >= JOIN_RATE_LIMIT) {
      joinHits.set(ip, hits);
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'too many join attempts; wait a minute' });
    }
    hits.push(now);
    joinHits.set(ip, hits);
    if (joinHits.size > 1000) joinHits.clear();

    const body = JoinRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const result = ctx.session.join(body.data.inviteCode, ctx.clock.now());
    if (!result.ok) {
      return reply.code(400).send({ code: 'INVALID_INVITE', message: result.reason === 'expired' ? 'invite expired' : 'unknown invite' });
    }
    // The slot's previous token is revoked by join(); sockets still bound with it lose control right away.
    const revoked = ctx.hub.revokePlayerSockets(result.playerId);
    if (revoked > 0) {
      const player = ctx.session.player(result.playerId);
      if (player) ctx.session.markDisconnected(player, ctx.clock.now());
    }
    ctx.placeAtSpawn(result.playerId);
    ctx.events.emit({ name: 'player.joined', sessionId: ctx.session.state.sessionId, worldVersion: ctx.world.version, data: { playerId: result.playerId, slot: result.slot } });
    ctx.hub.broadcastControllers();
    return { controllerToken: result.controllerToken, playerId: result.playerId, label: result.label, color: result.color, slot: result.slot };
  });

  // ---- director ----
  app.post(ROUTES.directorInvite, async (req, reply) => {
    if (!requireDirector(req, reply)) return reply;
    const body = InviteBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const invite = ctx.session.createInvite(body.data.slot, ctx.clock.now());
    ctx.events.emit({ name: 'invite.created', data: { slot: invite.slot, expiresAt: invite.expiresAt } });
    return {
      inviteCode: invite.code,
      url: `${ctx.publicUrl()}/controller?invite=${invite.code}`,
      expiresAt: invite.expiresAt,
      slot: invite.slot,
    };
  });

  app.post(ROUTES.directorRequest, async (req, reply) => {
    if (!requireDirector(req, reply)) return reply;
    const body = DirectorRequestBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const { kind, prompt } = body.data;
    const authorize = body.data.authorizeNewWorld === true;
    if (kind === 'brief' && ctx.session.connectedControllers() > 0 && !authorize) {
      return reply.code(409).send({ code: 'UNSUPPORTED_OPERATION', message: 'players are connected; a new world needs authorizeNewWorld true' });
    }
    if (kind === 'edit' && !ctx.world.hasWorld) {
      return reply.code(409).send({ code: 'UNSUPPORTED_OPERATION', message: 'there is no world to edit yet; send a brief first' });
    }
    const request = ctx.requests.create(kind, prompt, ctx.world.version, authorize);
    ctx.events.emit({ name: 'request.created', requestId: request.id, worldVersion: ctx.world.version, data: { kind, promptChars: prompt.length, authorizeNewWorld: authorize } });
    const entry = ctx.requests.addActivity(request.id, { phase: 'queued', message: kind === 'brief' ? 'Brief queued for the agent' : 'Edit queued for the agent' }, ctx.world.version);
    ctx.hub.broadcastActivity([entry]);
    return { request };
  });

  app.get<{ Params: Params }>(ROUTES.directorRequestById, async (req, reply) => {
    if (!requireDirector(req, reply)) return reply;
    const request = ctx.requests.get(req.params.id);
    if (!request) return reply.code(404).send({ code: 'NOT_FOUND', message: 'unknown request' });
    return { request, activity: ctx.requests.recentActivity(500, request.id) };
  });

  app.get(ROUTES.directorActivity, async (req, reply) => {
    if (!requireDirector(req, reply)) return reply;
    const q = ActivityQuerySchema.safeParse(req.query ?? {});
    const limit = q.success && q.data.limit ? q.data.limit : 100;
    return { entries: ctx.requests.recentActivity(limit) };
  });

  app.get(ROUTES.directorReports, async (req, reply) => {
    if (!requireDirector(req, reply)) return reply;
    return { reports: ctx.requests.listReports() };
  });

  app.post(ROUTES.directorUndo, async (req, reply) => {
    if (!requireDirector(req, reply)) return reply;
    const result = await undo(ctx);
    return result;
  });

  // ---- agent ----
  app.get(ROUTES.agentWorld, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    return worldPayload();
  });

  app.post(ROUTES.agentRequestsClaim, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = ClaimBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const request = await ctx.requests.claim(body.data.workerId);
    if (!request) return reply.code(204).send();
    ctx.events.emit({ name: 'request.claimed', requestId: request.id, worldVersion: ctx.world.version, data: { workerId: body.data.workerId, kind: request.kind } });
    const entry = ctx.requests.addActivity(request.id, { phase: 'planning', message: 'Agent claimed the request' }, ctx.world.version);
    ctx.hub.broadcastActivity([entry]);
    return { request };
  });

  app.post<{ Params: Params }>(ROUTES.agentRequestStatus, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = AgentStatusBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const request = ctx.requests.get(req.params.id);
    if (!request) return reply.code(404).send({ code: 'NOT_FOUND', message: 'unknown request' });
    const phase: AgentPhase = body.data.phase;
    ctx.requests.touchAgent();
    if (phase !== 'committed' && phase !== 'failed' && phase !== 'cancelled' && phase !== 'queued') ctx.requests.setStatus(request.id, phase);
    const entry = ctx.requests.addActivity(request.id, body.data, ctx.world.version);
    ctx.events.emit({
      name: 'agent.status', requestId: request.id, worldVersion: ctx.world.version, tool: body.data.tool,
      codes: body.data.codes, data: { phase, message: body.data.message, objectIds: body.data.objectIds },
    });
    ctx.hub.broadcastActivity([entry]);
    return { ok: true };
  });

  app.post<{ Params: Params }>(ROUTES.agentRequestFinish, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = FinishBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const request = ctx.requests.finish(req.params.id, body.data.outcome, body.data);
    if (!request) return reply.code(404).send({ code: 'NOT_FOUND', message: 'unknown request' });
    ctx.events.emit({
      name: 'request.finished', requestId: request.id, worldVersion: body.data.worldVersion ?? ctx.world.version,
      outcome: body.data.outcome === 'committed' ? 'ok' : body.data.outcome === 'failed' ? 'fail' : 'cancelled',
      codes: body.data.error ? [body.data.error.code] : undefined, data: { reportId: body.data.reportId, error: body.data.error },
    });
    const message = body.data.outcome === 'committed'
      ? `Committed world version ${body.data.worldVersion ?? ctx.world.version}`
      : body.data.outcome === 'failed'
        ? `Failed: ${body.data.error?.message ?? body.data.error?.code ?? 'unknown error'}`
        : 'Cancelled';
    const entry = ctx.requests.addActivity(request.id, {
      phase: body.data.outcome, message, codes: body.data.error ? [body.data.error.code] : undefined,
    }, body.data.worldVersion ?? ctx.world.version);
    ctx.hub.broadcastActivity([entry]);
    return { ok: true };
  });


  /**
   * Agent routes may not attribute candidates or reports to a request that has been cancelled or already finished.
   * Unknown ids are allowed (candidates carry the id only for bookkeeping; tests and the benchmark use synthetic ids),
   * but activity is only ever attached to a request that exists and is still open (see the reports route).
   */
  function requireOpenRequest(requestId: string, reply: FastifyReply): boolean {
    const r = ctx.requests.get(requestId);
    if (r && (r.status === 'cancelled' || r.finishedAt !== undefined)) {
      reply.code(409).send({ issues: [{ code: 'UNSUPPORTED_OPERATION', message: `request "${requestId}" is closed (${r.status})`, objectIds: [requestId] }] });
      return false;
    }
    return true;
  }

  app.post(ROUTES.agentProposeWorld, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = ProposeWorldBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    if (!requireOpenRequest(body.data.requestId, reply)) return reply;
    const staged = ctx.candidates.stageWorld(body.data.requestId, body.data.spec, ctx.world.version, ctx.clock.now());
    if (!staged.ok) {
      ctx.events.emit({ name: 'candidate.rejected', requestId: body.data.requestId, worldVersion: ctx.world.version, outcome: 'fail', codes: staged.issues.map((i) => i.code).slice(0, 8), data: { kind: 'world' } });
      return reply.code(400).send({ issues: staged.issues });
    }
    const c = staged.candidate;
    ctx.events.emit({ name: 'candidate.staged', requestId: c.requestId, worldVersion: ctx.world.version, data: { candidateId: c.candidateId, kind: 'world', digest: c.digest, baseWorldVersion: c.baseWorldVersion } });
    return { candidateId: c.candidateId, digest: c.digest, baseWorldVersion: c.baseWorldVersion, spec: c.spec };
  });

  app.post(ROUTES.agentProposePatch, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = ProposePatchBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    if (!requireOpenRequest(body.data.requestId, reply)) return reply;
    const active = ctx.world.current;
    if (!active) {
      return reply.code(409).send({ issues: [{ code: 'UNSUPPORTED_OPERATION', message: 'there is no world to patch; propose a world first', objectIds: [] }] });
    }
    const staged = ctx.candidates.stagePatch(body.data.requestId, active.spec, body.data.patch, active.version, [...ctx.session.state.collectedRelicIds], ctx.clock.now());
    if (!staged.ok) {
      ctx.events.emit({ name: 'candidate.rejected', requestId: body.data.requestId, worldVersion: active.version, outcome: 'fail', codes: staged.issues.map((i) => i.code).slice(0, 8), data: { kind: 'patch' } });
      return reply.code(400).send({ issues: staged.issues });
    }
    const c = staged.candidate;
    ctx.events.emit({ name: 'candidate.staged', requestId: c.requestId, worldVersion: active.version, data: { candidateId: c.candidateId, patchId: c.patchId, kind: 'patch', digest: c.digest, baseWorldVersion: c.baseWorldVersion, changedIds: c.changedIds.slice(0, 32) } });
    return { candidateId: c.candidateId, patchId: c.patchId, digest: c.digest, baseWorldVersion: c.baseWorldVersion, spec: c.spec, changedIds: c.changedIds };
  });

  app.post<{ Params: Params }>(ROUTES.agentValidate, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const candidate = ctx.candidates.get(req.params.id);
    if (!candidate) return reply.code(404).send({ code: 'UNKNOWN_CANDIDATE', message: 'unknown candidate', objectIds: [req.params.id] });
    const result = ctx.candidates.validate(candidate, ctx.liveContext(), ctx.world.version, ctx.clock.now());
    ctx.events.emit({
      name: 'validate.result', requestId: candidate.requestId, worldVersion: ctx.world.version, outcome: result.ok ? 'ok' : 'fail',
      codes: result.issues.map((i) => i.code).slice(0, 16), durationMs: result.durationMs,
      data: { candidateId: candidate.candidateId, issueCount: result.issues.length, objectIds: result.issues.flatMap((i) => i.objectIds).slice(0, 32) },
    });
    return result;
  });

  app.post<{ Params: Params }>(ROUTES.agentPlayability, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const candidate = ctx.candidates.get(req.params.id);
    if (!candidate) return reply.code(404).send({ code: 'UNKNOWN_CANDIDATE', message: 'unknown candidate', objectIds: [req.params.id] });
    const report = ctx.candidates.playability(candidate, ctx.liveContext());
    ctx.events.emit({
      name: 'playability.result', requestId: candidate.requestId, worldVersion: ctx.world.version, outcome: report.ok ? 'ok' : 'fail', durationMs: report.durationMs,
      data: { candidateId: candidate.candidateId, checks: report.checks.length, failed: report.checks.filter((c) => !c.ok).length },
    });
    return report;
  });

  app.post<{ Params: Params }>(ROUTES.agentCommit, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = CommitBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const pre = ctx.candidates.precheck(req.params.id, body.data.proofId, ctx.world.version, ctx.clock.now());
    if (!pre.ok) {
      if (!pre.result.ok) {
        ctx.events.emit({ name: 'commit.rejected', worldVersion: ctx.world.version, outcome: 'fail', codes: [pre.result.code], data: { candidateId: req.params.id, stage: 'precheck' } });
      }
      return reply.code(pre.status).send(pre.result);
    }
    const { candidate } = pre;
    if (candidate.kind === 'world' && ctx.session.connectedControllers() > 0) {
      const record = ctx.requests.record(candidate.requestId);
      if (!record || !record.authorizeNewWorld) {
        const result: CommitResult = {
          ok: false, code: 'UNSUPPORTED_OPERATION',
          message: 'players are connected and the request did not authorise a new world; an edit is never promoted to a reset',
          objectIds: [candidate.candidateId], retryable: false,
        };
        ctx.events.emit({ name: 'commit.rejected', requestId: candidate.requestId, worldVersion: ctx.world.version, outcome: 'fail', codes: [result.code], data: { candidateId: candidate.candidateId } });
        return result;
      }
    }
    const result = await ctx.sim.enqueueCommit(candidate, body.data.proofId, 'commit');
    return result;
  });

  app.post(ROUTES.agentReports, async (req, reply) => {
    if (!requireAgent(req, reply)) return reply;
    const body = ReportBodySchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    if (!requireOpenRequest(body.data.requestId, reply)) return reply;
    const now = ctx.clock.now();
    const report: BuildReport = {
      reportId: shortId('rep'),
      ...body.data,
      validation: { attempts: body.data.validation.attempts, failedCodes: body.data.validation.failedCodes as ValidationCode[] },
      createdAt: now,
    };
    ctx.requests.addReport(report);
    void ctx.persistence.writeReport(report);
    ctx.events.emit({
      name: 'report.published', requestId: report.requestId, worldVersion: report.worldVersion, model: report.model,
      outcome: report.outcome === 'committed' ? 'ok' : report.outcome === 'failed' ? 'fail' : 'cancelled',
      durationMs: report.timings.totalMs, data: { reportId: report.reportId, mode: report.mode, attempts: report.validation.attempts, toolCalls: report.toolCalls.length },
    });
    const phase: AgentPhase = report.outcome === 'committed' ? 'committed' : report.outcome === 'failed' ? 'failed' : 'cancelled';
    // Only a request that exists and is still open gets an activity entry; a report naming an unknown or closed id is stored but never shown as that request's outcome.
    const owner = ctx.requests.get(report.requestId);
    if (owner && owner.status !== 'cancelled' && owner.finishedAt === undefined) {
      const entry = ctx.requests.addActivity(report.requestId, {
        phase, message: `${report.mode} / ${report.model}: ${report.summary}`.slice(0, 400), codes: report.validation.failedCodes,
      }, report.worldVersion);
      ctx.hub.broadcastActivity([entry]);
    }
    return { reportId: report.reportId };
  });

  // ---- static web client ----
  await registerStatic(app, ctx);
}

async function registerStatic(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const dir = ctx.config.webDistDir;
  if (dir && (await directoryExists(dir))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: path.resolve(dir), prefix: '/', index: ['index.html'], wildcard: true });
    for (const page of ['director', 'play', 'controller'] as const) {
      app.get(`/${page}`, (_req, reply) => reply.sendFile(`${page}.html`));
    }
    return;
  }
  app.get('/', async (_req, reply) => {
    void reply.type('text/plain; charset=utf-8');
    return 'Beetle server is running. The web client is not built yet (apps/web/dist missing). API: /api/health';
  });
}

/** Builds a candidate from the previous spec and commits it through the normal safe path. */
async function undo(ctx: ServerContext): Promise<CommitResult> {
  const active = ctx.world.current;
  const previous = ctx.world.previousSpec();
  if (!active || !previous) {
    return { ok: false, code: 'UNSUPPORTED_OPERATION', message: 'nothing to undo', objectIds: [], retryable: false };
  }
  const now = ctx.clock.now();
  const candidate = ctx.candidates.stageSpec('undo', 'patch', previous, active.version, now, {
    patchId: shortId('undo'),
    changedIds: diffSpecIds(active.spec, previous),
    patchSummary: `Undo: back to the layout of version ${previous.worldVersion}`,
  });
  const validation = ctx.candidates.validate(candidate, ctx.liveContext(), active.version, now);
  ctx.events.emit({
    name: 'undo.validate', worldVersion: active.version, outcome: validation.ok ? 'ok' : 'fail',
    codes: validation.issues.map((i) => i.code).slice(0, 16), data: { candidateId: candidate.candidateId },
  });
  if (!validation.ok || !validation.proof) {
    const first = validation.issues[0];
    return {
      ok: false,
      code: first?.code ?? 'INTERNAL',
      message: first ? `undo is not safe right now: ${first.message}` : 'undo validation failed',
      objectIds: first?.objectIds ?? [],
      retryable: true,
    };
  }
  return ctx.sim.enqueueCommit(candidate, validation.proof.proofId, 'undo');
}

function diffSpecIds(a: WorldSpec, b: WorldSpec): string[] {
  const index = (spec: WorldSpec): Map<string, string> => {
    const m = new Map<string, string>();
    for (const i of spec.islands) m.set(i.id, canonicalJson(i));
    for (const br of spec.bridges) m.set(br.id, canonicalJson(br));
    for (const s of spec.spawns) m.set(s.id, canonicalJson(s));
    for (const r of spec.relics) m.set(r.id, canonicalJson(r));
    m.set(spec.gate.id, canonicalJson(spec.gate));
    for (const d of spec.decorations) m.set(d.id, canonicalJson(d));
    return m;
  };
  const ia = index(a);
  const ib = index(b);
  const out = new Set<string>();
  for (const [id, json] of ia) if (ib.get(id) !== json) out.add(id);
  for (const id of ib.keys()) if (!ia.has(id)) out.add(id);
  if (canonicalJson(a.hazard) !== canonicalJson(b.hazard)) out.add('hazard');
  if (a.title !== b.title) out.add('title');
  return [...out].slice(0, 64);
}

export const PHASES = AGENT_PHASES;
