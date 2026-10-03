#!/usr/bin/env node
// Offline proof: observe-and-record only. Changes nothing on the system.
// Records data/offline-proof/<unix ms>.json and prints a one-page summary.
//
// Usage:
//   node scripts/offline-proof.mjs                      observe routes, sockets, Ollama, server, egress probe
//   node scripts/offline-proof.mjs --edit "<prompt>"    additionally submit ONE director edit and record its outcome
//   node scripts/offline-proof.mjs --expect-offline     exit 1 when the evidence does not show blocked egress
//
// The director token comes from BEETLE_DIRECTOR_TOKEN or data/secrets.json. It is never written to the record.
// Pure Node 24 built-ins.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resolver } from 'node:dns/promises';

const execFileP = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const editIdx = argv.indexOf('--edit');
const editPrompt = editIdx >= 0 ? argv[editIdx + 1] : null;
const expectOffline = argv.includes('--expect-offline');
if (editIdx >= 0 && !editPrompt) { console.error('--edit requires a prompt'); process.exit(2); }

function readEnvFile(key) {
  try {
    const line = readFileSync(join(root, '.env'), 'utf8').split('\n').find((l) => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() || undefined : undefined;
  } catch { return undefined; }
}
const OLLAMA = process.env.OLLAMA_BASE_URL ?? readEnvFile('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434';
const MODEL = process.env.BEETLE_MODEL ?? readEnvFile('BEETLE_MODEL') ?? 'qwen3.5:4b';
const PORT = process.env.BEETLE_PORT ?? readEnvFile('BEETLE_PORT') ?? '7700';
const SERVER = `http://127.0.0.1:${PORT}`;
const PROBE_URL = 'https://registry.npmjs.org/';
const PROBE_HOST = 'registry.npmjs.org';
const PROBE_TIMEOUT_MS = 3000;
const DEADLINE_MS = Number(process.env.BEETLE_REQUEST_DEADLINE_MS ?? readEnvFile('BEETLE_REQUEST_DEADLINE_MS') ?? 120000);

const startedAt = Date.now();
const record = {
  schema: 'beetle.offline-proof/1',
  timestamp: new Date(startedAt).toISOString(),
  timestampMs: startedAt,
  host: { platform: process.platform, node: process.versions.node },
  defaultRoute: null,
  defaultRoute6: null,
  listening: null,
  ollama: null,
  server: null,
  egressProbe: null,
  edit: null,
  verdict: null,
};

async function run(cmd, args) {
  const candidates = [cmd, `/usr/sbin/${cmd}`, `/sbin/${cmd}`, `/usr/bin/${cmd}`];
  let lastErr = null;
  for (const c of candidates) {
    try {
      const { stdout, stderr } = await execFileP(c, args, { timeout: 10_000, encoding: 'utf8' });
      return { ok: true, command: `${c} ${args.join(' ')}`, stdout, stderr };
    } catch (e) {
      lastErr = e;
      if (e.code !== 'ENOENT') break;
    }
  }
  return { ok: false, command: `${cmd} ${args.join(' ')}`, error: String(lastErr?.message ?? lastErr) };
}

async function defaultRoute(family) {
  const args = family === 6 ? ['-6', 'route', 'show', 'default'] : ['route', 'show', 'default'];
  const r = await run('ip', args);
  if (!r.ok) return { checked: false, exists: null, raw: null, error: r.error, command: r.command };
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const routes = lines.map((line) => {
    const via = /\bvia\s+(\S+)/.exec(line)?.[1] ?? null;
    const dev = /\bdev\s+(\S+)/.exec(line)?.[1] ?? null;
    const src = /\bsrc\s+(\S+)/.exec(line)?.[1] ?? null;
    const metric = /\bmetric\s+(\d+)/.exec(line)?.[1] ?? null;
    return { line, via, dev, src, metric: metric ? Number(metric) : null };
  });
  return { checked: true, exists: routes.length > 0, count: routes.length, routes, raw: r.stdout, command: r.command };
}

function classifyAddress(addr) {
  const a = addr.replace(/^\[|\]$/g, '').split('%')[0];
  if (a === '*' || a === '0.0.0.0' || a === '::' ) return 'all-interfaces';
  if (/^127\./.test(a) || a === '::1' || a === 'localhost') return 'loopback';
  return 'specific-interface';
}

async function listening() {
  const r = await run('ss', ['-ltnH']);
  if (!r.ok) return { checked: false, error: r.error, command: r.command };
  const sockets = [];
  for (const line of r.stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const i = local.lastIndexOf(':');
    if (i < 0) continue;
    const address = local.slice(0, i);
    const port = Number(local.slice(i + 1));
    const scope = classifyAddress(address);
    sockets.push({ local, address, port, scope });
  }
  const summary = {
    loopbackOnly: sockets.filter((s) => s.scope === 'loopback').map((s) => s.local),
    lanOrAll: sockets.filter((s) => s.scope !== 'loopback').map((s) => s.local),
  };
  const byPort = (p) => sockets.filter((s) => s.port === Number(p)).map((s) => s.scope);
  return {
    checked: true, command: r.command, sockets, summary,
    beetleServer: { port: Number(PORT), scopes: byPort(PORT) },
    ollama: { port: Number(new URL(OLLAMA).port || 80), scopes: byPort(new URL(OLLAMA).port || 80), loopbackOnly: byPort(new URL(OLLAMA).port || 80).length > 0 && byPort(new URL(OLLAMA).port || 80).every((s) => s === 'loopback') },
    raw: r.stdout,
  };
}

async function getJson(url, ms = 3000, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
    return { ok: res.ok, status: res.status, elapsedMs: Date.now() - t0, body };
  } catch (e) {
    return { ok: false, status: null, elapsedMs: Date.now() - t0, error: describeError(e) };
  }
}

function describeError(e) {
  const cause = e?.cause;
  return {
    name: e?.name ?? null,
    message: String(e?.message ?? e),
    code: e?.code ?? cause?.code ?? null,
    causeMessage: cause ? String(cause.message ?? cause) : null,
    causeErrors: Array.isArray(cause?.errors) ? cause.errors.map((x) => `${x.code ?? ''} ${x.message ?? x}`.trim()) : undefined,
  };
}

async function ollamaTags() {
  const r = await getJson(`${OLLAMA}/api/tags`, 3000);
  const models = r.ok && r.body && Array.isArray(r.body.models) ? r.body.models.map((m) => ({ name: m.name, size: m.size, digest: m.digest, quantization: m.details?.quantization_level ?? null })) : [];
  const url = new URL(OLLAMA);
  return {
    url: OLLAMA,
    loopback: /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname) || url.hostname === '::1',
    reachable: r.ok,
    status: r.status,
    elapsedMs: r.elapsedMs,
    models,
    configuredModel: MODEL,
    modelPresent: models.some((m) => m.name === MODEL),
    error: r.error ?? null,
  };
}

