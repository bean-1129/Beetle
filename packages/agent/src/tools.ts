// The seven Beetle tools as thin HTTP clients to the loopback-only agent routes, plus request lifecycle calls.
// Every call records { tool, ok, ms } for the build report. Model output is only ever forwarded as JSON data.
import {
  ROUTES,
  type CommitResult,
  type DirectorRequest,
  type PlayabilityReport,
  type SessionSummary,
  type ValidationIssue,
  type ValidationResult,
  type WorldSpec,
  type AgentPhase,
  type ValidationCode,
  type BuildReport,
} from '@beetle/contracts';
import { assertLoopbackUrl } from './config.ts';

export const BEETLE_TOOL_NAMES = [
  'read_world_state',
  'propose_world',
  'propose_patch',
  'validate_candidate',
  'run_playability_checks',
  'commit_candidate',
  'publish_build_report',
] as const;
export type BeetleToolName = (typeof BEETLE_TOOL_NAMES)[number];

export type ToolCallRecord = { tool: string; ok: boolean; ms: number };

export type WorldStateResult = { hasWorld: boolean; version: number; spec: WorldSpec | null; summary: SessionSummary | null };
export type IssueList = Pick<ValidationIssue, 'code' | 'message' | 'objectIds' | 'evidence'>[];
export type ProposeWorldResult =
  | { ok: true; candidateId: string; digest: string; baseWorldVersion: number }
  | { ok: false; issues: IssueList };
export type ProposePatchResult =
  | { ok: true; candidateId: string; patchId: string; digest: string; baseWorldVersion: number; changedIds: string[] }
  | { ok: false; issues: IssueList };
export type ValidateResult = {
  ok: boolean;
  candidateId: string;
  baseWorldVersion: number;
  issues: IssueList;
  proofId?: string;
  proofExpiresAt?: number;
  durationMs: number;
};
export type PlayabilityResult = {
  ok: boolean;
  candidateId: string;
  checks: number;
  failed: { name: string; detail: string; objectIds: string[] }[];
  routes: { total: number; unreachable: { fromId: string; toId: string }[] };
  durationMs: number;
};
export type StatusBody = { phase: AgentPhase; message: string; tool?: string; codes?: string[]; objectIds?: string[] };
export type FinishBody = { outcome: 'committed' | 'failed' | 'cancelled'; worldVersion?: number; reportId?: string; error?: { code: string; message: string } };
export type ReportBody = Omit<BuildReport, 'reportId' | 'createdAt'>;

export class BeetleHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string, public readonly body: unknown) {
    super(`Beetle server ${status} on ${path}`);
    this.name = 'BeetleHttpError';
  }
}

export type BeetleClientOptions = {
  serverUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retry once on network failure or 5xx (default true). */
  retryOnServerError?: boolean;
  onRecord?: (rec: ToolCallRecord) => void;
};

export type BeetleClient = {
  readonly serverUrl: string;
  readonly records: ToolCallRecord[];
  resetRecords(): void;
  /** Per-call HTTP timeout used by the tool calls; jobs clip it to the remaining request deadline. */
  setCallTimeout(ms: number): void;
  // The seven tools
  read_world_state(): Promise<WorldStateResult>;
  propose_world(requestId: string, spec: unknown): Promise<ProposeWorldResult>;
  propose_patch(requestId: string, patch: unknown): Promise<ProposePatchResult>;
  validate_candidate(candidateId: string): Promise<ValidateResult>;
  run_playability_checks(candidateId: string): Promise<PlayabilityResult>;
  commit_candidate(candidateId: string, proofId: string): Promise<CommitResult>;
  publish_build_report(report: ReportBody): Promise<{ reportId: string }>;
  // Request lifecycle (not model-facing)
  claim(workerId: string, timeoutMs?: number): Promise<DirectorRequest | null>;
  status(requestId: string, body: StatusBody): Promise<{ ok: boolean; cancelled: boolean }>;
  finish(requestId: string, body: FinishBody): Promise<{ ok: boolean }>;
  health(timeoutMs?: number): Promise<{ reachable: boolean; body?: Record<string, unknown> }>;
};

type HttpResult = { status: number; json: unknown };

