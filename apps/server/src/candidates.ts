// Candidate specs, validation proofs and commit prechecks. Candidates never touch the active world.
import { randomInt } from 'node:crypto';
import {
  PatchDraftSchema, SIMULATION, VALIDATOR_VERSION, WorldSpecSchema,
  type CommitResult, type PlayabilityReport, type ValidationCode, type ValidationIssue, type ValidationProof, type ValidationResult, type WorldSpec,
} from '@beetle/contracts';
import type { ZodError } from 'zod';
import {
  applyPatch, compileWorld, expandDraft, runPlayabilityChecks, specDigest, validateSpec,
  type CompiledWorld, type LiveContext,
} from '@beetle/world';
import { hex32, shortId } from './clock.ts';

export type CandidateKind = 'world' | 'patch';

export type Candidate = {
  candidateId: string;
  requestId: string;
  kind: CandidateKind;
  patchId?: string;
  baseWorldVersion: number;
  spec: WorldSpec;
  digest: string;
  changedIds: string[];
  patchSummary?: string;
  createdAt: number;
  /** Set once the candidate validated ok; reused by playability and commit. */
  compiled: CompiledWorld | null;
  validatedOk: boolean;
};

export type StageResult = { ok: true; candidate: Candidate } | { ok: false; issues: ValidationIssue[] };

export type CommitPrecheck =
  | { ok: true; candidate: Candidate; proof: ValidationProof }
  | { ok: false; status: number; result: CommitResult };

const CANDIDATE_RING = 200;

export function zodIssues(error: ZodError, code: ValidationIssue['code'] = 'INVALID_SCHEMA'): ValidationIssue[] {
  return error.issues.slice(0, 32).map((iss) => {
    const path = iss.path.join('.');
    const isDiscriminator = iss.code === 'invalid_union_discriminator';
    return {
      code: isDiscriminator ? 'UNKNOWN_OPERATION' : code,
      message: (path ? `${path}: ` : '') + iss.message.slice(0, 300),
      objectIds: [],
      evidence: { path, zod: iss.code },
    };
  });
}

function issueResult(code: ValidationCode, message: string, objectIds: string[] = [], retryable = false): CommitResult {
  return { ok: false, code, message, objectIds, retryable };
}

export class CandidateStore {
  private readonly candidates = new Map<string, Candidate>();
  private readonly order: string[] = [];
  private readonly proofs = new Map<string, ValidationProof>();
  /** patchId (or candidateId for world candidates) -> first commit result, for idempotent replays. */
  private readonly committed = new Map<string, CommitResult>();

  get(id: string): Candidate | undefined {
    return this.candidates.get(id);
  }

  proof(proofId: string): ValidationProof | undefined {
    return this.proofs.get(proofId);
  }

  size(): number {
    return this.candidates.size;
  }

  private remember(candidate: Candidate): Candidate {
    this.candidates.set(candidate.candidateId, candidate);
    this.order.push(candidate.candidateId);
    if (this.order.length > CANDIDATE_RING) {
      for (const id of this.order.splice(0, this.order.length - CANDIDATE_RING)) this.candidates.delete(id);
    }
    return candidate;
  }

  /** Stages a full spec (used by world/patch staging and by undo). */
  stageSpec(
    requestId: string,
    kind: CandidateKind,
    spec: WorldSpec,
    baseWorldVersion: number,
    now: number,
    extra: { patchId?: string; changedIds?: string[]; patchSummary?: string } = {},
  ): Candidate {
    const withBase: WorldSpec = { ...spec, worldVersion: baseWorldVersion };
    const candidate: Candidate = {
      candidateId: shortId('cand'),
      requestId,
      kind,
      baseWorldVersion,
      spec: withBase,
      digest: specDigest(withBase),
      changedIds: extra.changedIds ?? [],
      createdAt: now,
      compiled: null,
      validatedOk: false,
    };
    if (extra.patchId) candidate.patchId = extra.patchId;
    if (extra.patchSummary) candidate.patchSummary = extra.patchSummary;
    return this.remember(candidate);
  }

