// Beetle OpenClaw tool plugin: seven thin HTTP tools over the loopback-only agent routes.
// Runs inside the OpenClaw process. Never executes model output; the server validates every candidate.
import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DECORATION_TYPES, HAZARD_KINDS, PATCH_OP_NAMES, WORLD_LIMITS, type ValidationCode } from '@beetle/contracts';
import { createBeetleClient, type BeetleClient, type IssueList, type StatusBody } from '../../src/tools.ts';

const PLUGIN_ID = 'beetle-tools';
const MODE = 'openclaw' as const;

const configSchema = Type.Object({
  serverUrl: Type.Optional(Type.String({ description: 'Beetle server URL (loopback only). Env BEETLE_SERVER_URL overrides.' })),
  secretsPath: Type.Optional(Type.String({ description: 'Path to data/secrets.json holding agentToken. Env BEETLE_AGENT_TOKEN overrides.' })),
  model: Type.Optional(Type.String({ description: 'Model name recorded in build reports.' })),
});
type PluginConfig = { serverUrl?: string; secretsPath?: string; model?: string };

const L = WORLD_LIMITS;
const Id = (description: string) => Type.String({ description, pattern: '^[a-z][a-z0-9_-]{0,31}$' });
const Vec = (description: string) => Type.Object({ x: Type.Number(), z: Type.Number() }, { description });

const worldDraftSchema = Type.Object({
  title: Type.String({ maxLength: L.title.maxLength }),
  islands: Type.Array(Type.Object({ id: Id('island id'), name: Type.String(), center: Vec('world position, metres'), radius: Type.Number({ minimum: L.island.minRadius, maximum: L.island.maxRadius }) }), { minItems: L.islands.min, maxItems: L.islands.max }),
  bridges: Type.Array(Type.Object({ id: Id('bridge id'), from: Type.String(), to: Type.String(), width: Type.Number({ minimum: L.bridge.minWidth, maximum: L.bridge.maxWidth }) }), { maxItems: L.bridges.max }),
  spawns: Type.Array(Type.Object({ islandId: Type.String(), localPosition: Vec('offset from the island centre') }), { minItems: L.spawns, maxItems: L.spawns }),
  relics: Type.Array(Type.Object({ id: Id('relic id'), name: Type.String(), islandId: Type.String(), localPosition: Vec('offset from the island centre') }), { minItems: L.relics, maxItems: L.relics }),
  gate: Type.Object({ islandId: Type.String(), localPosition: Vec('offset from the island centre') }),
  hazard: Type.Union(HAZARD_KINDS.map((h) => Type.Literal(h))),
  decorations: Type.Array(Type.Object({ id: Id('decoration id'), type: Type.Union(DECORATION_TYPES.map((d) => Type.Literal(d))), islandId: Type.String(), localPosition: Vec('offset from the island centre') }), { maxItems: L.decorations.max }),
}, { description: 'WorldDraft: a complete small world. The server derives bridge endpoints, ids and versions.' });

const patchOpSchema = Type.Object({
  op: Type.Union(PATCH_OP_NAMES.map((o) => Type.Literal(o)), { description: 'operation name' }),
  id: Type.Optional(Type.String({ description: 'object id: new id for add_*, existing id for remove_*, move_*' })),
  from: Type.Optional(Type.String({ description: 'add_bridge: island id' })),
  to: Type.Optional(Type.String({ description: 'add_bridge: island id' })),
  width: Type.Optional(Type.Number({ description: `add_bridge: ${L.bridge.minWidth} to ${L.bridge.maxWidth}` })),
  kind: Type.Optional(Type.Union(HAZARD_KINDS.map((h) => Type.Literal(h)), { description: 'set_hazard' })),
  type: Type.Optional(Type.Union(DECORATION_TYPES.map((d) => Type.Literal(d)), { description: 'add_decoration' })),
  islandId: Type.Optional(Type.String({ description: 'add_decoration, move_decoration, move_relic' })),
  localPosition: Type.Optional(Vec('add_decoration, move_decoration, move_relic: offset from the island centre')),
  title: Type.Optional(Type.String({ description: 'set_title' })),
}, { description: 'one patch operation; include only the fields the op needs' });

