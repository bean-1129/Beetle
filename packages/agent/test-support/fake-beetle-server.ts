// Fake Beetle server for agent tests and the OpenClaw smoke test. Implements the agent routes in memory,
// records every request with method, path and whether the Bearer token matched. Never the real server.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  canonicalJson,
  ROUTES,
  PatchDraftSchema,
  WorldDraftSchema,
  WorldSpecSchema,
  ReportBodySchema,
  AgentStatusBodySchema,
  SIMULATION,
  VALIDATOR_VERSION,
  WORLD_LIMITS,
  type CommitResult,
  type DirectorRequest,
  type PlayabilityReport,
  type ValidationIssue,
  type ValidationResult,
  type WorldSpec,
  type AgentPhase,
} from '@beetle/contracts';
import { fixtureSpec, fixtureSummary } from './fixture-world.ts';

export type RecordedRequest = { seq: number; at: number; method: string; path: string; tokenOk: boolean; status: number; body?: unknown };

export type Candidate = { candidateId: string; requestId: string; kind: 'world' | 'patch'; patchId?: string; baseWorldVersion: number; spec: unknown; digest: string; changedIds: string[] };

export type ValidateScript = { ok: true } | { ok: false; issues: ValidationIssue[] };
export type CommitScript = CommitResult | { ok: false; code: CommitResult extends { code: infer C } ? C : never; message: string; objectIds: string[]; retryable: boolean };
export type FailureScript = { path: RegExp; status: number; times: number; body?: unknown };

export type FakeBeetleOptions = {
  port?: number;
  host?: string;
  token?: string;
  spec?: WorldSpec | null;
  /** Max time a claim waits for a request before replying 204 (default 1000 ms; the real server uses 25 s). */
  claimLongPollMs?: number;
  logFile?: string;
  verbose?: boolean;
};

export type FakeBeetleServer = {
  url: string;
  port: number;
  token: string;
  requests: RecordedRequest[];
  state: {
    version: number;
    spec: WorldSpec | null;
    candidates: Map<string, Candidate>;
    proofs: Map<string, { candidateId: string; digest: string; baseWorldVersion: number; expiresAt: number }>;
    requests: Map<string, DirectorRequest>;
    queue: string[];
    statuses: { requestId: string; body: Record<string, unknown> }[];
    finishes: { requestId: string; body: Record<string, unknown> }[];
    reports: Record<string, unknown>[];
    commits: { candidateId: string; proofId: string; result: CommitResult }[];
  };
  script: { validate: ValidateScript[]; commit: CommitScript[]; playability: { ok: boolean; failedName?: string }[]; failures: FailureScript[] };
  enqueue(req: { kind: 'brief' | 'edit'; prompt: string; id?: string; authorizeNewWorld?: boolean }): DirectorRequest;
  cancel(requestId: string): void;
  calls(tool: string): RecordedRequest[];
  close(): Promise<void>;
};

const PATHS = {
  world: ROUTES.agentWorld,
  claim: ROUTES.agentRequestsClaim,
  status: new RegExp('^' + ROUTES.agentRequestStatus.replace(':id', '([^/]+)') + '$'),
  finish: new RegExp('^' + ROUTES.agentRequestFinish.replace(':id', '([^/]+)') + '$'),
  proposeWorld: ROUTES.agentProposeWorld,
  proposePatch: ROUTES.agentProposePatch,
  validate: new RegExp('^' + ROUTES.agentValidate.replace(':id', '([^/]+)') + '$'),
  playability: new RegExp('^' + ROUTES.agentPlayability.replace(':id', '([^/]+)') + '$'),
  commit: new RegExp('^' + ROUTES.agentCommit.replace(':id', '([^/]+)') + '$'),
  reports: ROUTES.agentReports,
};

/** Map a route path to the Beetle tool name it serves (for log readability). */
export function toolForPath(method: string, path: string): string | null {
  if (method === 'GET' && path === PATHS.world) return 'read_world_state';
  if (path === PATHS.proposeWorld) return 'propose_world';
  if (path === PATHS.proposePatch) return 'propose_patch';
  if (PATHS.validate.test(path)) return 'validate_candidate';
  if (PATHS.playability.test(path)) return 'run_playability_checks';
  if (PATHS.commit.test(path)) return 'commit_candidate';
  if (path === PATHS.reports) return 'publish_build_report';
  return null;
}

