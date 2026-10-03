// Mode 'openclaw': the submission path. One request = one `openclaw agent exec` run in an isolated OpenClaw home.
// The model inside OpenClaw drives the seven Beetle tools (plugin under packages/agent/openclaw-plugin); every tool
// call is an HTTP request to the Beetle server. This runner only hands over the request, waits, reads the evidence
// file the plugin writes, publishes a report if the model did not, and finishes the request.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { DirectorRequest, ValidationCode } from '@beetle/contracts';
import type { EventInput } from '@beetle/observability';
import { isLoopbackUrl, type AgentConfig } from './config.ts';
import type { JobResult } from './jobs.ts';
import { openclawInstructionPrompt } from './prompts.ts';
import type { BeetleClient, ToolCallRecord } from './tools.ts';

export const OPENCLAW_PLUGIN_ID = 'beetle-tools';
export const OPENCLAW_GATEWAY_PORT = 18799;
/** The embedded run needs several sequential model calls that queue behind other Ollama clients; give it OpenClaw's own default. */
export const OPENCLAW_EXEC_TIMEOUT_MS_DEFAULT = 600_000;

export function openclawExecTimeoutMs(config: AgentConfig): number {
  const fromEnv = Number(process.env.BEETLE_OPENCLAW_TIMEOUT_MS);
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : OPENCLAW_EXEC_TIMEOUT_MS_DEFAULT;
  return Math.max(config.requestDeadlineMs, base);
}

/**
 * Core OpenClaw tools denied for the Beetle agent (on top of tools.profile "minimal"). This exact list is the one
 * verified end to end with OpenClaw 2026.9.8 (see SMOKE.md). A longer list covering the whole core catalog
 * (OPENCLAW_EXTENDED_DENY) timed out twice while the shared GPU was saturated and is therefore not the default.
 */
export const OPENCLAW_DENIED_TOOLS = [
  'exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'browser', 'web_fetch', 'web_search', 'fetch',
  'gateway', 'cron', 'sessions_spawn', 'sessions_send', 'sessions_list', 'sessions_history', 'session_status',
  'canvas', 'image', 'nodes', 'message', 'memory_search', 'memory_get', 'tts', 'openclaw', 'skills', 'plugins_install',
  'presence',
] as const;

/** The rest of the 2026.9.8 core catalog (dist core-tool-factory-descriptors). Opt in with BEETLE_OPENCLAW_EXTENDED_DENY=1. */
export const OPENCLAW_EXTENDED_DENY = [
  'agents_list', 'agents_wait', 'ask_user', 'computer', 'conversations_list', 'conversations_send', 'conversations_turn',
  'create_goal', 'dashboard', 'decision_evaluate', 'dismiss_task', 'get_goal', 'github_identity_status', 'github_publish',
  'heartbeat_respond', 'image_generate', 'ls', 'mobile_ui', 'music_generate', 'pdf', 'personal_instructions', 'plugins',
  'portal', 'progress_card', 'screen', 'secrets', 'sessions', 'sessions_search', 'sessions_yield', 'show_widget',
  'skill_workshop', 'subagents', 'suggest_task', 'terminal', 'theme', 'transcripts', 'update_goal', 'video_generate',
  'view_image', 'tool_search', 'update_plan', 'workboard', 'llm_task', 'file_transfer', 'clipboard', 'screenshot', 'location',
] as const;

export const BEETLE_TOOL_NAMES_FOR_OPENCLAW = ['read_world_state', 'propose_world', 'propose_patch', 'validate_candidate', 'run_playability_checks', 'commit_candidate', 'publish_build_report'] as const;

export type OpenClawRunnerDeps = {
  config: AgentConfig;
  client: BeetleClient;
  emit?: (e: EventInput) => void;
  log?: (line: string) => void;
};

export function openclawPaths(config: AgentConfig) {
  const home = config.openclawHome;
  return {
    home,
    configPath: resolve(home, 'openclaw.json'),
    workspace: resolve(home, 'workspace'),
    runs: resolve(home, 'runs'),
    extensions: resolve(home, 'extensions'),
    pluginDir: resolve(config.repoRoot, 'packages', 'agent', 'openclaw-plugin'),
    installedManifest: resolve(home, 'extensions', OPENCLAW_PLUGIN_ID, 'openclaw.plugin.json'),
  };
}

