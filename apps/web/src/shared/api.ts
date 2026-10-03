import { ROUTES } from '@beetle/contracts';
import type { AgentActivity, BuildReport, CommitResult, DirectorRequest, RequestKind } from '@beetle/contracts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type HealthInfo = {
  ok: boolean;
  worldVersion: number;
  hasWorld: boolean;
  players: number;
  connectedControllers: number;
  model: { name: string; reachable: boolean; present: boolean };
  agentConnected: boolean;
  publicUrl: string;
  uptimeMs: number;
  /** Streaming generation switch as the server reports it; null when the health route does not carry it. */
  autoExpand: boolean | null;
};

export type DirectorSettings = { autoExpand: boolean };

export type InviteResult = { inviteCode: string; url: string; expiresAt: number; slot?: number };
export type JoinResult = { controllerToken: string; playerId: string; label: string; color: string; slot?: number };

async function request<T>(path: string, init: { method?: string; body?: unknown; token?: string | null; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ApiError(0, 'NETWORK', err instanceof Error && err.name === 'AbortError' ? 'request timed out' : 'server unreachable');
  }
  clearTimeout(timer);
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { code?: unknown; message?: unknown; error?: unknown };
    const code = typeof d.code === 'string' ? d.code : typeof d.error === 'string' ? d.error : `HTTP_${res.status}`;
    const message = typeof d.message === 'string' ? d.message : res.statusText || 'request failed';
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

function asString(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback; }
function asNumber(v: unknown, fallback = 0): number { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function asBool(v: unknown, fallback = false): boolean { return typeof v === 'boolean' ? v : fallback; }

/** Tolerant parse: the health route is public and its exact shape may still move. */
export async function getHealth(): Promise<HealthInfo> {
  const raw = await request<Record<string, unknown>>(ROUTES.health, { timeoutMs: 4000 });
  const r = raw ?? {};
  const m = (r.model && typeof r.model === 'object' ? r.model : {}) as Record<string, unknown>;
  const modelName = asString(m.name, typeof r.model === 'string' ? (r.model as string) : asString(r.modelName, 'unknown'));
  return {
    ok: asBool(r.ok, true),
    worldVersion: asNumber(r.worldVersion, 0),
    hasWorld: asBool(r.hasWorld, asNumber(r.worldVersion, 0) > 0),
    players: asNumber(r.players, 0),
    connectedControllers: asNumber(r.connectedControllers, 0),
    model: { name: modelName, reachable: asBool(m.reachable, asBool(r.modelReachable)), present: asBool(m.present, asBool(r.modelPresent)) },
    agentConnected: asBool(r.agentConnected, false),
    publicUrl: asString(r.publicUrl, location.origin),
    uptimeMs: asNumber(r.uptimeMs, 0),
    autoExpand: readAutoExpand(r),
  };
}

function readAutoExpand(r: Record<string, unknown>): boolean | null {
  if (typeof r.autoExpand === 'boolean') return r.autoExpand;
  const s = (r.settings && typeof r.settings === 'object' ? r.settings : r.streaming && typeof r.streaming === 'object' ? r.streaming : null) as Record<string, unknown> | null;
  return s && typeof s.autoExpand === 'boolean' ? s.autoExpand : null;
}

export function createInvite(token: string): Promise<InviteResult> {
  return request<InviteResult>(ROUTES.directorInvite, { method: 'POST', body: {}, token });
}

export function joinWithInvite(inviteCode: string): Promise<JoinResult> {
  return request<JoinResult>(ROUTES.join, { method: 'POST', body: { inviteCode } });
}

export function createDirectorRequest(token: string, body: { kind: RequestKind; prompt: string; authorizeNewWorld?: boolean }): Promise<{ request: DirectorRequest }> {
  return request<{ request: DirectorRequest }>(ROUTES.directorRequest, { method: 'POST', body, token });
}

/** One director request by id (used to tag automatic streaming extensions in the activity trail). Null when the server does not know it. */
export async function getDirectorRequest(token: string, id: string): Promise<DirectorRequest | null> {
  const path = ROUTES.directorRequestById.replace(':id', encodeURIComponent(id));
  const r = await request<{ request?: DirectorRequest } | DirectorRequest | null>(path, { token });
  if (!r || typeof r !== 'object') return null;
  if ('request' in r && r.request && typeof r.request === 'object') return r.request;
  return 'id' in r && typeof r.id === 'string' ? (r as DirectorRequest) : null;
}

/** Streaming generation switch: POST /api/director/settings { autoExpand }. Tolerant of a bare or nested response. */
export async function setDirectorSettings(token: string, body: DirectorSettings): Promise<DirectorSettings> {
  const r = await request<Record<string, unknown> | null>(ROUTES.directorSettings, { method: 'POST', body, token });
  const raw = r ?? {};
  const nested = (raw.settings && typeof raw.settings === 'object' ? raw.settings : raw) as Record<string, unknown>;
  return { autoExpand: asBool(nested.autoExpand, body.autoExpand) };
}

export async function getActivity(token: string, limit = 100): Promise<AgentActivity[]> {
  const r = await request<{ entries?: AgentActivity[] }>(`${ROUTES.directorActivity}?limit=${limit}`, { token });
  return Array.isArray(r?.entries) ? r.entries : [];
}

export async function getReports(token: string): Promise<BuildReport[]> {
  const r = await request<{ reports?: BuildReport[] }>(ROUTES.directorReports, { token });
  return Array.isArray(r?.reports) ? r.reports : [];
}

export function undo(token: string): Promise<CommitResult> {
  return request<CommitResult>(ROUTES.directorUndo, { method: 'POST', body: {}, token, timeoutMs: 15000 });
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.code ? `${err.code}: ${err.message}` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
