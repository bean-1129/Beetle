// Cases 14 and 15: model failure handling in the agent job, with a fake Ollama and a fake Beetle server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WorldSpecSchema, WorldDraftSchema, type WorldDraft, type PatchDraft } from '@beetle/contracts';
import { startFakeBeetleServer, type FakeBeetleServer } from '../../packages/agent/test-support/fake-beetle-server.ts';
import { startFakeOllama, chatReply, type FakeOllama } from '../../packages/agent/test-support/fake-ollama.ts';
import { fixtureSpec } from '../../packages/agent/test-support/fixture-world.ts';
import { fixExpansionDraft, briefWantsStreaming, expansionSystemPrompt } from '../../packages/agent/src/expansion-prompts.ts';
import { applyBriefHints, briefHints, briefUserPrompt, patchDraftSystemPrompt, worldDraftSystemPrompt, openclawInstructionPrompt } from '../../packages/agent/src/prompts.ts';
import { createOllamaClient, createBeetleClient, runJob, isLoopbackUrl, loadConfig, auditOpenClawConfig, buildOpenClawConfig, sanitizeText, type JobEnv, type AgentConfig } from '../../packages/agent/src/index.ts';

const MODEL = 'qwen3.5:4b';

function validDraft(): WorldDraft {
  return {
    title: 'Test Garden',
    islands: [
      { id: 'hearth', name: 'Hearth', center: { x: 0, z: 0 }, radius: 8 },
      { id: 'temple', name: 'Temple', center: { x: 0, z: 24 }, radius: 7 },
      { id: 'orchard', name: 'Orchard', center: { x: 24, z: 0 }, radius: 6 },
      { id: 'quarry', name: 'Quarry', center: { x: -24, z: 0 }, radius: 6 },
    ],
    bridges: [
      { id: 'b-temple', from: 'hearth', to: 'temple', width: 2.4 },
      { id: 'b-orchard', from: 'hearth', to: 'orchard', width: 2.4 },
      { id: 'b-quarry', from: 'hearth', to: 'quarry', width: 1.6 },
    ],
    spawns: [{ islandId: 'hearth', localPosition: { x: -2, z: -2 } }, { islandId: 'hearth', localPosition: { x: 2, z: -2 } }],
    relics: [
      { id: 'relic-a', name: 'A', islandId: 'orchard', localPosition: { x: 1, z: 1 } },
      { id: 'relic-b', name: 'B', islandId: 'quarry', localPosition: { x: -1, z: 1 } },
      { id: 'relic-c', name: 'C', islandId: 'hearth', localPosition: { x: 0, z: 4 } },
    ],
    gate: { islandId: 'temple', localPosition: { x: 0, z: -5 } },
    hazard: 'water',
    decorations: [{ id: 'tree-a', type: 'tree', islandId: 'hearth', localPosition: { x: 4, z: 4 } }],
  };
}

function validPatch(): PatchDraft {
  return { summary: 'Lava and a bridge to the temple', ops: [{ op: 'set_hazard', kind: 'lava' }, { op: 'add_bridge', id: 'bridge-east-temple', from: 'isle-east', to: 'isle-temple', width: 2.4 }] };
}

function env(overrides: Partial<JobEnv> = {}): JobEnv {
  return { mode: 'direct', model: MODEL, deadlineMs: 20_000, maxRepairAttempts: 2, maxToolCalls: 16, modelCallTimeoutMs: 10_000, occupiedRetryDelayMs: 5, ...overrides };
}

describe('agent fixtures', () => {
  it('fixture spec and draft are schema-valid', () => {
    expect(WorldSpecSchema.safeParse(fixtureSpec()).success).toBe(true);
    expect(WorldDraftSchema.safeParse(validDraft()).success).toBe(true);
  });
});