export function openclawEnv(config: AgentConfig, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const p = openclawPaths(config);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: p.home,
    OPENCLAW_CONFIG_PATH: p.configPath,
    PATH: `${resolve(config.repoRoot, '.tools', 'node', 'bin')}:${resolve(config.repoRoot, '.tools', 'npm-global', 'bin')}:${process.env.PATH ?? ''}`,
    DO_NOT_TRACK: '1',
    OPENCLAW_NO_AUTO_UPDATE: '1',
  };
  // Never leak the agent token into the child through inherited env unless the caller passes it on purpose.
  delete env.BEETLE_AGENT_TOKEN;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** The isolated OpenClaw config: native Ollama on loopback, one model, no fallbacks, loopback gateway, Beetle tools only. */
export function buildOpenClawConfig(config: AgentConfig, gatewayToken: string): Record<string, unknown> {
  const p = openclawPaths(config);
  return {
    models: {
      mode: 'replace',
      providers: {
        ollama: {
          baseUrl: config.ollamaBaseUrl,
          apiKey: 'ollama-local',
          api: 'ollama',
          timeoutSeconds: 300,
          models: [{
            id: config.model, name: config.model, reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768, contextTokens: 8192, maxTokens: 2048,
            params: { num_ctx: 8192, think: false, temperature: 0.2, keep_alive: '15m' },
          }],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: `ollama/${config.model}`, fallbacks: [] },
        thinkingDefault: 'off',
        timeoutSeconds: Math.ceil(openclawExecTimeoutMs(config) / 1000),
        workspace: p.workspace,
        skipBootstrap: true,
        sandbox: { mode: 'off' },
      },
    },
    tools: {
      profile: 'minimal',
      // tools.allow (absolute allowlist) hides plugin tools from the embedded run on 2026.9.8; alsoAllow is what works.
      alsoAllow: [OPENCLAW_PLUGIN_ID, ...BEETLE_TOOL_NAMES_FOR_OPENCLAW],
      deny: process.env.BEETLE_OPENCLAW_EXTENDED_DENY === '1' ? [...OPENCLAW_DENIED_TOOLS, ...OPENCLAW_EXTENDED_DENY] : [...OPENCLAW_DENIED_TOOLS],
      toolSearch: false,
      exec: { security: 'deny' },
      fs: { workspaceOnly: true },
      web: { search: { enabled: false }, fetch: { enabled: false } },
    },
    gateway: { mode: 'local', bind: 'loopback', port: OPENCLAW_GATEWAY_PORT, auth: { mode: 'token', token: gatewayToken } },
    update: { checkOnStart: false, auto: { enabled: false } },
    telemetry: { enabled: false },
    diagnostics: { otel: { enabled: false } },
    plugins: {
      enabled: true,
      allow: [OPENCLAW_PLUGIN_ID],
      entries: { [OPENCLAW_PLUGIN_ID]: { enabled: true, config: { serverUrl: config.serverUrl, secretsPath: resolve(config.dataDir, 'secrets.json'), model: config.model } } },
    },
  };
}

/**
 * Refuse to run unless the config on disk is still the local-only profile: exactly one loopback Ollama provider,
 * no fallbacks, loopback gateway, only the Beetle plugin allowed, shell execution denied. Returns the problems found.
 */
