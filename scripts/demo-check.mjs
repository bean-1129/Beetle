#!/usr/bin/env node
// Pre-demo readiness check for Beetle 2D. Read-only. Exits 1 when a required item fails.
//   node scripts/demo-check.mjs [--require-running]
// Checks: Node version, Ollama reachable on loopback, model present, web build present,
// and (required only with --require-running) the server health endpoint.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireRunning = process.argv.includes('--require-running');
const ollama = (process.env.OLLAMA_BASE_URL ?? readEnvFile('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const model = process.env.BEETLE_MODEL ?? readEnvFile('BEETLE_MODEL') ?? 'qwen3.5:4b';
const port = process.env.BEETLE_PORT ?? readEnvFile('BEETLE_PORT') ?? '7700';
const rows = [];
let failed = false;

function readEnvFile(key) {
  try {
    const line = readFileSync(join(root, '.env'), 'utf8').split('\n').find((l) => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}
function row(name, ok, detail, required = true) {
  rows.push({ name, ok, detail, required });
  if (required && !ok) failed = true;
}
async function getJson(url, ms = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

// Node
const nodeMajor = Number(process.versions.node.split('.')[0]);
row('node >= 24', nodeMajor >= 24, process.versions.node);

// Ollama + model (loopback only)
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(ollama);
row('ollama on loopback', loopback, loopback ? ollama : `${ollama} is not a loopback address`);
if (loopback) {
  try {
    const tags = await getJson(ollama + '/api/tags');
    const names = (tags.models ?? []).map((m) => m.name);
    row('ollama reachable', true, ollama);
    row(`model ${model} present`, names.includes(model), names.join(', ') || 'no models pulled');
  } catch (e) {
    row('ollama reachable', false, `${ollama}: ${firstLine(e)}`);
    row(`model ${model} present`, false, 'ollama not reachable');
  }
}

// Web build
row('web build (apps/web/dist/studio2d.html)', existsSync(join(root, 'apps/web/dist/studio2d.html')), 'run: npm run build');

// Running server
try {
  const h = await getJson(`http://127.0.0.1:${port}/api/health`);
  row('server health', h.ok !== false, `127.0.0.1:${port} ${JSON.stringify(h)}`, requireRunning);
} catch (e) {
  row('server health', false, `not running on ${port}: ${firstLine(e)}`, requireRunning);
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'OK  ' : r.required ? 'FAIL' : 'SKIP'} ${r.name.padEnd(width)}  ${r.detail}`);
console.log(failed ? '\nNot ready.' : '\nReady.');
process.exit(failed ? 1 : 0);