  /** Accepts a WorldDraft (expanded) or a full WorldSpec. */
  stageWorld(requestId: string, input: unknown, baseWorldVersion: number, now: number): StageResult {
    const looksLikeSpec = Boolean(input && typeof input === 'object' && ('schemaVersion' in (input as object) || 'worldId' in (input as object)));
    if (looksLikeSpec) {
      const parsed = WorldSpecSchema.safeParse(input);
      if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
      const ids = allIds(parsed.data);
      return { ok: true, candidate: this.stageSpec(requestId, 'world', parsed.data, baseWorldVersion, now, { changedIds: ids }) };
    }
    const expanded = expandDraft(input, { seed: randomInt(0, 2147483647), worldId: shortId('world'), worldVersion: baseWorldVersion });
    if (!expanded.ok) return { ok: false, issues: expanded.issues };
    const draftTitle = input && typeof input === 'object' && typeof (input as { title?: unknown }).title === 'string' ? (input as { title: string }).title : undefined;
    return {
      ok: true,
      candidate: this.stageSpec(requestId, 'world', expanded.spec, baseWorldVersion, now, { changedIds: allIds(expanded.spec), patchSummary: draftTitle }),
    };
  }

  /** Applies a PatchDraft to a clone of the base spec. */
  stagePatch(requestId: string, baseSpec: WorldSpec, patchInput: unknown, baseWorldVersion: number, collectedRelicIds: string[], now: number): StageResult {
    const parsed = PatchDraftSchema.safeParse(patchInput);
    if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
    const applied = applyPatch(baseSpec, parsed.data, { collectedRelicIds });
    if (!applied.ok) return { ok: false, issues: applied.issues };
    const patchId = shortId('patch');
    return {
      ok: true,
      candidate: this.stageSpec(requestId, 'patch', applied.spec, baseWorldVersion, now, {
        patchId,
        changedIds: applied.changedIds,
        patchSummary: parsed.data.summary,
      }),
    };
  }

  validate(candidate: Candidate, ctx: LiveContext, currentVersion: number, now: number): ValidationResult {
    const started = performance.now();
    const base = {
      candidateId: candidate.candidateId,
      candidateDigest: candidate.digest,
      baseWorldVersion: candidate.baseWorldVersion,
      validatorVersion: VALIDATOR_VERSION,
    };
    if (candidate.baseWorldVersion !== currentVersion) {
      return {
        ...base,
        ok: false,
        issues: [{
          code: 'STALE_WORLD_VERSION',
          message: `candidate is based on world version ${candidate.baseWorldVersion} but the current version is ${currentVersion}; read the world again and rebuild the patch`,
          objectIds: [],
          evidence: { baseWorldVersion: candidate.baseWorldVersion, currentVersion },
        }],
        durationMs: round(performance.now() - started),
      };
    }
    let outcome;
    try {
      outcome = validateSpec(candidate.spec, ctx);
    } catch (err) {
      return {
        ...base,
        ok: false,
        issues: [{ code: 'INTERNAL', message: `validator error: ${errorMessage(err)}`, objectIds: [] }],
        durationMs: round(performance.now() - started),
      };
    }
    const issues = outcome.issues ?? [];
    if (!outcome.ok) {
      candidate.validatedOk = false;
      if (outcome.compiled) candidate.compiled = outcome.compiled;
      return { ...base, ok: false, issues, durationMs: round(performance.now() - started) };
    }
    candidate.compiled = outcome.compiled;
    candidate.validatedOk = true;
    const proof: ValidationProof = {
      proofId: hex32(),
      candidateId: candidate.candidateId,
      candidateDigest: candidate.digest,
      baseWorldVersion: candidate.baseWorldVersion,
      validatorVersion: VALIDATOR_VERSION,
      issuedAt: now,
      expiresAt: now + SIMULATION.validationProofTtlMs,
    };
    this.proofs.set(proof.proofId, proof);
    this.pruneProofs(now);
    return { ...base, ok: true, issues, proof, durationMs: round(performance.now() - started) };
  }