export function auditOpenClawConfig(cfg: Record<string, unknown> | null, expectedModel: string, ollamaBaseUrl: string): string[] {
  const problems: string[] = [];
  if (!cfg) return ['config file missing or unreadable'];
  const models = cfg.models as { mode?: string; providers?: Record<string, { baseUrl?: string; api?: string }> } | undefined;
  const providers = models?.providers ?? {};
  const ids = Object.keys(providers);
  if (models?.mode !== 'replace') problems.push(`models.mode must be replace, got ${String(models?.mode)}`);
  if (ids.length !== 1 || ids[0] !== 'ollama') problems.push(`exactly one provider (ollama) expected, got [${ids.join(', ')}]`);
  const prov = providers.ollama;
  if (prov && !isLoopbackUrl(prov.baseUrl ?? '')) problems.push(`provider baseUrl must be loopback, got ${String(prov.baseUrl)}`);
  if (prov && prov.baseUrl?.replace(/\/+$/, '') !== ollamaBaseUrl) problems.push(`provider baseUrl ${String(prov.baseUrl)} does not match OLLAMA_BASE_URL ${ollamaBaseUrl}`);
  if (prov && prov.api !== 'ollama') problems.push('provider api must be the native ollama adapter');
  const agents = cfg.agents as { defaults?: { model?: { primary?: string; fallbacks?: unknown[] } } } | undefined;
  const model = agents?.defaults?.model;
  if (model?.primary !== `ollama/${expectedModel}`) problems.push(`agents.defaults.model.primary must be ollama/${expectedModel}, got ${String(model?.primary)}`);
  if (!Array.isArray(model?.fallbacks) || model.fallbacks.length !== 0) problems.push('agents.defaults.model.fallbacks must be []');
  const gateway = cfg.gateway as { bind?: string; mode?: string } | undefined;
  if (gateway?.bind !== 'loopback') problems.push(`gateway.bind must be loopback, got ${String(gateway?.bind)}`);
  if (gateway?.mode !== 'local') problems.push('gateway.mode must be local');
  const plugins = cfg.plugins as { allow?: unknown[] } | undefined;
  if (!Array.isArray(plugins?.allow) || plugins.allow.length !== 1 || plugins.allow[0] !== OPENCLAW_PLUGIN_ID) problems.push(`plugins.allow must be exactly [${OPENCLAW_PLUGIN_ID}]`);
  const tools = cfg.tools as { exec?: { security?: string }; deny?: unknown[]; toolSearch?: unknown } | undefined;
  if (tools?.exec?.security !== 'deny') problems.push('tools.exec.security must be deny');
  if (!Array.isArray(tools?.deny) || !tools.deny.includes('exec')) problems.push('tools.deny must include exec');
  const update = cfg.update as { checkOnStart?: boolean; auto?: { enabled?: boolean } } | undefined;
  if (update?.checkOnStart !== false || update?.auto?.enabled !== false) problems.push('update checks must be disabled');
  const telemetry = cfg.telemetry as { enabled?: boolean } | undefined;
  if (telemetry?.enabled !== false) problems.push('telemetry must be disabled');
  return problems;
}

/** Redact bearer tokens and long hex strings before anything from OpenClaw stderr is stored or logged. */
export function sanitizeText(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]').replace(/\b[0-9a-f]{32,}\b/gi, '[hex-redacted]');
}

function secretsFileHasToken(path: string, token: string): boolean {
  const j = readJson(path);
  return Boolean(j && typeof j.agentToken === 'string' && j.agentToken === token);
}

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

/**
 * Create or refresh the isolated OpenClaw home: directories, config (existing gateway token kept, plugin entry
 * refreshed) and the plugin install. `build` runs the esbuild bundle and `openclaw plugins build` first.
 */
