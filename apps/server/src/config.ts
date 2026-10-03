// Server configuration: environment parsing plus programmatic overrides for in-process tests.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type StartWorld = 'none' | 'fixture';

export type ServerConfig = {
  host: string;
  port: number;
  /** Explicit public URL (BEETLE_PUBLIC_URL) or null to auto-detect the first LAN IPv4 at listen time. */
  publicUrl: string | null;
  dataDir: string;
  directorToken: string | null;
  agentToken: string | null;
  ollamaBaseUrl: string;
  modelName: string;
  startWorld: StartWorld;
  /** Directory with the built web client, or null to skip static serving. */
  webDistDir: string | null;
  logRequests: boolean;
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'data');
export const DEFAULT_WEB_DIST = path.join(REPO_ROOT, 'apps', 'web', 'dist');

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  return v === '' ? null : v;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const startWorldRaw = (env.BEETLE_START_WORLD ?? '').trim().toLowerCase();
  return {
    host: readOptional(env.BEETLE_HOST) ?? '0.0.0.0',
    port: readInt(env.BEETLE_PORT, 7700),
    publicUrl: readOptional(env.BEETLE_PUBLIC_URL),
    dataDir: readOptional(env.BEETLE_DATA_DIR) ?? DEFAULT_DATA_DIR,
    directorToken: readOptional(env.BEETLE_DIRECTOR_TOKEN),
    agentToken: readOptional(env.BEETLE_AGENT_TOKEN),
    ollamaBaseUrl: readOptional(env.OLLAMA_BASE_URL) ?? 'http://127.0.0.1:11434',
    modelName: readOptional(env.BEETLE_MODEL) ?? 'qwen3.5:4b',
    startWorld: startWorldRaw === 'fixture' ? 'fixture' : 'none',
    webDistDir: readOptional(env.BEETLE_WEB_DIST) ?? DEFAULT_WEB_DIST,
    logRequests: (env.BEETLE_LOG_REQUESTS ?? '1') !== '0',
  };
}

/** First non-internal IPv4 address, preferring interfaces that look like a LAN link. */
export function firstLanIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name] ?? [];
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('127.')) continue;
      return info.address;
    }
  }
  return null;
}

/** publicUrl = BEETLE_PUBLIC_URL or http://<first non-loopback IPv4>:<port>, falling back to localhost. */
export function derivePublicUrl(explicit: string | null, port: number): string {
  if (explicit) return explicit.replace(/\/+$/, '');
  const ip = firstLanIPv4() ?? '127.0.0.1';
  return `http://${ip}:${port}`;
}

/** Tiny .env parser (KEY=VALUE lines, # comments, optional quotes). Never overrides existing env. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}