describe('case 14: bounded retries and boundary validation', () => {
  let beetle: FakeBeetleServer;
  let ollama: FakeOllama;
  beforeEach(async () => {
    beetle = await startFakeBeetleServer({ port: 0, claimLongPollMs: 50 });
    ollama = await startFakeOllama();
  });
  afterEach(async () => {
    await ollama.close();
    await beetle.close();
  });

  it('malformed then truncated then valid draft: exactly two retries, one propose, commit only with the issued proof', async () => {
    ollama.push(
      chatReply('this is not json {'),
      chatReply('{"title": "Truncated", "islands": [{"id": "a", "name": "A", "center": {"x": 0,'),
      chatReply(JSON.stringify(validDraft())),
    );
    const request = beetle.enqueue({ kind: 'brief', prompt: 'four islands with a temple to the north' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env() });

    expect(result.outcome).toBe('committed');
    expect(result.modelCalls).toBe(3);
    expect(ollama.requests.filter((r) => r.path === '/api/chat')).toHaveLength(3);
    // The second and third prompts carry the parse error back to the model.
    const second = ollama.requests[1].body.messages as { role: string; content: string }[];
    expect(second[second.length - 1].content).toMatch(/malformed JSON/);
    const third = ollama.requests[2].body.messages as { role: string; content: string }[];
    expect(third[third.length - 1].content).toMatch(/truncated JSON/);
    // Every model call used structured output and no thinking.
    for (const r of ollama.requests) { expect(r.body.format).toBeTypeOf('object'); expect(r.body.think).toBe(false); expect(r.body.stream).toBe(false); }

    expect(beetle.calls('propose_world')).toHaveLength(1);
    expect(beetle.calls('validate_candidate')).toHaveLength(1);
    expect(beetle.calls('run_playability_checks')).toHaveLength(1);
    const commits = beetle.calls('commit_candidate');
    expect(commits).toHaveLength(1);
    const proofId = (commits[0].body as { proofId: string }).proofId;
    expect(beetle.state.proofs.has(proofId)).toBe(true);
    expect(beetle.state.version).toBe(2);
    expect(beetle.state.finishes[0].body.outcome).toBe('committed');
    expect(beetle.state.finishes[0].body.worldVersion).toBe(2);
    const report = beetle.state.reports[0] as { mode: string; outcome: string; toolCalls: { tool: string; ok: boolean }[]; preserved?: unknown };
    expect(report.mode).toBe('direct');
    expect(report.outcome).toBe('committed');
    // read_world_state after the commit fills the report's preserved field (direct mode).
    expect(report.toolCalls.map((t) => t.tool)).toEqual(['propose_world', 'validate_candidate', 'run_playability_checks', 'commit_candidate', 'read_world_state']);
    expect(report.preserved).toEqual({ players: expect.any(Number), collectedRelics: expect.any(Number), connections: expect.any(Number) });
    for (const s of beetle.state.statuses) expect(String(s.body.message)).toMatch(/^\[direct\]/);
    for (const r of beetle.requests) expect(r.tokenOk).toBe(true);
  });

  it('schema-invalid patch (width 10) is rejected at the server boundary and the repair prompt quotes the zod message', async () => {
    const bad = { summary: 'Too wide', ops: [{ op: 'add_bridge', id: 'bridge-wide', from: 'isle-east', to: 'isle-temple', width: 10 }] };
    ollama.push(chatReply(JSON.stringify(bad)), chatReply(JSON.stringify(validPatch())));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'make it lava and add a bridge from the orchard to the temple' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env() });

    expect(result.outcome).toBe('committed');
    expect(ollama.requests).toHaveLength(2);
    const repair = (ollama.requests[1].body.messages as { role: string; content: string }[]).at(-1)!;
    expect(repair.role).toBe('user');
    expect(repair.content).toContain('INVALID_SCHEMA');
    expect(repair.content).toContain('ops.0.width');
    expect(repair.content).toContain('less than or equal to 4');
    // The repair hint lists the valid ids so the model can fix references.
    expect(repair.content).toContain('Valid island ids: isle-centre, isle-temple, isle-east, isle-west, isle-south');
    // The model output goes to the server first (it normalizes and validates); the invalid patch was rejected with 400.
    const proposals = beetle.calls('propose_patch');
    expect(proposals).toHaveLength(2);
    expect(proposals[0].status).toBe(400);
    expect(proposals[1].status).toBe(200);
    expect((proposals[1].body as { patch: PatchDraft }).patch.ops[1]).toMatchObject({ op: 'add_bridge', width: 2.4 });
    expect(beetle.calls('read_world_state')).toHaveLength(2); // once to draft the patch, once after the commit for the preserved counts
    expect(beetle.calls('commit_candidate')).toHaveLength(1);
    expect(beetle.state.spec?.hazard.kind).toBe('lava');
    expect(beetle.state.spec?.bridges.some((b) => b.id === 'bridge-east-temple')).toBe(true);
    const repairing = beetle.state.statuses.filter((s) => s.body.phase === 'repairing');
    expect(repairing).toHaveLength(1);
    expect(repairing[0].body.codes).toEqual(['INVALID_SCHEMA']);
  });

  it('a non-object JSON answer counts as malformed and is retried locally', async () => {
    ollama.push(chatReply('[1, 2, 3]'), chatReply(JSON.stringify(validPatch())));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'lava' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env() });
    expect(result.outcome).toBe('committed');
    expect(ollama.requests).toHaveLength(2);
    expect(beetle.calls('propose_patch')).toHaveLength(1);
  });

  it('validator issues are quoted back (codes, ids, evidence) and the repair is bounded', async () => {
    const issue = { code: 'DISCONNECTED_GOAL' as const, message: 'gate on isle-temple is unreachable from spawn-0', objectIds: ['gate', 'isle-temple'], evidence: { from: 'spawn-0', missingBridgeTo: 'isle-temple' } };
    beetle.script.validate.push({ ok: false, issues: [issue] }, { ok: false, issues: [issue] }, { ok: false, issues: [issue] });
    ollama.fallback = () => chatReply(JSON.stringify(validPatch()));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'add a bridge to the temple' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env({ maxRepairAttempts: 2 }) });

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.validationAttempts).toBe(3);
    expect(beetle.calls('propose_patch')).toHaveLength(3);
    expect(beetle.calls('validate_candidate')).toHaveLength(3);
    expect(beetle.calls('commit_candidate')).toHaveLength(0);
    const repair = (ollama.requests[1].body.messages as { role: string; content: string }[]).at(-1)!.content;
    expect(repair).toContain('DISCONNECTED_GOAL');
    expect(repair).toContain('isle-temple');
    expect(repair).toContain('missingBridgeTo');
    const repairing = beetle.state.statuses.filter((s) => s.body.phase === 'repairing');
    expect(repairing).toHaveLength(2);
    expect(repairing[0].body.codes).toEqual(['DISCONNECTED_GOAL']);
    expect(beetle.state.finishes[0].body.outcome).toBe('failed');
    expect(beetle.state.version).toBe(1);
  });

  it('tool HTTP 500 is retried once then fails cleanly with finish outcome failed', async () => {
    beetle.script.failures.push({ path: /\/validate$/, status: 500, times: 5 });
    ollama.push(chatReply(JSON.stringify(validPatch())));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'lava please' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env() });

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('TOOL_HTTP_ERROR');
    expect(beetle.calls('validate_candidate')).toHaveLength(2);
    expect(beetle.calls('commit_candidate')).toHaveLength(0);
    expect(beetle.state.finishes).toHaveLength(1);
    expect(beetle.state.finishes[0].body.outcome).toBe('failed');
    expect((beetle.state.finishes[0].body.error as { code: string }).code).toBe('TOOL_HTTP_ERROR');
    expect(beetle.state.version).toBe(1);
    const report = beetle.state.reports[0] as { outcome: string; toolCalls: { tool: string; ok: boolean }[] };
    expect(report.outcome).toBe('failed');
    expect(report.toolCalls.find((t) => t.tool === 'validate_candidate')?.ok).toBe(false);
  });

  it('OCCUPIED_SUPPORT retryable: waits and recommits the same proof once', async () => {
    beetle.script.commit.push({ ok: false, code: 'OCCUPIED_SUPPORT', message: 'Amber stands on bridge-west', objectIds: ['p-0'], retryable: true });
    ollama.push(chatReply(JSON.stringify(validPatch())));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'lava' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env(), sleep: async () => undefined });
    expect(result.outcome).toBe('committed');
    const commits = beetle.calls('commit_candidate');
    expect(commits).toHaveLength(2);
    expect((commits[0].body as { proofId: string }).proofId).toBe((commits[1].body as { proofId: string }).proofId);
    expect(beetle.state.statuses.some((s) => s.body.phase === 'awaiting_safe_commit' && (s.body.codes as string[] | undefined)?.includes('OCCUPIED_SUPPORT'))).toBe(true);
  });

  it('a cancelled request stops the job before any commit', async () => {
    ollama.push(chatReply(JSON.stringify(validPatch())));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'lava' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    // Cancel as soon as the first status arrives.
    const origStatus = client.status.bind(client);
    client.status = async (id, body) => { const r = await origStatus(id, body); beetle.cancel(request.id); return r; };
    const result = await runJob(request, { client, ollama: model, env: env() });
    expect(result.outcome).toBe('cancelled');
    expect(beetle.calls('commit_candidate')).toHaveLength(0);
    expect(beetle.state.finishes[0].body.outcome).toBe('cancelled');
  });
});