// ---------- runtime state for one exec run ----------
type RunState = {
  client: BeetleClient | null;
  token: string | null;
  baseWorldVersion: number;
  validationAttempts: number;
  failedCodes: Set<ValidationCode>;
  startedAt: number;
  firstToolAt?: number;
  validatedMs?: number;
  committedMs?: number;
  committedVersion?: number;
  playability?: { ok: boolean; checks: number; failed: number };
  reportId?: string;
  reportOutcome?: 'committed' | 'failed' | 'cancelled';
  summary?: string;
};
const state: RunState = { client: null, token: null, baseWorldVersion: 0, validationAttempts: 0, failedCodes: new Set(), startedAt: Date.now() };

function requestIdFromEnv(): string | undefined {
  return process.env.BEETLE_REQUEST_ID || undefined;
}

/** The request id comes from the worker (BEETLE_REQUEST_ID); the model's argument is only a fallback. */
function effectiveRequestId(fromModel: string | undefined): string {
  const id = requestIdFromEnv() ?? fromModel;
  if (!id) throw new Error('no request id: BEETLE_REQUEST_ID is not set and none was given');
  return id;
}

function resolveToken(config: PluginConfig): string {
  if (state.token) return state.token;
  const fromEnv = process.env.BEETLE_AGENT_TOKEN;
  if (fromEnv) { state.token = fromEnv; return fromEnv; }
  const path = config.secretsPath;
  if (!path) throw new Error('no agent token: set BEETLE_AGENT_TOKEN or configure secretsPath');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { agentToken?: string };
  if (!parsed.agentToken) throw new Error(`no agentToken in ${path}`);
  state.token = parsed.agentToken;
  return state.token;
}

/** Bounded tool budget per exec run (BEETLE_MAX_TOOL_CALLS, default 16). Exceeding it fails the call. */
let toolCallsUsed = 0;
function budget(tool: string) {
  const max = Number(process.env.BEETLE_MAX_TOOL_CALLS) || 16;
  toolCallsUsed++;
  if (toolCallsUsed > max) {
    runLog({ kind: 'budget', tool, ok: false, used: toolCallsUsed, max });
    throw new Error(`tool call budget of ${max} exhausted; call publish_build_report with outcome failed and stop`);
  }
}

function client(config: PluginConfig): BeetleClient {
  if (state.client) return state.client;
  const serverUrl = process.env.BEETLE_SERVER_URL || config.serverUrl || 'http://127.0.0.1:7700';
  state.client = createBeetleClient({ serverUrl, token: resolveToken(config), onRecord: (rec) => runLog({ kind: 'tool', ...rec }) });
  return state.client;
}

/** Evidence channel for the agent worker: one JSON line per tool call in BEETLE_OPENCLAW_RUN_FILE. */
function runLog(entry: Record<string, unknown>) {
  const file = process.env.BEETLE_OPENCLAW_RUN_FILE;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: Date.now(), mode: MODE, ...entry }) + '\n');
  } catch { /* evidence is best effort */ }
}