  private pruneProofs(now: number): void {
    if (this.proofs.size < 500) return;
    for (const [id, p] of this.proofs) if (p.expiresAt + 60_000 < now) this.proofs.delete(id);
  }

  playability(candidate: Candidate, ctx: LiveContext): PlayabilityReport {
    const started = performance.now();
    let compiled = candidate.compiled;
    try {
      if (!compiled) {
        compiled = compileWorld(candidate.spec);
        candidate.compiled = compiled;
      }
      const report = runPlayabilityChecks(compiled, ctx);
      return { ...report, candidateId: candidate.candidateId };
    } catch (err) {
      return {
        ok: false,
        candidateId: candidate.candidateId,
        checks: [{ name: 'compile', ok: false, detail: `could not run checks: ${errorMessage(err)}`, objectIds: [] }],
        routes: [],
        durationMs: round(performance.now() - started),
        note: 'connectivity and supported-movement checks only; not a fun or completeness guarantee',
      };
    }
  }

  replayKey(candidate: Candidate): string {
    return candidate.patchId ?? candidate.candidateId;
  }

  /** Checks in order: UNKNOWN_CANDIDATE, idempotent replay, NOT_VALIDATED/DIGEST_MISMATCH, VALIDATION_EXPIRED, STALE_WORLD_VERSION. */
  precheck(candidateId: string, proofId: string, currentVersion: number, now: number): CommitPrecheck {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      return { ok: false, status: 404, result: issueResult('UNKNOWN_CANDIDATE', `no candidate ${candidateId}`, [candidateId]) };
    }
    const replay = this.committed.get(this.replayKey(candidate));
    if (replay && replay.ok) {
      return { ok: false, status: 200, result: { ...replay, idempotentReplay: true } };
    }
    const proof = this.proofs.get(proofId);
    if (!proof) {
      return { ok: false, status: 409, result: issueResult('NOT_VALIDATED', 'no validation proof for this candidate; call validate first', [candidateId]) };
    }
    if (proof.candidateId !== candidate.candidateId || proof.candidateDigest !== candidate.digest) {
      return { ok: false, status: 409, result: issueResult('DIGEST_MISMATCH', 'the proof was issued for a different candidate', [candidateId]) };
    }
    if (proof.expiresAt <= now) {
      return { ok: false, status: 409, result: issueResult('VALIDATION_EXPIRED', 'validation proof expired; validate again', [candidateId], true) };
    }
    if (candidate.baseWorldVersion !== currentVersion) {
      return {
        ok: false,
        status: 409,
        result: issueResult('STALE_WORLD_VERSION', `candidate base version ${candidate.baseWorldVersion} is not the current version ${currentVersion}`, [candidateId]),
      };
    }
    return { ok: true, candidate, proof };
  }

  recordCommitted(candidate: Candidate, result: CommitResult): void {
    if (result.ok) this.committed.set(this.replayKey(candidate), result);
  }

  /** Drops compiled geometry held by candidates that can no longer commit (base version behind the live world). */
  dropStaleCompiled(currentVersion: number): number {
    let dropped = 0;
    for (const c of this.candidates.values()) {
      if (c.compiled && c.baseWorldVersion < currentVersion) {
        c.compiled = null;
        dropped += 1;
      }
    }
    return dropped;
  }

  hasCommitted(candidate: Candidate): boolean {
    return this.committed.has(this.replayKey(candidate));
  }
}

function allIds(spec: WorldSpec): string[] {
  return [
    ...spec.islands.map((i) => i.id),
    ...spec.bridges.map((b) => b.id),
    ...spec.spawns.map((s) => s.id),
    ...spec.relics.map((r) => r.id),
    spec.gate.id,
    ...spec.decorations.map((d) => d.id),
  ];
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