describe('case 15: model timeouts and local-only', () => {
  let beetle: FakeBeetleServer;
  let ollama: FakeOllama;
  beforeEach(async () => {
    beetle = await startFakeBeetleServer({ port: 0, claimLongPollMs: 50 });
    ollama = await startFakeOllama();
  });
  afterEach(async () => {
    await ollama.close();
    await beetle.close();
  });

  it('an Ollama that never answers within the deadline ends the job as failed with no candidate committed', async () => {
    ollama.push({ hang: true });
    const request = beetle.enqueue({ kind: 'brief', prompt: 'anything' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const t0 = Date.now();
    const result = await runJob(request, { client, ollama: model, env: env({ deadlineMs: 800, modelCallTimeoutMs: 60_000 }) });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('MODEL_TIMEOUT');
    expect(beetle.calls('propose_world')).toHaveLength(0);
    expect(beetle.calls('commit_candidate')).toHaveLength(0);
    expect(beetle.state.finishes[0].body.outcome).toBe('failed');
    expect(beetle.state.version).toBe(1);
  });

  it('a refused Ollama fails with no fallback request to any other host', async () => {
    // A loopback port that nothing listens on.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const closedPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const refusedUrl = `http://127.0.0.1:${closedPort}`;

    const seen: string[] = [];
    const spyFetch: typeof fetch = (input, init) => { seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return fetch(input, init); };
    const request = beetle.enqueue({ kind: 'edit', prompt: 'lava' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token, fetchImpl: spyFetch });
    const model = createOllamaClient({ baseUrl: refusedUrl, model: MODEL, fetchImpl: spyFetch });
    const result = await runJob(request, { client, ollama: model, env: env() });

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('MODEL_UNREACHABLE');
    expect(beetle.calls('commit_candidate')).toHaveLength(0);
    const allowed = new Set([new URL(refusedUrl).host, new URL(beetle.url).host]);
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) expect(allowed.has(new URL(url).host)).toBe(true);
    expect(seen.filter((u) => u.startsWith(refusedUrl))).toHaveLength(1);
  });

  it('non-loopback model or server URLs are refused at startup', async () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:11434')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:11434')).toBe(true);
    expect(isLoopbackUrl('http://172.20.65.84:11434')).toBe(false);
    expect(isLoopbackUrl('https://api.openai.com')).toBe(false);
    expect(() => createOllamaClient({ baseUrl: 'http://172.20.65.84:11434', model: MODEL })).toThrow(/loopback/);
    expect(() => createBeetleClient({ serverUrl: 'http://10.0.0.5:7700', token: 'x' })).toThrow(/loopback/);
    await expect(loadConfig({ env: { OLLAMA_BASE_URL: 'https://ollama.example.com', BEETLE_AGENT_TOKEN: 'abcdefgh' }, mode: 'direct' })).rejects.toThrow(/OLLAMA_BASE_URL must be a loopback URL/);
    const cfg = await loadConfig({ env: { BEETLE_AGENT_TOKEN: 'abcdefgh', BEETLE_AGENT_MODE: 'direct' } });
    expect(cfg.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(cfg.serverUrl).toBe('http://127.0.0.1:7700');
    expect(cfg.mode).toBe('direct');
  });
});