async function status(config: PluginConfig, body: StatusBody) {
  const requestId = requestIdFromEnv();
  if (!requestId) return;
  try { await client(config).status(requestId, { ...body, message: `[${MODE}] ${body.message}`.slice(0, 400) }); } catch { /* never fail a tool on a status post */ }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function issueText(issues: IssueList): string {
  return issues.slice(0, 8).map((i) => `${i.code}${i.objectIds.length ? ' [' + i.objectIds.join(', ') + ']' : ''}: ${i.message}${i.evidence ? ' ' + JSON.stringify(i.evidence) : ''}`).join('\n');
}

/** Validate a staged candidate and, when accepted, run the playability checks. One model turn instead of three. */
async function validateAndCheck(config: PluginConfig, candidateId: string) {
  await status(config, { phase: 'validating', message: 'validating the candidate', tool: 'validate_candidate' });
  const v = await client(config).validate_candidate(candidateId);
  state.validationAttempts++;
  if (!v.ok || !v.proofId) {
    for (const i of v.issues) state.failedCodes.add(i.code);
    await status(config, { phase: 'repairing', message: `validator rejected the candidate: ${v.issues.map((i) => i.code).join(', ')}`.slice(0, 400), codes: v.issues.map((i) => i.code).slice(0, 16), objectIds: v.issues.flatMap((i) => i.objectIds).slice(0, 32) });
    return { accepted: false as const, candidateId, issues: v.issues, nextStep: 'Repair: call the same propose tool again with these issues fixed. Nothing was changed.\n' + issueText(v.issues) };
  }
  state.validatedMs = Date.now() - state.startedAt;
  await status(config, { phase: 'validating', message: 'running connectivity and supported-movement checks', tool: 'run_playability_checks' });
  const p = await client(config).run_playability_checks(candidateId);
  state.playability = { ok: p.ok, checks: p.checks, failed: p.failed.length };
  return { accepted: true as const, candidateId, proofId: v.proofId, baseWorldVersion: v.baseWorldVersion, playability: { passed: p.ok, checks: p.checks, failed: p.failed, unreachableRoutes: p.routes.unreachable }, nextStep: `Call commit_candidate with candidateId ${candidateId} and proofId ${v.proofId}.` };
}

/** Publish the build report once per run; later calls return the same reportId. */
async function publishReport(config: PluginConfig, requestId: string, outcome: 'committed' | 'failed' | 'cancelled', summary: string, worldVersion?: number) {
  if (state.reportId) return { published: true, reportId: state.reportId, outcome: state.reportOutcome ?? outcome, alreadyPublished: true };
  const c = client(config);
  const effectiveOutcome = outcome === 'committed' && state.committedVersion === undefined ? 'failed' : outcome;
  const r = await c.publish_build_report({
    requestId,
    mode: MODE,
    model: process.env.BEETLE_MODEL || config.model || 'unknown',
    outcome: effectiveOutcome,
    worldVersion: state.committedVersion ?? worldVersion ?? state.baseWorldVersion,
    baseWorldVersion: state.baseWorldVersion,
    summary: `[${MODE}] ${summary}`.slice(0, 600),
    validation: { attempts: state.validationAttempts, failedCodes: [...state.failedCodes].slice(0, 32) },
    playability: state.playability,
    timings: { requestedAt: Number(process.env.BEETLE_REQUEST_CREATED_AT) || state.startedAt, firstModelResponseMs: state.firstToolAt ? state.firstToolAt - state.startedAt : undefined, validatedMs: state.validatedMs, committedMs: state.committedMs, totalMs: Date.now() - state.startedAt },
    toolCalls: c.records.slice(0, 64),
  });
  state.reportId = r.reportId;
  state.reportOutcome = effectiveOutcome;
  runLog({ kind: 'report', ok: true, reportId: r.reportId, outcome: effectiveOutcome });
  return { published: true, reportId: r.reportId, outcome: effectiveOutcome, alreadyPublished: false };
}

export default defineToolPlugin({
  id: PLUGIN_ID,
  name: 'Beetle tools',
  description: 'Stage, validate and commit changes to a running Beetle game world through the loopback Beetle server.',
  configSchema,
  tools: (tool) => [
    tool({
      name: 'read_world_state',
      label: 'Read world state',
      description: 'Read the current world: islands with ids, names and compass directions, bridges, relics, gate, hazard, players and the world version. Call this first for any edit.',
      parameters: Type.Object({}),
      async execute(_params, config) {
        budget('read_world_state');
        state.firstToolAt ??= Date.now();
        await status(config, { phase: 'planning', message: 'reading the current world', tool: 'read_world_state' });
        const w = await client(config).read_world_state();
        state.baseWorldVersion = w.version;
        if (!w.hasWorld || !w.spec) return { hasWorld: false, version: w.version, note: 'No world is loaded. Only a new world brief (propose_world) can work now.' };
        const spec = w.spec;
        const bridgesOf = (id: string) => spec.bridges.filter((b) => b.endpoints.some((e) => e.islandId === id)).map((b) => b.id);
        return {
          hasWorld: true,
          version: w.version,
          title: spec.title,
          hazard: spec.hazard.kind,
          islands: spec.islands.map((i) => {
            const s = w.summary?.islands.find((x) => x.id === i.id);
            return { id: i.id, name: i.name ?? s?.name, compass: s?.compass, center: i.center, radius: i.radius, bridgeIds: bridgesOf(i.id), hasGate: spec.gate.supportingSurfaceId === i.id, hasSpawns: spec.spawns.some((sp) => sp.supportingSurfaceId === i.id) };
          }),
          bridges: spec.bridges.map((b) => ({ id: b.id, from: b.endpoints[0].islandId, to: b.endpoints[1].islandId, width: b.width })),
          relics: spec.relics.map((r) => ({ id: r.id, name: r.name, islandId: r.supportingSurfaceId, collected: (w.summary?.collectedRelicIds ?? []).includes(r.id) })),
          gate: { id: spec.gate.id, islandId: spec.gate.supportingSurfaceId, unlocked: w.summary?.gateUnlocked ?? false },
          decorations: spec.decorations.map((d) => ({ id: d.id, type: d.type, islandId: d.supportingSurfaceId })),
          players: (w.summary?.players ?? []).map((p) => ({ label: p.label, status: p.status, onSurfaceId: p.onSurfaceId, connected: p.connected })),
          score: w.summary?.score ?? 0,
        };
      },
    }),

    tool({
      name: 'propose_world',
      label: 'Propose world',
      description: 'Stage a complete new world draft as a candidate and validate it (schema, geometry, reachability, playability). Nothing changes until commit_candidate succeeds. Returns candidateId plus proofId when accepted, else the issues to fix.',
      parameters: Type.Object({ requestId: Type.String({ description: 'the request id from the task' }), spec: worldDraftSchema }),
      async execute({ requestId, spec }, config) {
        budget('propose_world');
        state.firstToolAt ??= Date.now();
        await status(config, { phase: 'planning', message: 'staging a new world candidate', tool: 'propose_world' });
        const r = await client(config).propose_world(requestId, spec);
        if (!r.ok) {
          state.validationAttempts++;
          for (const i of r.issues) state.failedCodes.add(i.code);
          return { staged: false, issues: r.issues, nextStep: 'Fix the issues and call propose_world again.\n' + issueText(r.issues) };
        }
        state.baseWorldVersion = r.baseWorldVersion;
        state.summary = `new world "${spec.title}" with ${spec.islands.length} islands and ${spec.bridges.length} bridges`;
        return { staged: true, ...(await validateAndCheck(config, r.candidateId)) };
      },
    }),

    tool({
      name: 'propose_patch',
      label: 'Propose patch',
      description: `Stage a bounded edit to the current world as a candidate and validate it (schema, geometry, reachability, playability). ops: ${PATCH_OP_NAMES.join(', ')}. Nothing changes until commit_candidate succeeds. Returns candidateId plus proofId when accepted, else the issues to fix.`,
      parameters: Type.Object({
        requestId: Type.Optional(Type.String({ description: 'the request id from the task (optional, the worker knows it)' })),
        summary: Type.String({ description: 'one short sentence describing the change', maxLength: L.summary.maxLength }),
        ops: Type.Array(patchOpSchema, { minItems: 1, maxItems: L.patchOps.max }),
      }),
      async execute({ requestId, summary, ops }, config) {
        budget('propose_patch');
        state.firstToolAt ??= Date.now();
        await status(config, { phase: 'planning', message: `staging patch: ${summary}`.slice(0, 400), tool: 'propose_patch' });
        const patch = { summary, ops: ops.map((o) => stripUndefined(o as Record<string, unknown>)) };
        const r = await client(config).propose_patch(effectiveRequestId(requestId), patch);
        if (!r.ok) {
          state.validationAttempts++;
          for (const i of r.issues) state.failedCodes.add(i.code);
          await status(config, { phase: 'repairing', message: 'patch rejected at the boundary', codes: r.issues.map((i) => i.code).slice(0, 16), objectIds: r.issues.flatMap((i) => i.objectIds).slice(0, 32) });
          return { staged: false, issues: r.issues, nextStep: 'Fix the issues and call propose_patch again.\n' + issueText(r.issues) };
        }
        state.baseWorldVersion = r.baseWorldVersion;
        state.summary = summary;
        return { staged: true, patchId: r.patchId, changedIds: r.changedIds, ...(await validateAndCheck(config, r.candidateId)) };
      },
    }),

    tool({
      name: 'validate_candidate',
      label: 'Validate candidate',
      description: 'Run the world validator on a staged candidate with the live session. Returns accepted plus a proofId, or the issues (code, objectIds, evidence) to repair with a new propose call.',
      parameters: Type.Object({ candidateId: Type.String() }),
      async execute({ candidateId }, config) {
        budget('validate_candidate');
        await status(config, { phase: 'validating', message: 'validating the candidate', tool: 'validate_candidate' });
        const v = await client(config).validate_candidate(candidateId);
        state.validationAttempts++;
        if (!v.ok || !v.proofId) {
          for (const i of v.issues) state.failedCodes.add(i.code);
          await status(config, { phase: 'repairing', message: `validator rejected the candidate: ${v.issues.map((i) => i.code).join(', ')}`.slice(0, 400), codes: v.issues.map((i) => i.code).slice(0, 16), objectIds: v.issues.flatMap((i) => i.objectIds).slice(0, 32) });
          return { accepted: false, candidateId, issues: v.issues, nextStep: 'Repair: call propose_patch or propose_world again with these fixed, then validate the new candidateId.\n' + issueText(v.issues) };
        }
        state.validatedMs = Date.now() - state.startedAt;
        return { accepted: true, candidateId, proofId: v.proofId, baseWorldVersion: v.baseWorldVersion, nextStep: `Call run_playability_checks with candidateId ${candidateId}, then commit_candidate with candidateId ${candidateId} and proofId ${v.proofId}.` };
      },
    }),

    tool({
      name: 'run_playability_checks',
      label: 'Run playability checks',
      description: 'Connectivity and supported-movement checks on a validated candidate (headless walk from spawns to relics and gate). Informational; not a fun guarantee.',
      parameters: Type.Object({ candidateId: Type.String() }),
      async execute({ candidateId }, config) {
        budget('run_playability_checks');
        await status(config, { phase: 'validating', message: 'running connectivity and supported-movement checks', tool: 'run_playability_checks' });
        const p = await client(config).run_playability_checks(candidateId);
        state.playability = { ok: p.ok, checks: p.checks, failed: p.failed.length };
        return { passed: p.ok, checks: p.checks, failed: p.failed, unreachableRoutes: p.routes.unreachable, nextStep: p.ok ? 'Call commit_candidate with the candidateId and proofId.' : 'Repair the world with a new propose call, then validate again.' };
      },
    }),

    tool({
      name: 'commit_candidate',
      label: 'Commit candidate',
      description: 'Commit a validated candidate at the next safe simulation tick using the proofId returned with the accepted candidate. Players keep their positions. On success the build report is published too. Returns the new world version or a failure code.',
      parameters: Type.Object({ candidateId: Type.String(), proofId: Type.String() }),
      async execute({ candidateId, proofId }, config) {
        budget('commit_candidate');
        await status(config, { phase: 'awaiting_safe_commit', message: 'committing at the next safe tick', tool: 'commit_candidate' });
        const r = await client(config).commit_candidate(candidateId, proofId);
        if (r.ok) {
          state.committedMs = Date.now() - state.startedAt;
          state.committedVersion = r.worldVersion;
          runLog({ kind: 'commit', ok: true, worldVersion: r.worldVersion, deferredMs: r.deferredMs, idempotentReplay: r.idempotentReplay });
          await status(config, { phase: 'committed', message: `committed v${r.worldVersion}${r.deferredMs > 0 ? ` after waiting ${r.deferredMs} ms for a safe tick` : ''}`, tool: 'commit_candidate' });
          let report: { reportId: string } | { error: string };
          try { report = await publishReport(config, effectiveRequestId(undefined), 'committed', state.summary ?? 'committed', r.worldVersion); } catch (err) { report = { error: (err as Error).message.slice(0, 200) }; }
          return { committed: true, worldVersion: r.worldVersion, deferredMs: r.deferredMs, idempotentReplay: r.idempotentReplay, report, nextStep: 'Done. Reply with one sentence for the director.' };
        }
        state.failedCodes.add(r.code);
        runLog({ kind: 'commit', ok: false, code: r.code, retryable: r.retryable, objectIds: r.objectIds });
        await status(config, { phase: r.retryable ? 'awaiting_safe_commit' : 'failed', message: `commit rejected: ${r.code} ${r.message}`.slice(0, 400), codes: [r.code], objectIds: r.objectIds.slice(0, 32) });
        return { committed: false, code: r.code, message: r.message, objectIds: r.objectIds, retryable: r.retryable, nextStep: r.retryable ? 'Wait a moment and call commit_candidate once more with the same candidateId and proofId.' : 'Call publish_build_report with outcome failed.' };
      },
    }),

    tool({
      name: 'publish_build_report',
      label: 'Publish build report',
      description: 'Publish the final build report for this request (outcome, summary, world version). Call once at the end.',
      parameters: Type.Object({
        requestId: Type.Optional(Type.String({ description: 'optional, the worker knows it' })),
        outcome: Type.Union([Type.Literal('committed'), Type.Literal('failed'), Type.Literal('cancelled')]),
        summary: Type.String({ maxLength: 400 }),
        worldVersion: Type.Optional(Type.Number({ description: 'the committed world version' })),
      }),
      async execute({ requestId, outcome, summary, worldVersion }, config) {
        const r = await publishReport(config, effectiveRequestId(requestId), outcome, summary, worldVersion);
        return { ...r, nextStep: 'Reply with one sentence for the director.' };
      },
    }),
  ],
});