export async function startFakeBeetleServer(opts: FakeBeetleOptions = {}): Promise<FakeBeetleServer> {
  const token = opts.token ?? randomBytes(16).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  const claimLongPollMs = opts.claimLongPollMs ?? 1000;
  const state: FakeBeetleServer['state'] = {
    version: opts.spec === null ? 0 : (opts.spec?.worldVersion ?? fixtureSpec().worldVersion),
    spec: opts.spec === undefined ? fixtureSpec() : opts.spec,
    candidates: new Map(), proofs: new Map(), requests: new Map(), queue: [], statuses: [], finishes: [], reports: [], commits: [],
  };
  const script: FakeBeetleServer['script'] = { validate: [], commit: [], playability: [], failures: [] };
  const requests: RecordedRequest[] = [];
  let seq = 0;
  if (opts.logFile) mkdirSync(dirname(opts.logFile), { recursive: true });

  function record(rec: RecordedRequest) {
    requests.push(rec);
    const tool = toolForPath(rec.method, rec.path);
    const line = `${new Date(rec.at).toISOString()} #${rec.seq} ${rec.method} ${rec.path} token=${rec.tokenOk ? 'ok' : 'BAD'} status=${rec.status}${tool ? ' tool=' + tool : ''}`;
    if (opts.verbose) console.log('[fake-beetle] ' + line);
    if (opts.logFile) appendFileSync(opts.logFile, line + '\n');
  }

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolveBody(undefined);
        try { resolveBody(JSON.parse(text)); } catch { resolveBody({ __invalidJson: text.slice(0, 200) }); }
      });
      req.on('error', reject);
    });
  }

  const server: Server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const auth = req.headers.authorization ?? '';
    const tokenOk = auth === 'Bearer ' + token;
    const body = method === 'GET' ? undefined : await readBody(req);
    const mySeq = ++seq;
    const at = Date.now();
    const send = (status: number, payload?: unknown) => {
      record({ seq: mySeq, at, method, path, tokenOk, status, body });
      if (payload === undefined) { res.writeHead(status); res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === ROUTES.health && method === 'GET') {
      return send(200, { ok: true, worldVersion: state.version, hasWorld: Boolean(state.spec), players: 0, connectedControllers: 0, model: { name: 'fake', reachable: false, present: false }, agentConnected: false, publicUrl: `http://${host}:${address().port}`, uptimeMs: 0, fake: true });
    }
    if (!path.startsWith('/api/agent/')) return send(404, { code: 'NOT_FOUND' });
    if (!tokenOk) return send(401, { code: 'UNAUTHORIZED', message: 'agent token required' });

    const failure = script.failures.find((f) => f.path.test(path) && f.times > 0);
    if (failure) { failure.times--; return send(failure.status, failure.body ?? { code: 'INTERNAL', message: 'scripted failure' }); }

    try {
      return await route(method, path, body, send);
    } catch (err) {
      return send(500, { code: 'INTERNAL', message: (err as Error).message });
    }
  });

  async function route(method: string, path: string, body: unknown, send: (s: number, p?: unknown) => void) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === 'GET' && path === PATHS.world) {
      return send(200, { hasWorld: Boolean(state.spec), version: state.version, spec: state.spec, summary: state.spec ? fixtureSummary(state.spec) : null });
    }
    if (method === 'POST' && path === PATHS.claim) {
      const deadline = Date.now() + claimLongPollMs;
      while (state.queue.length === 0 && Date.now() < deadline) await sleep(25);
      const id = state.queue.shift();
      if (!id) return send(204);
      const request = state.requests.get(id)!;
      request.status = 'planning';
      request.claimedBy = String(b.workerId ?? 'unknown');
      return send(200, { request });
    }
    let m = path.match(PATHS.status);
    if (method === 'POST' && m) {
      const request = state.requests.get(decodeURIComponent(m[1]));
      if (!request) return send(404, { code: 'UNKNOWN_REQUEST' });
      const parsed = AgentStatusBodySchema.safeParse(body);
      if (!parsed.success) return send(400, { code: 'INVALID_SCHEMA', message: parsed.error.issues[0]?.message });
      state.statuses.push({ requestId: request.id, body: parsed.data });
      if (request.status === 'cancelled') return send(409, { ok: false, status: 'cancelled' });
      request.status = parsed.data.phase as AgentPhase;
      return send(200, { ok: true });
    }
    m = path.match(PATHS.finish);
    if (method === 'POST' && m) {
      const request = state.requests.get(decodeURIComponent(m[1]));
      if (!request) return send(404, { code: 'UNKNOWN_REQUEST' });
      state.finishes.push({ requestId: request.id, body: b });
      request.status = (b.outcome as AgentPhase) ?? 'failed';
      request.finishedAt = Date.now();
      if (typeof b.worldVersion === 'number') request.resultWorldVersion = b.worldVersion;
      if (typeof b.reportId === 'string') request.reportId = b.reportId;
      if (b.error) request.error = b.error as DirectorRequest['error'];
      return send(200, { ok: true });
    }
    if (method === 'POST' && path === PATHS.proposeWorld) {
      const draft = WorldDraftSchema.safeParse(b.spec);
      const full = draft.success ? null : WorldSpecSchema.safeParse(b.spec);
      if (!draft.success && !full?.success) {
        return send(400, { issues: zodIssues(draft.error.issues) });
      }
      const spec = draft.success ? draft.data : full!.data;
      const candidate = stage('world', String(b.requestId ?? ''), spec, undefined, []);
      return send(200, { candidateId: candidate.candidateId, digest: candidate.digest, baseWorldVersion: candidate.baseWorldVersion, spec: candidate.spec });
    }
    if (method === 'POST' && path === PATHS.proposePatch) {
      const parsed = PatchDraftSchema.safeParse(b.patch);
      if (!parsed.success) return send(400, { issues: zodIssues(parsed.error.issues) });
      if (!state.spec) return send(400, { issues: [{ code: 'UNSUPPORTED_OPERATION', message: 'no world to patch', objectIds: [] }] });
      const applied = applyPatchLite(state.spec, parsed.data.ops);
      if (!applied.ok) return send(400, { issues: applied.issues });
      const patchId = 'patch-' + randomBytes(4).toString('hex');
      const candidate = stage('patch', String(b.requestId ?? ''), applied.spec, patchId, applied.changedIds);
      return send(200, { candidateId: candidate.candidateId, patchId, digest: candidate.digest, baseWorldVersion: candidate.baseWorldVersion, spec: candidate.spec, changedIds: candidate.changedIds });
    }
    m = path.match(PATHS.validate);
    if (method === 'POST' && m) {
      const candidate = state.candidates.get(decodeURIComponent(m[1]));
      if (!candidate) return send(404, { code: 'UNKNOWN_CANDIDATE' });
      const scripted = script.validate.shift() ?? { ok: true };
      const result: ValidationResult = {
        ok: scripted.ok, candidateId: candidate.candidateId, candidateDigest: candidate.digest, baseWorldVersion: candidate.baseWorldVersion,
        validatorVersion: VALIDATOR_VERSION, issues: scripted.ok ? [] : scripted.issues, durationMs: 3,
      };
      if (scripted.ok) {
        const proofId = randomBytes(16).toString('hex');
        const now = Date.now();
        state.proofs.set(proofId, { candidateId: candidate.candidateId, digest: candidate.digest, baseWorldVersion: candidate.baseWorldVersion, expiresAt: now + SIMULATION.validationProofTtlMs });
        result.proof = { proofId, candidateId: candidate.candidateId, candidateDigest: candidate.digest, baseWorldVersion: candidate.baseWorldVersion, validatorVersion: VALIDATOR_VERSION, issuedAt: now, expiresAt: now + SIMULATION.validationProofTtlMs };
      }
      return send(200, result);
    }
    m = path.match(PATHS.playability);
    if (method === 'POST' && m) {
      const candidate = state.candidates.get(decodeURIComponent(m[1]));
      if (!candidate) return send(404, { code: 'UNKNOWN_CANDIDATE' });
      const scripted = script.playability.shift() ?? { ok: true };
      const report: PlayabilityReport = {
        ok: scripted.ok, candidateId: candidate.candidateId,
        checks: [{ name: 'spawn to relics', ok: true, detail: 'walked', objectIds: [] }, { name: 'relics to gate', ok: scripted.ok, detail: scripted.ok ? 'walked' : (scripted.failedName ?? 'walker fell'), objectIds: scripted.ok ? [] : ['gate'] }],
        routes: [{ fromId: 'spawn-0', toId: 'gate', reachable: scripted.ok, cells: 40 }],
        durationMs: 5,
        note: 'connectivity and supported-movement checks only; not a fun or completeness guarantee',
      };
      return send(200, report);
    }
    m = path.match(PATHS.commit);
    if (method === 'POST' && m) {
      const candidate = state.candidates.get(decodeURIComponent(m[1]));
      if (!candidate) return send(404, { code: 'UNKNOWN_CANDIDATE' });
      const proofId = typeof b.proofId === 'string' ? b.proofId : '';
      const proof = state.proofs.get(proofId);
      let result: CommitResult;
      if (!proof || proof.digest !== candidate.digest) result = { ok: false, code: proof ? 'DIGEST_MISMATCH' : 'NOT_VALIDATED', message: 'no valid proof for this candidate', objectIds: [], retryable: false };
      else if (proof.expiresAt < Date.now()) result = { ok: false, code: 'VALIDATION_EXPIRED', message: 'proof expired', objectIds: [], retryable: true };
      else if (candidate.baseWorldVersion !== state.version) result = { ok: false, code: 'STALE_WORLD_VERSION', message: `candidate base v${candidate.baseWorldVersion}, current v${state.version}`, objectIds: [], retryable: false };
      else {
        const scripted = script.commit.shift();
        if (scripted) result = scripted as CommitResult;
        else {
          const replay = state.commits.find((c) => c.candidateId === candidate.candidateId && c.result.ok);
          if (replay && replay.result.ok) result = { ...replay.result, idempotentReplay: true };
          else {
            state.version += 1;
            const spec = candidate.kind === 'patch' ? (candidate.spec as WorldSpec) : (state.spec ?? fixtureSpec());
            state.spec = { ...spec, worldVersion: state.version };
            result = { ok: true, worldVersion: state.version, patchId: candidate.patchId, committedAtTick: 100, deferredMs: 0, idempotentReplay: false };
          }
        }
      }
      state.commits.push({ candidateId: candidate.candidateId, proofId, result });
      return send(200, result);
    }
    if (method === 'POST' && path === PATHS.reports) {
      const parsed = ReportBodySchema.safeParse(body);
      if (!parsed.success) return send(400, { code: 'INVALID_SCHEMA', message: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
      const reportId = 'report-' + randomBytes(4).toString('hex');
      state.reports.push({ reportId, ...parsed.data, createdAt: Date.now() });
      return send(200, { reportId });
    }
    return send(404, { code: 'NOT_FOUND', path });
  }

  function stage(kind: 'world' | 'patch', requestId: string, spec: unknown, patchId: string | undefined, changedIds: string[]): Candidate {
    const candidateId = 'cand-' + randomBytes(4).toString('hex');
    const digest = createHash('sha256').update(canonicalJson(spec)).digest('hex');
    const candidate: Candidate = { candidateId, requestId, kind, patchId, baseWorldVersion: state.version, spec, digest, changedIds };
    state.candidates.set(candidateId, candidate);
    return candidate;
  }

  function address() { return server.address() as { port: number }; }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolveListen());
  });
  const port = address().port;
  const url = `http://${host}:${port}`;

  return {
    url, port, token, requests, state, script,
    enqueue(req) {
      const id = req.id ?? 'req-' + randomBytes(3).toString('hex');
      const request: DirectorRequest = { id, kind: req.kind, prompt: req.prompt, createdAt: Date.now(), worldVersionAtRequest: state.version, status: 'queued' };
      state.requests.set(id, request);
      state.queue.push(id);
      return request;
    },
    cancel(requestId) {
      const r = state.requests.get(requestId);
      if (r) r.status = 'cancelled';
    },
    calls(tool) {
      return requests.filter((r) => toolForPath(r.method, r.path) === tool);
    },
    close: () => new Promise<void>((resolveClose) => { server.closeAllConnections?.(); server.close(() => resolveClose()); }),
  };
}