describe('openclaw profile guards', () => {
  const cfg: AgentConfig = {
    mode: 'openclaw', serverUrl: 'http://127.0.0.1:7700', agentToken: 'x'.repeat(32), ollamaBaseUrl: 'http://127.0.0.1:11434', model: MODEL,
    requestDeadlineMs: 1000, maxRepairAttempts: 2, maxToolCalls: 16, modelCallTimeoutMs: 1000, repoRoot: '/tmp/beetle', dataDir: '/tmp/beetle/data',
    workerId: 'w', openclawHome: '/tmp/beetle/.openclaw-home', openclawBin: '/tmp/beetle/openclaw',
  };

  it('the generated config is local-only and passes the audit', () => {
    const generated = buildOpenClawConfig(cfg, 'g'.repeat(48));
    expect(auditOpenClawConfig(generated, MODEL, cfg.ollamaBaseUrl)).toEqual([]);
    const text = JSON.stringify(generated);
    expect(text).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect((generated.tools as { deny: string[] }).deny).toContain('exec');
    expect((generated.plugins as { allow: string[] }).allow).toEqual(['beetle-tools']);
    expect((generated.update as { checkOnStart: boolean }).checkOnStart).toBe(false);
    expect((generated.telemetry as { enabled: boolean }).enabled).toBe(false);
  });

  it('a tampered config is refused: remote provider, fallback model, lan bind, extra plugin, exec allowed', () => {
    const base = () => buildOpenClawConfig(cfg, 'g'.repeat(48)) as Record<string, any>;
    const remote = base(); remote.models.providers.ollama.baseUrl = 'https://ollama.com';
    expect(auditOpenClawConfig(remote, MODEL, cfg.ollamaBaseUrl).join(' ')).toMatch(/loopback/);
    const extraProvider = base(); extraProvider.models.providers.openai = { apiKey: 'k' };
    expect(auditOpenClawConfig(extraProvider, MODEL, cfg.ollamaBaseUrl).join(' ')).toMatch(/exactly one provider/);
    const fallback = base(); fallback.agents.defaults.model.fallbacks = ['openai/gpt'];
    expect(auditOpenClawConfig(fallback, MODEL, cfg.ollamaBaseUrl).join(' ')).toMatch(/fallbacks/);
    const lan = base(); lan.gateway.bind = 'lan';
    expect(auditOpenClawConfig(lan, MODEL, cfg.ollamaBaseUrl).join(' ')).toMatch(/gateway.bind/);
    const plugin = base(); plugin.plugins.allow.push('browser');
    expect(auditOpenClawConfig(plugin, MODEL, cfg.ollamaBaseUrl).join(' ')).toMatch(/plugins.allow/);
    const exec = base(); exec.tools.exec.security = 'full';
    expect(auditOpenClawConfig(exec, MODEL, cfg.ollamaBaseUrl).join(' ')).toMatch(/exec/);
    expect(auditOpenClawConfig(null, MODEL, cfg.ollamaBaseUrl)).toEqual(['config file missing or unreadable']);
  });

  it('stderr sanitizer redacts bearer tokens and long hex strings', () => {
    const hex = 'a'.repeat(32);
    const out = sanitizeText(`authorization: Bearer ${hex} and token ${'0123456789abcdef'.repeat(3)} but keeps cand-103a77f5`);
    expect(out).not.toContain(hex);
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('[hex-redacted]');
    expect(out).toContain('cand-103a77f5');
  });
});