export function createBeetleClient(opts: BeetleClientOptions): BeetleClient {
  const serverUrl = assertLoopbackUrl(opts.serverUrl, 'BEETLE_SERVER_URL');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? 30_000;
  let timeoutMs = defaultTimeoutMs;
  const retry = opts.retryOnServerError ?? true;
  const records: ToolCallRecord[] = [];

  function record(tool: string, ok: boolean, ms: number) {
    const rec = { tool, ok, ms: Math.round(ms) };
    records.push(rec);
    opts.onRecord?.(rec);
  }

  async function once(method: string, path: string, body: unknown, callTimeoutMs: number): Promise<HttpResult> {
    const res = await fetchImpl(serverUrl + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(callTimeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; } }
    return { status: res.status, json };
  }

  /** One retry on network error or 5xx. 4xx is returned to the caller. */
  async function http(method: string, path: string, body: unknown, tool: string | null, callTimeoutMs?: number): Promise<HttpResult> {
    callTimeoutMs ??= timeoutMs;
    const t0 = performance.now();
    let attempt = 0;
    for (;;) {
      attempt++;
      let result: HttpResult | null = null;
      let failure: Error | null = null;
      try {
        result = await once(method, path, body, callTimeoutMs);
        if (result.status >= 500) failure = new BeetleHttpError(result.status, path, result.json);
      } catch (err) {
        failure = err as Error;
      }
      if (!failure && result) {
        if (tool) record(tool, result.status < 400, performance.now() - t0);
        return result;
      }
      if (retry && attempt < 2) { await sleep(250); continue; }
      if (tool) record(tool, false, performance.now() - t0);
      throw failure instanceof BeetleHttpError ? failure : new BeetleHttpError(0, path, { message: (failure as Error).message });
    }
  }

  function issuesOf(json: unknown): IssueList {
    const arr = (json as { issues?: unknown })?.issues;
    if (!Array.isArray(arr)) return [{ code: 'INTERNAL', message: 'server returned no issues', objectIds: [] }];
    return arr.map((i) => compactIssue(i as ValidationIssue));
  }

  function expectOk(res: HttpResult, path: string): Record<string, unknown> {
    if (res.status >= 400) throw new BeetleHttpError(res.status, path, res.json);
    return (res.json ?? {}) as Record<string, unknown>;
  }

  const client: BeetleClient = {
    serverUrl,
    records,
    resetRecords: () => { records.length = 0; },
    setCallTimeout: (ms) => { timeoutMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, defaultTimeoutMs) : defaultTimeoutMs; },

    async read_world_state() {
      const res = await http('GET', ROUTES.agentWorld, undefined, 'read_world_state');
      const j = expectOk(res, ROUTES.agentWorld);
      return {
        hasWorld: Boolean(j.hasWorld),
        version: typeof j.version === 'number' ? j.version : 0,
        spec: (j.spec as WorldSpec | null) ?? null,
        summary: (j.summary as SessionSummary | null) ?? null,
      };
    },

    async propose_world(requestId, spec) {
      const res = await http('POST', ROUTES.agentProposeWorld, { requestId, spec }, 'propose_world');
      if (res.status === 400) return { ok: false, issues: issuesOf(res.json) };
      const j = expectOk(res, ROUTES.agentProposeWorld);
      return { ok: true, candidateId: String(j.candidateId), digest: String(j.digest), baseWorldVersion: Number(j.baseWorldVersion) };
    },

    async propose_patch(requestId, patch) {
      const res = await http('POST', ROUTES.agentProposePatch, { requestId, patch }, 'propose_patch');
      if (res.status === 400) return { ok: false, issues: issuesOf(res.json) };
      const j = expectOk(res, ROUTES.agentProposePatch);
      return {
        ok: true,
        candidateId: String(j.candidateId),
        patchId: String(j.patchId),
        digest: String(j.digest),
        baseWorldVersion: Number(j.baseWorldVersion),
        changedIds: Array.isArray(j.changedIds) ? (j.changedIds as string[]) : [],
      };
    },

    async validate_candidate(candidateId) {
      const path = ROUTES.agentValidate.replace(':id', encodeURIComponent(candidateId));
      const res = await http('POST', path, {}, 'validate_candidate');
      const j = expectOk(res, path) as unknown as ValidationResult;
      return {
        ok: Boolean(j.ok),
        candidateId: j.candidateId ?? candidateId,
        baseWorldVersion: j.baseWorldVersion ?? 0,
        issues: (j.issues ?? []).map(compactIssue),
        proofId: j.ok && j.proof ? j.proof.proofId : undefined,
        proofExpiresAt: j.ok && j.proof ? j.proof.expiresAt : undefined,
        durationMs: j.durationMs ?? 0,
      };
    },

    async run_playability_checks(candidateId) {
      const path = ROUTES.agentPlayability.replace(':id', encodeURIComponent(candidateId));
      const res = await http('POST', path, {}, 'run_playability_checks');
      const j = expectOk(res, path) as unknown as PlayabilityReport;
      const checks = j.checks ?? [];
      const routes = j.routes ?? [];
      return {
        ok: Boolean(j.ok),
        candidateId: j.candidateId ?? candidateId,
        checks: checks.length,
        failed: checks.filter((c) => !c.ok).slice(0, 8).map((c) => ({ name: c.name, detail: String(c.detail).slice(0, 200), objectIds: (c.objectIds ?? []).slice(0, 8) })),
        routes: { total: routes.length, unreachable: routes.filter((r) => !r.reachable).slice(0, 8).map((r) => ({ fromId: r.fromId, toId: r.toId })) },
        durationMs: j.durationMs ?? 0,
      };
    },

    async commit_candidate(candidateId, proofId) {
      const path = ROUTES.agentCommit.replace(':id', encodeURIComponent(candidateId));
      const res = await http('POST', path, { proofId }, 'commit_candidate');
      const j = res.json as Record<string, unknown> | null;
      if (j && typeof j.ok === 'boolean') return j as unknown as CommitResult;
      if (res.status >= 400) {
        const code = (j && typeof j.code === 'string' ? j.code : 'INTERNAL') as ValidationCode;
        return { ok: false, code, message: j && typeof j.message === 'string' ? j.message : `commit rejected with HTTP ${res.status}`, objectIds: [], retryable: false };
      }
      throw new BeetleHttpError(res.status, path, j);
    },

    async publish_build_report(report) {
      const res = await http('POST', ROUTES.agentReports, report, 'publish_build_report');
      const j = expectOk(res, ROUTES.agentReports);
      return { reportId: String(j.reportId) };
    },

    async claim(workerId, claimTimeoutMs = 35_000) {
      const res = await http('POST', ROUTES.agentRequestsClaim, { workerId }, null, claimTimeoutMs);
      if (res.status === 204 || res.json === null) return null;
      const j = expectOk(res, ROUTES.agentRequestsClaim);
      const request = j.request as DirectorRequest | undefined;
      return request && typeof request.id === 'string' ? request : null;
    },

    async status(requestId, body) {
      const path = ROUTES.agentRequestStatus.replace(':id', encodeURIComponent(requestId));
      const res = await http('POST', path, body, null);
      const j = (res.json ?? {}) as Record<string, unknown>;
      // A cancelled request is reported by the server either as 409/410 or as { ok: false, status: 'cancelled' }.
      const cancelled = res.status === 409 || res.status === 410 || j.status === 'cancelled' || j.cancelled === true;
      if (res.status >= 400 && !cancelled) throw new BeetleHttpError(res.status, path, res.json);
      return { ok: j.ok === true, cancelled };
    },

    async finish(requestId, body) {
      const path = ROUTES.agentRequestFinish.replace(':id', encodeURIComponent(requestId));
      const res = await http('POST', path, body, null);
      const j = expectOk(res, path);
      return { ok: j.ok === true };
    },

    async health(healthTimeoutMs = 1500) {
      try {
        const res = await fetchImpl(serverUrl + ROUTES.health, { signal: AbortSignal.timeout(healthTimeoutMs) });
        if (!res.ok) return { reachable: false };
        return { reachable: true, body: (await res.json()) as Record<string, unknown> };
      } catch {
        return { reachable: false };
      }
    },
  };
  return client;
}

export function compactIssue(i: ValidationIssue): IssueList[number] {
  const out: IssueList[number] = { code: i.code, message: String(i.message ?? '').slice(0, 300), objectIds: (i.objectIds ?? []).slice(0, 16) };
  if (i.evidence && typeof i.evidence === 'object') {
    const ev: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(i.evidence)) {
      if (n++ >= 8) break;
      ev[k] = typeof v === 'string' ? v.slice(0, 120) : v;
    }
    out.evidence = ev;
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
