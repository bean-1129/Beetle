import { z } from 'zod';

export const VALIDATION_CODES = [
  'INVALID_SCHEMA', 'UNKNOWN_OPERATION', 'UNSUPPORTED_OPERATION', 'DUPLICATE_ID', 'INVALID_REFERENCE', 'RESOURCE_LIMIT',
  'OUT_OF_BOUNDS', 'OBJECT_NOT_ON_SURFACE', 'ISLAND_OVERLAP', 'BRIDGE_ENDPOINT_GAP', 'BRIDGE_TOO_NARROW', 'BRIDGE_LENGTH',
  'BRIDGE_CROSSES_ISLAND', 'BRIDGE_DUPLICATE', 'UNREACHABLE_SPAWN', 'UNREACHABLE_RELIC', 'DISCONNECTED_GOAL', 'GATE_HIDES_RELIC', 'PLAYER_CUT_OFF',
  'STALE_WORLD_VERSION', 'OCCUPIED_SUPPORT', 'VALIDATION_EXPIRED', 'DIGEST_MISMATCH', 'UNKNOWN_CANDIDATE', 'NOT_VALIDATED',
  'COMMIT_DEFERRED', 'RELIC_ALREADY_COLLECTED', 'MODE_INVALID', 'INTERNAL',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export const ValidationIssueSchema = z.object({
  code: z.enum(VALIDATION_CODES),
  message: z.string().max(400),
  objectIds: z.array(z.string().max(64)).max(32).default([]),
  evidence: z.record(z.unknown()).optional(),
}).strict();
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Server-issued; the agent cannot manufacture one. Bound to candidate digest, base version, validator version, expiry. */
export const ValidationProofSchema = z.object({
  proofId: z.string().min(16).max(64),
  candidateId: z.string().max(64),
  candidateDigest: z.string().length(64),
  baseWorldVersion: z.number().int().min(0),
  validatorVersion: z.number().int(),
  issuedAt: z.number(),
  expiresAt: z.number(),
}).strict();
export type ValidationProof = z.infer<typeof ValidationProofSchema>;

export type ValidationResult = {
  ok: boolean;
  candidateId: string;
  candidateDigest: string;
  baseWorldVersion: number;
  validatorVersion: number;
  issues: ValidationIssue[];
  proof?: ValidationProof; // present only when ok
  durationMs: number;
};

export type PlayabilityCheck = { name: string; ok: boolean; detail: string; objectIds: string[] };
export type PlayabilityReport = {
  ok: boolean;
  candidateId: string;
  checks: PlayabilityCheck[];
  routes: { fromId: string; toId: string; reachable: boolean; cells?: number }[];
  durationMs: number;
  note: 'connectivity and supported-movement checks only; not a fun or completeness guarantee';
};

export type CommitResult =
  | { ok: true; worldVersion: number; patchId?: string; committedAtTick: number; deferredMs: number; idempotentReplay: boolean }
  | { ok: false; code: ValidationCode; message: string; objectIds: string[]; retryable: boolean };