describe('game modes: draft fields pass through', () => {
  let beetle: FakeBeetleServer;
  let ollama: FakeOllama;
  beforeEach(async () => {
    beetle = await startFakeBeetleServer({ port: 0, claimLongPollMs: 50 });
    ollama = await startFakeOllama();
  });
  afterEach(async () => {
    await ollama.close();
    await beetle.close();
  });

  it('a draft with mode, biome, movementSpeed and hazardRise reaches propose_world unchanged and is committed', async () => {
    const draft: WorldDraft = {
      ...validDraft(),
      title: 'Frost Dash (time trial)',
      biome: 'frost',
      mode: { kind: 'time_trial', timeLimitSec: 90, relicsRequired: 2 },
      movementSpeed: 6,
      hazardRise: { afterSec: 30, metersPerSec: 0.05, maxElevation: -1 },
    };
    expect(WorldDraftSchema.safeParse(draft).success).toBe(true);
    ollama.push(chatReply(JSON.stringify(draft)));
    const request = beetle.enqueue({ kind: 'brief', prompt: 'A race across the islands with a 90 second limit, snowy, fast players' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env() });

    expect(result.outcome).toBe('committed');
    expect(result.modelCalls).toBe(1);
    // The agent does not touch the draft: the server receives exactly what the model produced, new fields included
    // (plus streaming: true, the default for briefs that do not ask for the whole world up front, and terrain islands
    // because the brief says "across the islands").
    const proposed = beetle.calls('propose_world');
    expect(proposed).toHaveLength(1);
    expect((proposed[0].body as { spec: unknown }).spec).toEqual({ ...draft, streaming: true, terrain: 'islands' });
    expect((proposed[0].body as { requestId: string }).requestId).toBe(request.id);
    // The system prompt carries the mode and biome vocabulary and the mapping rule; the draft schema sent as `format` allows the fields.
    const sys = (ollama.requests[0].body.messages as { role: string; content: string }[])[0].content;
    for (const word of ['relic_hunt', 'time_trial', 'king_of_the_hill', 'checkpoint_race', 'survival', 'garden', 'volcanic', 'frost', 'desert', 'night', 'movementSpeed', 'Always set "terrain", "biome" and "mode"', '"hazardRise" only for survival']) expect(sys).toContain(word);
    const format = ollama.requests[0].body.format as { properties: Record<string, unknown> };
    for (const key of ['biome', 'mode', 'movementSpeed', 'hazardRise']) expect(format.properties).toHaveProperty(key);
    // The build report names the mode and biome.
    const report = beetle.state.reports[0] as { summary: string; outcome: string };
    expect(report.outcome).toBe('committed');
    expect(report.summary).toContain('mode time_trial');
    expect(report.summary).toContain('biome frost');
  });

  it('the edit prompt lists set_mode, set_biome and set_movement with examples, and MODE_INVALID has a repair hint', async () => {
    const patch: PatchDraft = { summary: 'Sixty second time trial', ops: [{ op: 'set_mode', mode: { kind: 'time_trial', timeLimitSec: 60 } }] };
    // The fake server's patch applier predates the mode ops and answers UNKNOWN_OPERATION; the job then repairs once with a set_title patch.
    const fallback: PatchDraft = { summary: 'Retitle only', ops: [{ op: 'set_title', title: 'Sixty Second Trial' }] };
    ollama.push(chatReply(JSON.stringify(patch)), chatReply(JSON.stringify(fallback)));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'make it a 60 second time trial' });
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env() });
    expect(result.outcome).toBe('committed');
    const proposed = beetle.calls('propose_patch');
    expect(proposed).toHaveLength(2);
    // The set_mode patch reached the server exactly as the model produced it.
    expect((proposed[0].body as { patch: unknown }).patch).toEqual(patch);
    expect((proposed[1].body as { patch: unknown }).patch).toEqual(fallback);
    const sys = (ollama.requests[0].body.messages as { role: string; content: string }[])[0].content;
    expect(sys).toContain('"op":"set_mode","mode":{"kind":"time_trial","timeLimitSec":60}');
    expect(sys).toContain('"op":"set_biome","biome":"frost"');
    expect(sys).toContain('"op":"set_movement","speed":6');
    expect(sys).toMatch(/biome \w+; mode relic_hunt \(default\); speed 4.5/);
    const { validatorRepairPrompt } = await import('../../packages/agent/src/prompts.ts');
    const hint = validatorRepairPrompt([{ code: 'MODE_INVALID', message: 'mode relic_hunt requires 4 relics but the world has 3', objectIds: ['mode'], evidence: { relicsRequired: 4, relics: 3 } }], null);
    expect(hint).toContain('MODE_INVALID means relicsRequired exceeds the relics');
    expect(hint).toContain('survival has no hazardRise');
  });
});