export function ensureOpenClawHome(config: AgentConfig, opts: { build?: boolean; log?: (line: string) => void } = {}): { configPath: string; installed: boolean } {
  const log = opts.log ?? (() => undefined);
  const p = openclawPaths(config);
  for (const dir of [p.home, p.workspace, p.runs, p.extensions]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readJson(p.configPath);
  const existingToken = (existing?.gateway as { auth?: { token?: string } } | undefined)?.auth?.token;
  const token = typeof existingToken === 'string' && existingToken.length >= 16 ? existingToken : randomBytes(24).toString('hex');
  writeFileSync(p.configPath, JSON.stringify(buildOpenClawConfig(config, token), null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(p.configPath, 0o600); } catch { /* best effort */ }
  log(`[openclaw] wrote ${p.configPath}`);
  if (opts.build) {
    run(config, process.execPath, [resolve(p.pluginDir, 'build.mjs')], { cwd: p.pluginDir, log });
    run(config, config.openclawBin, ['plugins', 'build', '--root', p.pluginDir, '--entry', './dist/index.js'], { log });
    run(config, config.openclawBin, ['plugins', 'validate', '--root', p.pluginDir, '--entry', './dist/index.js'], { log });
  }
  let installed = existsSync(p.installedManifest);
  if (!installed || opts.build) {
    const r = run(config, config.openclawBin, ['plugins', 'install', p.pluginDir, '--force', '--accept-capabilities'], { log });
    installed = r.status === 0 && existsSync(p.installedManifest);
  }
  return { configPath: p.configPath, installed };
}

function run(config: AgentConfig, bin: string, args: string[], opts: { cwd?: string; log?: (line: string) => void }) {
  const r = spawnSync(bin, args, { cwd: opts.cwd ?? config.repoRoot, env: openclawEnv(config), encoding: 'utf8', timeout: 120_000 });
  const out = (r.stdout + '\n' + r.stderr).trim().split('\n').filter(Boolean).slice(-6).join(' | ');
  opts.log?.(`[openclaw] ${[bin.split('/').pop(), ...args.slice(0, 3)].join(' ')} -> exit ${r.status}${out ? ': ' + out.slice(0, 400) : ''}`);
  if (r.status !== 0) throw new Error(`${args.slice(0, 2).join(' ')} failed with exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r;
}

/** Health view of the OpenClaw setup; never throws. */
export async function checkOpenClawSetup(config: AgentConfig): Promise<Record<string, unknown>> {
  const p = openclawPaths(config);
  const out: Record<string, unknown> = { bin: config.openclawBin, binPresent: existsSync(config.openclawBin), home: p.home, configPresent: existsSync(p.configPath), pluginInstalled: existsSync(p.installedManifest) };
  if (!out.binPresent) return { ...out, ready: false };
  const v = spawnSync(config.openclawBin, ['--version'], { env: openclawEnv(config), encoding: 'utf8', timeout: 30_000 });
  out.version = (v.stdout || '').trim().split('\n')[0];
  if (out.pluginInstalled) {
    const r = spawnSync(config.openclawBin, ['plugins', 'inspect', OPENCLAW_PLUGIN_ID, '--runtime', '--json'], { env: openclawEnv(config), encoding: 'utf8', timeout: 60_000 });
    try {
      const text = r.stdout.slice(r.stdout.indexOf('{'));
      const j = JSON.parse(text) as { plugin?: { status?: string; toolNames?: string[] } };
      out.pluginStatus = j.plugin?.status;
      out.pluginTools = j.plugin?.toolNames;
    } catch { out.pluginStatus = 'inspect failed'; }
  }
  out.ready = Boolean(out.binPresent && out.configPresent && out.pluginInstalled && out.pluginStatus === 'loaded');
  return out;
}

export type ExecEnvelope = {
  ok?: boolean; status?: string; final?: string; error?: { message?: string; kind?: string };
  assistantTurns?: number; toolSummary?: { calls?: number; tools?: string[]; failures?: number; totalToolTimeMs?: number };
  usage?: { input?: number; output?: number; total?: number }; model?: string | null; provider?: string | null; sessionId?: string;
};

type RunLine = { at: number; kind: string; tool?: string; ok?: boolean; ms?: number; worldVersion?: number; reportId?: string; code?: string; retryable?: boolean; outcome?: string };

export function readRunFile(path: string): RunLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as RunLine]; } catch { return []; } });
}

export function createOpenClawRunner(deps: OpenClawRunnerDeps) {
  const { config, client } = deps;
  const log = deps.log ?? (() => undefined);
  const emit = (e: EventInput) => { try { deps.emit?.(e); } catch { /* ignore */ } };

  async function run(request: DirectorRequest): Promise<JobResult> {
    const startedAt = Date.now();
    const p = openclawPaths(config);
    mkdirSync(p.runs, { recursive: true });
    const promptPath = resolve(p.runs, `${request.id}.prompt.txt`);
    const runFile = resolve(p.runs, `${request.id}.jsonl`);
    const envelopePath = resolve(p.runs, `${request.id}.exec.json`);
    writeFileSync(promptPath, openclawInstructionPrompt({ kind: request.kind, requestId: request.id, prompt: request.prompt, model: config.model }));
    try { writeFileSync(runFile, ''); } catch { /* ignore */ }

    emit({ name: 'job.start', requestId: request.id, model: config.model, data: { mode: 'openclaw', kind: request.kind, deadlineMs: config.requestDeadlineMs } });

    // Fail closed: the profile on disk must still be local-only before every run.
    const problems = auditOpenClawConfig(readJson(p.configPath), config.model, config.ollamaBaseUrl);
    if (problems.length > 0) {
      const error = { code: 'OPENCLAW_CONFIG_UNSAFE', message: `refusing to run OpenClaw: ${problems.join('; ')}`.slice(0, 400) };
      log(`[openclaw] ${request.id}: ${error.message}`);
      emit({ name: 'openclaw.config.rejected', requestId: request.id, outcome: 'fail', codes: [error.code], data: { mode: 'openclaw', problems } });
      await safeStatus(request.id, { phase: 'failed', message: `[openclaw] ${error.message}`.slice(0, 400), codes: [error.code] });
      try { await client.finish(request.id, { outcome: 'failed', error }); } catch (err) { log(`[openclaw] finish failed: ${(err as Error).message}`); }
      return { outcome: 'failed', baseWorldVersion: request.worldVersionAtRequest, error, validationAttempts: 0, failedCodes: [], modelCalls: 0, toolCalls: [], totalMs: Date.now() - startedAt };
    }
    await safeStatus(request.id, { phase: 'planning', message: `[openclaw] handing the ${request.kind} to OpenClaw (${config.model})` });

    const timeoutSec = Math.max(30, Math.ceil(openclawExecTimeoutMs(config) / 1000));
    const args = [
      'agent', 'exec',
      '--config', p.configPath,
      '--model', `ollama/${config.model}`,
      '--thinking', 'off',
      '--code-mode', 'direct',
      '--json',
      '--timeout', String(timeoutSec),
      '--cwd', p.workspace,
      '--message-file', promptPath,
    ];
    // The plugin reads the token from data/secrets.json when that file holds it; only otherwise does the env carry it.
    const secretsPath = resolve(config.dataDir, 'secrets.json');
    const tokenViaFile = secretsFileHasToken(secretsPath, config.agentToken);
    const env = openclawEnv(config, {
      BEETLE_SERVER_URL: config.serverUrl,
      BEETLE_AGENT_TOKEN: tokenViaFile ? undefined : config.agentToken,
      BEETLE_REQUEST_ID: request.id,
      BEETLE_REQUEST_CREATED_AT: String(request.createdAt),
      BEETLE_MODEL: config.model,
      BEETLE_OPENCLAW_RUN_FILE: runFile,
      BEETLE_MAX_TOOL_CALLS: String(config.maxToolCalls),
    });
    log(`[openclaw] ${request.id}: openclaw ${args.join(' ')}`);
    const t0 = Date.now();
    const exec = await execOpenClaw(config.openclawBin, args, env, timeoutSec * 1000 + 20_000);
    const execMs = Date.now() - t0;
    let envelope: ExecEnvelope = {};
    try { envelope = JSON.parse(exec.stdout.slice(exec.stdout.indexOf('{'))) as ExecEnvelope; } catch { envelope = { ok: false, status: 'error', error: { message: sanitizeText(`no JSON envelope (exit ${exec.code}): ${(exec.stderr || exec.stdout).slice(-300)}`), kind: 'parse' } }; }
    if (envelope.error?.message) envelope.error.message = sanitizeText(envelope.error.message);
    try { writeFileSync(envelopePath, JSON.stringify({ exitCode: exec.code, timedOut: exec.timedOut, tokenViaFile, envelope, stderrTail: sanitizeText(exec.stderr.slice(-2000)) }, null, 2)); } catch { /* ignore */ }
    emit({ name: 'openclaw.exec', requestId: request.id, model: config.model, outcome: envelope.ok ? 'ok' : 'fail', durationMs: execMs, data: { mode: 'openclaw', exitCode: exec.code, timedOut: exec.timedOut, status: envelope.status, assistantTurns: envelope.assistantTurns, toolSummary: envelope.toolSummary, usage: envelope.usage, error: envelope.error?.message } });

    const lines = readRunFile(runFile);
    const toolCalls: ToolCallRecord[] = lines.filter((l) => l.kind === 'tool' && l.tool).map((l) => ({ tool: l.tool as string, ok: Boolean(l.ok), ms: l.ms ?? 0 }));
    const commit = [...lines].reverse().find((l) => l.kind === 'commit' && l.ok);
    const report = [...lines].reverse().find((l) => l.kind === 'report' && l.ok);
    const failedCodes = lines.filter((l) => l.kind === 'commit' && !l.ok && l.code).map((l) => l.code as ValidationCode);
    const worldVersion = commit?.worldVersion;
    let outcome: JobResult['outcome'] = worldVersion !== undefined ? 'committed' : 'failed';
    let error: JobResult['error'];
    if (outcome === 'failed') {
      if (exec.timedOut || envelope.status === 'timeout') error = { code: 'OPENCLAW_TIMEOUT', message: `OpenClaw run exceeded ${timeoutSec} s without a commit` };
      else if (envelope.error?.message) error = { code: 'OPENCLAW_ERROR', message: envelope.error.message.slice(0, 400) };
      else error = { code: failedCodes[0] ?? 'OPENCLAW_NO_COMMIT', message: `OpenClaw finished (${envelope.status ?? 'unknown'}, ${toolCalls.length} tool calls) without committing a candidate` };
    }
    log(`[openclaw] ${request.id}: exec exit ${exec.code} status=${envelope.status} turns=${envelope.assistantTurns ?? '?'} tools=${(envelope.toolSummary?.tools ?? []).join(',')} outcome=${outcome}${worldVersion !== undefined ? ' v' + worldVersion : ''}${error ? ' ' + error.code : ''}`);

    let reportId = report?.reportId;
    if (!reportId) {
      try {
        const r = await client.publish_build_report({
          requestId: request.id, mode: 'openclaw', model: config.model, outcome,
          worldVersion: worldVersion ?? request.worldVersionAtRequest, baseWorldVersion: request.worldVersionAtRequest,
          summary: `[openclaw] ${outcome === 'committed' ? envelope.final ?? 'committed' : `${error?.code}: ${error?.message}`}`.slice(0, 600),
          validation: { attempts: toolCalls.filter((t) => t.tool === 'validate_candidate').length, failedCodes: failedCodes.slice(0, 32) },
          timings: { requestedAt: request.createdAt, committedMs: commit ? commit.at - startedAt : undefined, totalMs: Date.now() - startedAt },
          toolCalls: toolCalls.slice(0, 64),
        });
        reportId = r.reportId;
      } catch (err) { log(`[openclaw] report publish failed: ${(err as Error).message}`); }
    }
    if (outcome === 'failed') await safeStatus(request.id, { phase: 'failed', message: `[openclaw] ${error?.code}: ${error?.message}`.slice(0, 400), codes: error ? [error.code] : undefined });
    try { await client.finish(request.id, { outcome, worldVersion, reportId, error }); } catch (err) { log(`[openclaw] finish failed: ${(err as Error).message}`); }
    const totalMs = Date.now() - startedAt;
    emit({ name: 'job.finish', requestId: request.id, model: config.model, outcome: outcome === 'committed' ? 'ok' : 'fail', worldVersion, durationMs: totalMs, codes: error ? [error.code] : undefined, data: { mode: 'openclaw', reportId, toolCalls: toolCalls.length, assistantTurns: envelope.assistantTurns } });
    return { outcome, worldVersion, baseWorldVersion: request.worldVersionAtRequest, reportId, error, validationAttempts: toolCalls.filter((t) => t.tool === 'validate_candidate').length, failedCodes, modelCalls: envelope.assistantTurns ?? 0, toolCalls, totalMs };
  }

  async function safeStatus(requestId: string, body: { phase: 'queued' | 'planning' | 'validating' | 'repairing' | 'awaiting_safe_commit' | 'committed' | 'failed' | 'cancelled'; message: string; codes?: string[] }) {
    try { await client.status(requestId, body); } catch (err) { log(`[openclaw] status failed: ${(err as Error).message}`); }
  }

  return { mode: 'openclaw' as const, run };
}

function execOpenClaw(bin: string, args: string[], env: NodeJS.ProcessEnv, killAfterMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveExec) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, killAfterMs);
    child.on('error', (err) => { clearTimeout(timer); resolveExec({ code: null, stdout, stderr: stderr + '\n' + err.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolveExec({ code, stdout, stderr, timedOut }); });
  });
}