async function serverHealth() {
  const r = await getJson(`${SERVER}/api/health`, 3000);
  const b = r.ok && r.body && typeof r.body === 'object' ? r.body : null;
  return {
    url: `${SERVER}/api/health`,
    up: r.ok,
    status: r.status,
    elapsedMs: r.elapsedMs,
    ok: b?.ok ?? null,
    agentConnected: b?.agentConnected ?? null,
    worldVersion: b?.worldVersion ?? null,
    hasWorld: b?.hasWorld ?? null,
    players: b?.players ?? null,
    connectedControllers: b?.connectedControllers ?? null,
    model: b?.model ?? null,
    body: redact(b ?? r.body),
    error: r.error ?? null,
  };
}

async function dnsProbe(host) {
  const resolver = new Resolver();
  const t0 = Date.now();
  let timer;
  try {
    const addrs = await Promise.race([
      resolver.resolve4(host),
      new Promise((_, rej) => { timer = setTimeout(() => { resolver.cancel(); rej(new Error('dns timeout')); }, PROBE_TIMEOUT_MS); }),
    ]);
    return { resolved: true, addresses: addrs, servers: resolver.getServers(), elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { resolved: false, servers: resolver.getServers(), elapsedMs: Date.now() - t0, error: describeError(e) };
  } finally { clearTimeout(timer); }
}

async function egressProbe() {
  const dns = await dnsProbe(PROBE_HOST);
  const t0 = Date.now();
  try {
    const res = await fetch(PROBE_URL, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    return { url: PROBE_URL, timeoutMs: PROBE_TIMEOUT_MS, succeeded: true, status: res.status, elapsedMs: Date.now() - t0, dns };
  } catch (e) {
    return { url: PROBE_URL, timeoutMs: PROBE_TIMEOUT_MS, succeeded: false, elapsedMs: Date.now() - t0, error: describeError(e), dns };
  }
}

const REDACT_KEY = /token|secret|invite|authorization/i;
function redact(node) {
  if (Array.isArray(node)) return node.map(redact);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = REDACT_KEY.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  return node;
}

function directorToken() {
  const env = process.env.BEETLE_DIRECTOR_TOKEN;
  if (env && env.length >= 16) return { token: env, source: 'env BEETLE_DIRECTOR_TOKEN' };
  const file = join(root, 'data/secrets.json');
  if (existsSync(file)) {
    try {
      const t = JSON.parse(readFileSync(file, 'utf8')).directorToken;
      if (typeof t === 'string' && t.length >= 16) return { token: t, source: 'data/secrets.json' };
    } catch { /* fall through */ }
  }
  return { token: null, source: null };
}

async function submitEdit(prompt) {
  const { token, source } = directorToken();
  const out = { prompt, tokenSource: source, submitted: false };
  if (!token) return { ...out, error: 'no director token (set BEETLE_DIRECTOR_TOKEN or let the server create data/secrets.json)' };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const t0 = Date.now();
  const create = await getJson(`${SERVER}/api/director/requests`, 10_000, { method: 'POST', headers, body: JSON.stringify({ kind: 'edit', prompt }) });
  out.submitted = true;
  out.create = { status: create.status, ok: create.ok, elapsedMs: create.elapsedMs, body: redact(create.body), error: create.error ?? null };
  const body = create.body && typeof create.body === 'object' ? create.body : {};
  const id = body.id ?? body.request?.id ?? body.requestId ?? null;
  out.requestId = id;
  if (!create.ok || !id) { out.elapsedMs = Date.now() - t0; return out; }

  // Poll the request until a terminal phase or the deadline (+30 s grace).
  const terminal = new Set(['committed', 'failed', 'cancelled']);
  const until = Date.now() + DEADLINE_MS + 30_000;
  let last = null;
  while (Date.now() < until) {
    const r = await getJson(`${SERVER}/api/director/requests/${encodeURIComponent(id)}`, 5000, { headers });
    const rb = r.body && typeof r.body === 'object' ? (r.body.request ?? r.body) : null;
    last = { status: r.status, body: redact(rb ?? r.body) };
    if (rb && terminal.has(rb.status)) break;
    if (!r.ok && r.status === 404) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  out.elapsedMs = Date.now() - t0;
  out.final = last;
  out.outcome = last?.body?.status ?? 'unknown';
  out.resultWorldVersion = last?.body?.resultWorldVersion ?? null;
  out.error = last?.body?.error ?? null;

  const act = await getJson(`${SERVER}/api/director/activity`, 5000, { headers });
  const entries = Array.isArray(act.body) ? act.body : Array.isArray(act.body?.entries) ? act.body.entries : [];
  out.activity = redact(entries.filter((e) => e && e.requestId === id));
  out.activityFetch = { status: act.status, ok: act.ok, error: act.error ?? null };
  return out;
}

function verdict(rec) {
  const lines = [];
  const notShown = [];
  const r4 = rec.defaultRoute, r6 = rec.defaultRoute6, probe = rec.egressProbe;
  let egressBlocked = null;
  let reason = '';
  if (r4?.checked && r4.exists === false && (!r6?.checked || r6.exists === false)) {
    if (probe.succeeded) { egressBlocked = false; reason = 'no default route is present, yet the probe to registry.npmjs.org succeeded (another path exists: proxy, VPN or an interface-specific route)'; }
    else { egressBlocked = true; reason = 'by missing default route (IPv4 and IPv6); the probe to registry.npmjs.org failed'; }
  } else if (probe.succeeded) {
    egressBlocked = false; reason = `a default route exists (${r4?.routes?.[0]?.line ?? r6?.routes?.[0]?.line ?? 'see record'}) and the probe to registry.npmjs.org succeeded`;
  } else if (r4?.checked && r4.exists) {
    egressBlocked = 'partial'; reason = `a default route exists (${r4.routes[0].line}) but the probe to registry.npmjs.org failed (${probe.error?.code ?? probe.error?.message ?? 'unknown'}); the uplink was probably cut upstream (router or AP), which this script cannot verify`;
  } else {
    egressBlocked = null; reason = 'route information could not be read; see the record';
  }

  if (egressBlocked === true) lines.push(`egress blocked: yes, ${reason}.`);
  else if (egressBlocked === 'partial') lines.push(`egress blocked: probably (indirect evidence), ${reason}.`);
  else if (egressBlocked === false) lines.push(`egress was NOT blocked during this run (${reason}); this run does not prove offline operation.`);
  else lines.push(`egress blocked: unknown, ${reason}.`);

  const l = rec.listening;
  if (l?.checked) {
    lines.push(`listening sockets: ${l.summary.loopbackOnly.length} loopback-only (${l.summary.loopbackOnly.join(', ') || 'none'}); ${l.summary.lanOrAll.length} reachable from the LAN (${l.summary.lanOrAll.join(', ') || 'none'}).`);
    lines.push(`ollama port ${l.ollama.port}: ${l.ollama.scopes.length ? (l.ollama.loopbackOnly ? 'loopback only' : 'NOT loopback only: ' + l.ollama.scopes.join(',')) : 'not listening'}; beetle server port ${l.beetleServer.port}: ${l.beetleServer.scopes.length ? l.beetleServer.scopes.join(',') : 'not listening'}.`);
  } else lines.push(`listening sockets: could not run ss (${l?.error}).`);

  const o = rec.ollama;
  lines.push(`ollama ${o.url}: ${o.reachable ? 'reachable' : 'NOT reachable'}; model ${o.configuredModel}: ${o.modelPresent ? 'present' : 'NOT present'}${o.models.length ? ` (models: ${o.models.map((m) => m.name).join(', ')})` : ''}.`);

  const s = rec.server;
  lines.push(`beetle server ${s.url}: ${s.up ? `up (ok=${s.ok}, agentConnected=${s.agentConnected}, worldVersion=${s.worldVersion}, players=${s.players}, controllers=${s.connectedControllers})` : `NOT up (${s.error?.code ?? s.error?.message ?? s.status})`}.`);

  const e = rec.edit;
  if (e) {
    if (!e.submitted) lines.push(`edit: not submitted (${e.error}).`);
    else lines.push(`edit "${e.prompt}": create HTTP ${e.create.status}, outcome ${e.outcome}, elapsed ${e.elapsedMs} ms, world version ${e.resultWorldVersion ?? 'n/a'}, ${e.activity?.length ?? 0} activity entries${e.error ? `, error ${JSON.stringify(e.error)}` : ''}.`);
    if (e.submitted && e.outcome === 'committed' && egressBlocked === true) lines.push('a model-backed edit committed while no default route existed: this is the local-only evidence for this run.');
    else if (e.submitted && e.outcome === 'committed') lines.push('the edit committed, but egress was not shown to be blocked by route evidence; see above.');
  } else lines.push('no edit was submitted in this run (use --edit "<prompt>" during the rehearsal).');

  notShown.push('this is a snapshot at one moment; it does not show what happened before or after the run');
  notShown.push('the egress probe tests one host (registry.npmjs.org) over HTTPS; it does not enumerate every possible path (proxies, VPNs, other interfaces)');
  notShown.push('it does not capture packets and does not prove that no process attempted an outbound connection');
  notShown.push('the sockets list shows where services listen, not whether anything from the LAN connected');
  if (!e) notShown.push('without --edit it does not show that the agent produced a world change during the window');
  return { egressBlocked, reason, lines, notShown };
}

// ---- main ----
const [r4, r6, l, o, s, p] = await Promise.all([defaultRoute(4), defaultRoute(6), listening(), ollamaTags(), serverHealth(), egressProbe()]);
record.defaultRoute = r4; record.defaultRoute6 = r6; record.listening = l; record.ollama = o; record.server = s; record.egressProbe = p;
if (editPrompt) record.edit = await submitEdit(editPrompt);
record.verdict = verdict(record);
record.durationMs = Date.now() - startedAt;

const outDir = join(root, 'data/offline-proof');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${startedAt}.json`);
writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');

console.log('BEETLE OFFLINE PROOF (observe-and-record; nothing on the system was changed)');
console.log(`time: ${record.timestamp}   record: ${outFile}`);
console.log(`default route (IPv4): ${r4.checked ? (r4.exists ? r4.routes.map((x) => x.line).join(' | ') : 'none') : 'unknown: ' + r4.error}`);
console.log(`default route (IPv6): ${r6.checked ? (r6.exists ? r6.routes.map((x) => x.line).join(' | ') : 'none') : 'unknown: ' + r6.error}`);
console.log(`egress probe ${PROBE_URL} (${PROBE_TIMEOUT_MS} ms): ${p.succeeded ? `SUCCEEDED HTTP ${p.status}` : `failed (${p.error.code ?? p.error.name}: ${p.error.causeMessage ?? p.error.message})`} in ${p.elapsedMs} ms; dns: ${p.dns.resolved ? p.dns.addresses.join(',') : 'failed (' + (p.dns.error?.code ?? p.dns.error?.message) + ')'}`);
console.log('');
console.log('What the evidence shows:');
for (const line of record.verdict.lines) console.log(`  - ${line}`);
console.log('What it does not show:');
for (const line of record.verdict.notShown) console.log(`  - ${line}`);
console.log('');
console.log('Procedure for the manual rehearsal (not executed by this script): docs/OFFLINE_PROOF.md');

if (expectOffline && record.verdict.egressBlocked !== true) process.exit(1);