describe('streaming: automatic extension requests', () => {
  let beetle: FakeBeetleServer;
  let ollama: FakeOllama;
  beforeEach(async () => {
    beetle = await startFakeBeetleServer({ port: 0, claimLongPollMs: 50 });
    ollama = await startFakeOllama();
  });
  afterEach(async () => {
    await ollama.close();
    await beetle.close();
  });

  it('an auto request uses the expansion prompt, drops non-additive ops, and stops after one repair', async () => {
    const issue = { code: 'ISLAND_OVERLAP' as const, message: 'x5 overlaps isle-east', objectIds: ['x5', 'isle-east'] };
    beetle.script.validate.push({ ok: false, issues: [issue] }, { ok: false, issues: [issue] }, { ok: false, issues: [issue] });
    const patch = { summary: 'Two islands east', ops: [
      { op: 'add_island', id: 'x5', center: { x: 44, z: 0 }, radius: 6, bridgeFrom: 'isle-east' },
      { op: 'add_decoration', id: 'xd5', type: 'tree', islandId: 'x5', localPosition: { x: 0, z: 0 } },
      { op: 'remove_bridge', id: 'bridge-east' },
    ] };
    ollama.fallback = () => chatReply(JSON.stringify(patch));
    const request = beetle.enqueue({ kind: 'edit', prompt: 'Extend the world: add one or two new islands beyond island "isle-east" toward the east' });
    request.auto = true;
    request.autoReason = { islandId: 'isle-east', direction: 'east', playerId: 'p1' };
    const client = createBeetleClient({ serverUrl: beetle.url, token: beetle.token });
    const model = createOllamaClient({ baseUrl: ollama.url, model: MODEL });
    const result = await runJob(request, { client, ollama: model, env: env({ maxRepairAttempts: 2 }) });

    expect(result.outcome).toBe('failed');
    expect(beetle.calls('propose_patch')).toHaveLength(2); // one repair, not two
    const sys = (ollama.requests[0].body.messages as { role: string; content: string }[])[0].content;
    expect(sys).toContain('Target: island isle-east');
    expect(sys).toContain('bridgeFrom set to the target island');
    expect(sys).toContain('isle-east | east | 24,0 | 6 | isle-centre');
    expect(Math.ceil(sys.length / 4)).toBeLessThan(450);
    for (const p of beetle.calls('propose_patch')) {
      const ops = (p.body as { patch: PatchDraft }).patch.ops.map((o) => o.op);
      expect(ops).toEqual(['add_island', 'add_decoration']);
    }
  });
});

