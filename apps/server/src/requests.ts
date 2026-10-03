// Director requests, agent long-poll claims, activity ring and build reports.
import {
  type AgentActivity, type AgentPhase, type BuildReport, type DirectorRequest, type RequestKind, type ValidationCode,
} from '@beetle/contracts';
import { shortId } from './clock.ts';

export const ACTIVITY_RING = 500;
export const REPORT_RING = 100;
export const CLAIM_LONG_POLL_MS = 25_000;
export const AGENT_CONNECTED_WINDOW_MS = 30_000;

export type RequestRecord = {
  request: DirectorRequest;
  /** Director authorised replacing the world while players are connected. Internal, never sent to the agent. */
  authorizeNewWorld: boolean;
};

type Waiter = { resolve: (req: DirectorRequest | null) => void; timer: NodeJS.Timeout };

export type ActivityInput = {
  phase: AgentPhase;
  message: string;
  tool?: string;
  codes?: string[];
  objectIds?: string[];
};

export class RequestStore {
  private readonly records = new Map<string, RequestRecord>();
  private readonly order: string[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly activity: AgentActivity[] = [];
  private readonly reports: BuildReport[] = [];
  private activityCounter = 0;
  lastClaimAt = 0;

  constructor(private readonly now: () => number) {}

  create(kind: RequestKind, prompt: string, worldVersion: number, authorizeNewWorld: boolean): DirectorRequest {
    const request: DirectorRequest = {
      id: shortId('req'),
      kind,
      prompt,
      createdAt: this.now(),
      worldVersionAtRequest: worldVersion,
      status: 'queued',
    };
    this.records.set(request.id, { request, authorizeNewWorld });
    this.order.push(request.id);
    if (this.order.length > 200) {
      const drop = this.order.splice(0, this.order.length - 200);
      for (const id of drop) this.records.delete(id);
    }
    // Wake one long-poller; it claims through claim() again.
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(request);
    }
    return request;
  }

  get(id: string): DirectorRequest | undefined {
    return this.records.get(id)?.request;
  }

  record(id: string): RequestRecord | undefined {
    return this.records.get(id);
  }

  list(): DirectorRequest[] {
    return this.order.map((id) => this.records.get(id)?.request).filter((r): r is DirectorRequest => Boolean(r));
  }

  private nextQueued(): DirectorRequest | null {
    for (const id of this.order) {
      const rec = this.records.get(id);
      if (rec && rec.request.status === 'queued') return rec.request;
    }
    return null;
  }

  /** Resolves with a claimed request, or null after timeoutMs. Claiming sets status planning and claimedBy. */
  async claim(workerId: string, timeoutMs = CLAIM_LONG_POLL_MS): Promise<DirectorRequest | null> {
    this.lastClaimAt = this.now();
    const immediate = this.nextQueued();
    if (immediate) return this.markClaimed(immediate, workerId);
    const woken = await new Promise<DirectorRequest | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, timer });
    });
    this.lastClaimAt = this.now();
    if (!woken) return null;
    // The woken request may have been claimed by another worker in the meantime.
    const fresh = this.records.get(woken.id)?.request;
    if (fresh && fresh.status === 'queued') return this.markClaimed(fresh, workerId);
    const other = this.nextQueued();
    return other ? this.markClaimed(other, workerId) : null;
  }

  private markClaimed(request: DirectorRequest, workerId: string): DirectorRequest {
    request.status = 'planning';
    request.claimedBy = workerId;
    return request;
  }

  /** Cancels pending long-polls (server stop). */
  releaseWaiters(): void {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
  }

  agentConnected(): boolean {
    return this.lastClaimAt > 0 && this.now() - this.lastClaimAt <= AGENT_CONNECTED_WINDOW_MS;
  }

  setStatus(id: string, phase: AgentPhase): DirectorRequest | undefined {
    const req = this.get(id);
    if (!req) return undefined;
    // Terminal statuses are sticky; a late status update never reopens a finished request.
    if (req.status === 'committed' || req.status === 'failed' || req.status === 'cancelled') return req;
    req.status = phase;
    return req;
  }

  finish(id: string, outcome: 'committed' | 'failed' | 'cancelled', extra: { worldVersion?: number; reportId?: string; error?: { code: string; message: string } }): DirectorRequest | undefined {
    const req = this.get(id);
    if (!req) return undefined;
    req.status = outcome;
    req.finishedAt = this.now();
    if (extra.worldVersion !== undefined) req.resultWorldVersion = extra.worldVersion;
    if (extra.reportId) req.reportId = extra.reportId;
    if (extra.error) req.error = extra.error;
    return req;
  }

  addActivity(requestId: string, input: ActivityInput, worldVersion: number | undefined): AgentActivity {
    const req = this.get(requestId);
    const at = this.now();
    this.activityCounter += 1;
    const entry: AgentActivity = {
      id: `act-${this.activityCounter.toString(36)}-${at.toString(36)}`,
      requestId,
      phase: input.phase,
      message: input.message,
      at,
      elapsedMs: req ? Math.max(0, at - req.createdAt) : 0,
    };
    if (worldVersion !== undefined) entry.worldVersion = worldVersion;
    if (input.tool) entry.tool = input.tool;
    if (input.codes && input.codes.length) entry.codes = input.codes as ValidationCode[];
    if (input.objectIds && input.objectIds.length) entry.objectIds = input.objectIds;
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_RING) this.activity.splice(0, this.activity.length - ACTIVITY_RING);
    return entry;
  }

  recentActivity(limit = 100, requestId?: string): AgentActivity[] {
    const list = requestId ? this.activity.filter((a) => a.requestId === requestId) : this.activity;
    return list.slice(-Math.max(1, Math.min(limit, ACTIVITY_RING)));
  }

  addReport(report: BuildReport): void {
    this.reports.push(report);
    if (this.reports.length > REPORT_RING) this.reports.splice(0, this.reports.length - REPORT_RING);
  }

  listReports(): BuildReport[] {
    return [...this.reports];
  }
}
