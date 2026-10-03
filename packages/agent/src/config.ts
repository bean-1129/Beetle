// Agent configuration. Fail closed: every network target must be loopback.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';

export type AgentMode = 'openclaw' | 'direct';

export type AgentConfig = {
  mode: AgentMode;
  serverUrl: string;
  agentToken: string;
  ollamaBaseUrl: string;
  model: string;
  requestDeadlineMs: number;
  maxRepairAttempts: number;
  maxToolCalls: number;
  modelCallTimeoutMs: number;
  repoRoot: string;
  dataDir: string;
  workerId: string;
  openclawHome: string;
  openclawBin: string;
};

export const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:7700',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:4b',
  requestDeadlineMs: 120_000,
  maxRepairAttempts: 2,
  maxToolCalls: 16,
  modelCallTimeoutMs: 90_000,
} as const;

/** Repo root derived from this file's location (packages/agent/src -> repo). */
export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/** True only for loopback URLs. Anything else is refused by the agent (no cloud, no LAN model hosts). */
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function assertLoopbackUrl(url: string, what: string): string {
  if (!isLoopbackUrl(url)) {
    throw new Error(`${what} must be a loopback URL (127.0.0.1 or localhost); refusing ${safeUrlForError(url)}`);
  }
  return url.replace(/\/+$/, '');
}

function safeUrlForError(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return '[unparseable url]'; }
}

function intEnv(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type LoadConfigOptions = { env?: NodeJS.ProcessEnv; repoRoot?: string; mode?: AgentMode };

/** Reads env, then data/secrets.json for the agent token when BEETLE_AGENT_TOKEN is absent. */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<AgentConfig> {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? env.BEETLE_REPO_ROOT ?? defaultRepoRoot();
  const dataDir = env.BEETLE_DATA_DIR ? resolve(env.BEETLE_DATA_DIR) : resolve(repoRoot, 'data');
  const modeRaw = opts.mode ?? env.BEETLE_AGENT_MODE ?? 'openclaw';
  if (modeRaw !== 'openclaw' && modeRaw !== 'direct') throw new Error(`BEETLE_AGENT_MODE must be openclaw or direct, got ${modeRaw}`);
  const serverUrl = assertLoopbackUrl(env.BEETLE_SERVER_URL ?? DEFAULTS.serverUrl, 'BEETLE_SERVER_URL');
  const ollamaBaseUrl = assertLoopbackUrl(env.OLLAMA_BASE_URL ?? DEFAULTS.ollamaBaseUrl, 'OLLAMA_BASE_URL');
  let agentToken = env.BEETLE_AGENT_TOKEN ?? '';
  if (!agentToken) agentToken = await readAgentTokenFromSecrets(resolve(dataDir, 'secrets.json'));
  return {
    mode: modeRaw,
    serverUrl,
    agentToken,
    ollamaBaseUrl,
    model: env.BEETLE_MODEL ?? DEFAULTS.model,
    requestDeadlineMs: intEnv(env.BEETLE_REQUEST_DEADLINE_MS, DEFAULTS.requestDeadlineMs),
    maxRepairAttempts: intEnv(env.BEETLE_MAX_REPAIR_ATTEMPTS, DEFAULTS.maxRepairAttempts),
    maxToolCalls: intEnv(env.BEETLE_MAX_TOOL_CALLS, DEFAULTS.maxToolCalls),
    modelCallTimeoutMs: intEnv(env.BEETLE_MODEL_CALL_TIMEOUT_MS, DEFAULTS.modelCallTimeoutMs),
    repoRoot,
    dataDir,
    workerId: env.BEETLE_WORKER_ID ?? `agent-${hostname()}-${process.pid}`,
    openclawHome: env.OPENCLAW_HOME ?? resolve(repoRoot, '.openclaw-home'),
    openclawBin: env.OPENCLAW_BIN ?? resolve(repoRoot, '.tools', 'npm-global', 'bin', 'openclaw'),
  };
}

export async function readAgentTokenFromSecrets(path: string): Promise<string> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { agentToken?: unknown };
    if (typeof parsed.agentToken === 'string' && parsed.agentToken.length >= 8) return parsed.agentToken;
    throw new Error('secrets file has no agentToken');
  } catch (err) {
    throw new Error(`agent token not found: set BEETLE_AGENT_TOKEN or create ${path} (${(err as Error).message})`);
  }
}