describe('streaming: expansion draft fixes and brief default', () => {
  it('converts a world-position localPosition on a new island to an offset and fills a missing bridgeFrom', () => {
    const draft: Record<string, unknown> = { summary: 's', ops: [
      { op: 'add_island', id: 'x2', center: { x: 0, z: -27 }, radius: 7 },
      { op: 'add_decoration', id: 'xd2', type: 'tree', islandId: 'x2', localPosition: { x: 0, z: -26 } },
    ] };
    const changed = fixExpansionDraft(draft, 'haven');
    expect(changed).toHaveLength(2);
    const ops = draft.ops as Record<string, unknown>[];
    expect(ops[0].bridgeFrom).toBe('haven');
    expect(ops[1].localPosition).toEqual({ x: 0, z: 1 });
  });
  it('streaming is the default for briefs unless the whole world is asked for up front', () => {
    expect(briefWantsStreaming('a snowy race over floating islands')).toBe(true);
    expect(briefWantsStreaming('build the whole world up front, eight islands')).toBe(false);
  });
});

describe('terrain choice and honest mapping', () => {
  it('brief words choose the terrain; island words win; nothing implied leaves it to the default', () => {
    expect(briefHints('A relic hunt in a misty forest valley').terrain).toBe('ground');
    expect(briefHints('A king of the hill battle in a desert canyon').terrain).toBe('ground');
    expect(briefHints('Tag on the ground in a park').terrain).toBe('ground');
    expect(briefHints('A race over floating sky islands').terrain).toBe('islands');
    expect(briefHints('King of the hill on a frozen arena of four islands').terrain).toBe('islands');
    expect(briefHints('Survive on a lava sea').terrain).toBe('islands');
    expect(briefHints('A first person shooting game where we shoot walking trees, multiplayer').terrain).toBeUndefined();
    expect(briefUserPrompt('A relic hunt in a misty forest valley')).toContain('terrain is ground.');
  });

  it('applyBriefHints sets an implied terrain and defaults to ground unless lava or survival makes the hazard the fun', () => {
    const forest: Record<string, unknown> = { title: 'Mist Hunt', hazard: 'water', terrain: 'islands', mode: { kind: 'relic_hunt' } };
    expect(applyBriefHints(forest, 'A relic hunt in a misty forest valley')).toContain('terrain islands -> ground');
    expect(forest.terrain).toBe('ground');
    const plain: Record<string, unknown> = { title: 'Walking Trees Hunt (relic hunt, no shooting)', hazard: 'water', mode: { kind: 'relic_hunt' } };
    applyBriefHints(plain, 'A first person shooting game where we shoot walking trees, multiplayer');
    expect(plain.terrain).toBe('ground');
    const lava: Record<string, unknown> = { title: 'Hot Run', hazard: 'lava', mode: { kind: 'relic_hunt' } };
    applyBriefHints(lava, 'Grab the relics before the magma gets you');
    expect(lava.terrain).toBe('islands');
    const titled: Record<string, unknown> = { title: 'Sky Isles', hazard: 'water', mode: { kind: 'relic_hunt' } };
    applyBriefHints(titled, 'something fun');
    expect(titled.terrain).toBeUndefined(); // title words are resolved by the world normalizer
  });

  it('the draft prompt carries the terrain rule and the honest-mapping rule; edit and OpenClaw prompts know set_terrain', () => {
    const sys = worldDraftSystemPrompt({ streaming: true });
    for (const word of ['"terrain"', 'forest, field, meadow, canyon, valley, park, street, city, arena, battlefield, jungle, swamp, village, farm', 'floating, sky, archipelago, islands, lagoon, lava sea', 'zones or clearings', 'ground for relic hunts and arenas', 'No shooting, enemies, combat, first-person view, vehicles or building', 'Walking Trees Hunt (relic hunt, no shooting)']) expect(sys).toContain(word);
    expect(sys.length).toBeLessThan(3000); // about 757 tokens on qwen3.5:4b (prompt_eval_count, system only, streaming on)
    const edit = patchDraftSystemPrompt({ spec: fixtureSpec(), summary: null });
    expect(edit).toContain('"op":"set_terrain","terrain":"ground"');
    expect(edit).toContain('terrain islands;');
    const oc = openclawInstructionPrompt({ kind: 'brief', requestId: 'req-1', prompt: 'shoot walking trees', model: MODEL });
    expect(oc).toContain('terrain (islands or ground)');
    expect(oc).toContain('No shooting');
  });

  it('an unsupported mechanic is named in the title when the model leaves it out', () => {
    const d: Record<string, unknown> = { title: 'Walking Trees Hunt', hazard: 'water' };
    const changed = applyBriefHints(d, 'A first person shooting game where we shoot walking trees, multiplayer');
    expect(d.title).toBe('Walking Trees Hunt (relic hunt, no shooting)'); // both words would pass the 60 character limit
    expect(changed.some((c) => c.startsWith('title'))).toBe(true);
    const koth: Record<string, unknown> = { title: 'Canyon Tag Arena (king of the hill)', hazard: 'water', mode: { kind: 'king_of_the_hill' } };
    applyBriefHints(koth, 'A king of the hill battle in a desert canyon');
    expect(koth.title).toBe('Canyon Tag Arena (king of the hill, no combat)');
    const ok: Record<string, unknown> = { title: 'Misty Valley Hunt', hazard: 'water' };
    applyBriefHints(ok, 'A relic hunt in a misty forest valley');
    expect(ok.title).toBe('Misty Valley Hunt');
    const said: Record<string, unknown> = { title: 'Tree Hunt (no shooting)', hazard: 'water' };
    applyBriefHints(said, 'shoot the trees');
    expect(said.title).toBe('Tree Hunt (no shooting)');
    const long: Record<string, unknown> = { title: 'An Extremely Long Title For A Forest Of Walking Trees Here', hazard: 'water' };
    applyBriefHints(long, 'drive tanks and shoot enemies');
    expect(String(long.title).length).toBeLessThanOrEqual(60);
    expect(String(long.title)).toContain('no shooting');
  });

  it('a brief INVALID_REFERENCE repair names the missing island fix', async () => {
    const { validatorRepairPrompt } = await import('../../packages/agent/src/prompts.ts');
    const hint = validatorRepairPrompt([{ code: 'INVALID_REFERENCE', message: 'gate references unknown island i4', objectIds: ['gate', 'i4'] }], null);
    expect(hint).toContain('add that island to islands');
  });

  it('expansion in a ground world says clearings and keeps the geometry identical', () => {
    const spec = fixtureSpec();
    const target = spec.islands[0].id;
    const islands = expansionSystemPrompt(spec, target, 'east');
    const ground = expansionSystemPrompt({ ...spec, terrain: 'ground' }, target, 'east');
    expect(islands).toContain('floating-island world');
    expect(islands).not.toContain('clearing');
    expect(ground).toContain('clearings joined by paths');
    expect(ground).toContain(`Target: clearing ${target}`);
    const answer = (t: string) => t.split('\n').find((l) => l.startsWith('Valid answer'))?.replace(/"summary":"[^"]*"/, '');
    expect(answer(ground)).toBe(answer(islands));
    expect(answer(ground)).toContain('"op":"add_island"');
  });
});