function zodIssues(issues: { path: (string | number)[]; message: string }[]): ValidationIssue[] {
  return [{ code: 'INVALID_SCHEMA', message: issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 400), objectIds: [], evidence: { zod: issues.slice(0, 3).map((i) => ({ path: i.path.join('.'), message: i.message })) } }];
}

/** Minimal patch application so candidates carry a changed spec. Not the real applyPatch. */
function applyPatchLite(base: WorldSpec, ops: { op: string; [k: string]: unknown }[]): { ok: true; spec: WorldSpec; changedIds: string[] } | { ok: false; issues: ValidationIssue[] } {
  const spec: WorldSpec = JSON.parse(JSON.stringify(base));
  const changedIds: string[] = [];
  const issues: ValidationIssue[] = [];
  const allIds = () => new Set([...spec.islands, ...spec.bridges, ...spec.relics, ...spec.decorations, ...spec.spawns, spec.gate].map((o) => o.id));
  for (const op of ops) {
    switch (op.op) {
      case 'add_bridge': {
        const id = String(op.id);
        const from = spec.islands.find((i) => i.id === op.from);
        const to = spec.islands.find((i) => i.id === op.to);
        if (allIds().has(id)) { issues.push({ code: 'DUPLICATE_ID', message: `id ${id} already exists`, objectIds: [id] }); break; }
        if (!from || !to || from === to) { issues.push({ code: 'INVALID_REFERENCE', message: `add_bridge needs two different existing islands`, objectIds: [String(op.from), String(op.to)] }); break; }
        if (spec.bridges.length >= WORLD_LIMITS.bridges.max) { issues.push({ code: 'RESOURCE_LIMIT', message: 'too many bridges', objectIds: [id] }); break; }
        const dx = to.center.x - from.center.x, dz = to.center.z - from.center.z;
        const d = Math.hypot(dx, dz) || 1;
        const ux = dx / d, uz = dz / d;
        const r2 = (v: number) => Math.round(v * 100) / 100;
        spec.bridges.push({ id, width: typeof op.width === 'number' ? op.width : 2.4, endpoints: [
          { islandId: from.id, point: { x: r2(from.center.x + ux * from.radius), z: r2(from.center.z + uz * from.radius) } },
          { islandId: to.id, point: { x: r2(to.center.x - ux * to.radius), z: r2(to.center.z - uz * to.radius) } },
        ] });
        changedIds.push(id);
        break;
      }
      case 'remove_bridge': {
        const idx = spec.bridges.findIndex((b) => b.id === op.id);
        if (idx < 0) { issues.push({ code: 'INVALID_REFERENCE', message: `unknown bridge ${String(op.id)}`, objectIds: [String(op.id)] }); break; }
        spec.bridges.splice(idx, 1); changedIds.push(String(op.id)); break;
      }
      case 'set_hazard': {
        spec.hazard.kind = op.kind as WorldSpec['hazard']['kind'];
        spec.hazard.policy.scorePenalty = op.kind === 'lava' ? 1 : 0;
        changedIds.push('hazard'); break;
      }
      case 'set_title': { spec.title = String(op.title); changedIds.push('title'); break; }
      case 'add_decoration': {
        const id = String(op.id);
        if (allIds().has(id)) { issues.push({ code: 'DUPLICATE_ID', message: `id ${id} already exists`, objectIds: [id] }); break; }
        if (!spec.islands.some((i) => i.id === op.islandId)) { issues.push({ code: 'INVALID_REFERENCE', message: `unknown island ${String(op.islandId)}`, objectIds: [String(op.islandId)] }); break; }
        spec.decorations.push({ id, type: op.type as WorldSpec['decorations'][number]['type'], supportingSurfaceId: String(op.islandId), localPosition: op.localPosition as { x: number; z: number }, rotationDeg: typeof op.rotationDeg === 'number' ? op.rotationDeg : 0, scale: typeof op.scale === 'number' ? op.scale : 1 });
        changedIds.push(id); break;
      }
      case 'move_decoration': case 'remove_decoration': {
        const idx = spec.decorations.findIndex((d) => d.id === op.id);
        if (idx < 0) { issues.push({ code: 'INVALID_REFERENCE', message: `unknown decoration ${String(op.id)}`, objectIds: [String(op.id)] }); break; }
        if (op.op === 'remove_decoration') spec.decorations.splice(idx, 1);
        else { spec.decorations[idx].supportingSurfaceId = String(op.islandId); spec.decorations[idx].localPosition = op.localPosition as { x: number; z: number }; }
        changedIds.push(String(op.id)); break;
      }
      case 'move_relic': {
        const relic = spec.relics.find((r) => r.id === op.id);
        if (!relic) { issues.push({ code: 'INVALID_REFERENCE', message: `unknown relic ${String(op.id)}`, objectIds: [String(op.id)] }); break; }
        relic.supportingSurfaceId = String(op.islandId); relic.localPosition = op.localPosition as { x: number; z: number };
        changedIds.push(relic.id); break;
      }
      default:
        issues.push({ code: 'UNKNOWN_OPERATION', message: `unknown op ${op.op}`, objectIds: [] });
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, spec, changedIds };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
