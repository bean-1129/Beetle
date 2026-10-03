#!/usr/bin/env node
// Pre-demo readiness check. Read-only. Exits 1 when a required item fails.
// Usage: node scripts/demo-check.mjs [--require-running]
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireRunning = process.argv.includes('--require-running');
const ollama = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.env.BEETLE_MODEL ?? readEnvFile('BEETLE_MODEL') ?? 'qwen3.5:4b';
const port = process.env.BEETLE_PORT ?? readEnvFile('BEETLE_PORT') ?? '7700';
const rows = [];
let failed = false;

function readEnvFile(key) {
  try {
    const line = readFileSync(join(root, '.env'), 'utf8').split('\n').find((l) => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() || undefined : undefined;
  } catch { return undefined; }
}
function row(name, ok, detail, required = true) {
  rows.push({ name, ok, detail });
  if (required && !ok) failed = true;
}
async function getJson(url, ms = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return res.json();
}

// Node
row('node >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node);

// OpenClaw
try {
  const v = execFileSync(join(root, '.tools/npm-global/bin/openclaw'), ['--version'], { encoding: 'utf8', timeout: 60000 }).trim();
  row('openclaw', true, v);
} catch (e) {
  row('openclaw', false, String(e.message).split('\n')[0]);
}

// Ollama + model (loopback only)
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(ollama)) row('ollama loopback', false, `${ollama} is not loopback`);
try {
  const tags = await getJson(ollama + '/api/tags');
  const names = (tags.models ?? []).map((m) => m.name);
  row('ollama reachable', true, ollama);
  row(`model ${model} present`, names.includes(model), names.join(', ') || 'no models');
} catch (e) {
  row('ollama reachable', false, String(e.message));
}

// Web build, secrets, data dirs
row('web build (apps/web/dist)', existsSync(join(root, 'apps/web/dist/index.html')), 'run: npm run build');
row('secrets (data/secrets.json or env)', existsSync(join(root, 'data/secrets.json')) || !!process.env.BEETLE_DIRECTOR_TOKEN, 'created by the server on first start', false);

// LAN URL
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
row('LAN address', !!lan, lan ? `http://${lan.address}:${port}` : 'no non-loopback IPv4');

// Running server + agent
try {
  const h = await getJson(`http://127.0.0.1:${port}/api/health`);
  row('server health', !!h.ok, `v${h.worldVersion} world=${h.hasWorld} players=${h.players} controllers=${h.connectedControllers}`, requireRunning);
  row('agent worker connected', !!h.agentConnected, h.agentConnected ? 'claimed within 30 s' : 'start: npm run agent', requireRunning);
  row('server sees model', !!(h.model && h.model.reachable && h.model.present), JSON.stringify(h.model), requireRunning);
} catch (e) {
  row('server health', false, `not running on ${port}: ${String(e.message).split('\n')[0]}`, requireRunning);
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(width)}  ${r.detail}`);
console.log(failed ? '\nNot ready.' : '\nReady.');
process.exit(failed ? 1 : 0);
