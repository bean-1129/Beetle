#!/usr/bin/env node
// Demo export: copies the submission evidence into submission/<yyyy-mm-dd-hhmm>/.
// Read-only with respect to the repository; writes only inside submission/.
// Pure Node 24 built-ins. Usage: node scripts/export-demo.mjs [--out <dir>]
//
// Never copied: .env, data/secrets.json, .tools, node_modules, .git, .openclaw-home,
// and any file whose name matches /token|secret/i.
// Inside copied .json and .jsonl files every value whose key matches /token|secret|invite/i
// is replaced with "[redacted]".
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, basename, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;

const NAME_DENY = /token|secret/i; // applies to every file or directory name
const KEY_REDACT = /token|secret|invite/i; // applies to JSON keys inside copied files
const DIR_DENY = new Set(['.tools', 'node_modules', '.git', '.openclaw-home', 'submission', 'dist']);
const FILE_DENY = new Set(['.env']);
const DENY_PATHS = new Set(['data/secrets.json']);

const DATA_DIRS = ['data/snapshots', 'data/reports', 'data/events', 'data/benchmarks', 'data/prompt-runs', 'data/offline-proof'];
const DOC_DIRS = ['docs'];
const ROOT_FILES = ['BUILD_STATUS.md', 'THIRD_PARTY.md', 'README.md', 'package.json', 'package-lock.json', '.env.example'];

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const outDir = outArg ? join(root, outArg) : join(root, 'submission', stamp());
mkdirSync(outDir, { recursive: true });

const NPM_MANIFEST = new Set(['package.json', 'package-lock.json']);
const manifest = [];
const skipped = [];
const missing = [];
const warnings = [];
let redactions = 0;
let bytes = 0;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Under a key matching KEY_REDACT every string value becomes "[redacted]" (also inside nested objects and arrays).
// Numbers, booleans and null are kept: a credential is a string, while counters such as promptTokens are evidence.
function redactValue(node, underSecretKey = false) {
  if (Array.isArray(node)) return node.map((v) => redactValue(v, underSecretKey));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = redactValue(v, underSecretKey || KEY_REDACT.test(k));
    return out;
  }
  if (underSecretKey && typeof node === 'string') { redactions++; return '[redacted]'; }
  return node;
}

// Fallback for text that does not parse as JSON: redact "key": "value" pairs by regex.
function redactText(text) {
  return text.replace(/"([^"\\]*(?:token|secret|invite)[^"\\]*)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]\s]+)/gi, (_m, key) => {
    redactions++;
    return `"${key}": "[redacted]"`;
  });
}

function redactJsonBuffer(buf, ext) {
  const text = buf.toString('utf8');
  if (ext === '.jsonl') {
    const lines = text.split('\n').map((line) => {
      if (!line.trim()) return line;
      try { return JSON.stringify(redactValue(JSON.parse(line))); } catch { return redactText(line); }
    });
    return Buffer.from(lines.join('\n'), 'utf8');
  }
  try {
    return Buffer.from(JSON.stringify(redactValue(JSON.parse(text)), null, 2) + '\n', 'utf8');
  } catch {
    return Buffer.from(redactText(text), 'utf8');
  }
}

function isDenied(relPath) {
  const parts = relPath.split(sep);
  if (DENY_PATHS.has(parts.join('/'))) return 'denied path';
  for (const part of parts) {
    if (DIR_DENY.has(part) || FILE_DENY.has(part)) return `denied name ${part}`;
    if (NAME_DENY.test(part)) return `name matches /token|secret/i (${part})`;
  }
  return null;
}

function record(destRel, buf, extra = {}) {
  const dest = join(outDir, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  bytes += buf.length;
  manifest.push({ path: destRel.split(sep).join('/'), size: buf.length, sha256: sha256(buf), ...extra });
}

function copyFile(srcAbs, destRel) {
  const rel = relative(root, srcAbs);
  const why = isDenied(rel);
  if (why) { skipped.push({ path: rel, reason: why }); return; }
  const st = lstatSync(srcAbs);
  if (st.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symbolic link' }); return; }
  if (!st.isFile()) return;
  const raw = readFileSync(srcAbs);
  const lower = basename(srcAbs).toLowerCase();
  const ext = lower.endsWith('.jsonl') ? '.jsonl' : lower.endsWith('.json') ? '.json' : null;
  // npm manifests are committed source whose keys are dependency names (for example "js-tokens");
  // key-based redaction would corrupt the lockfile, so they are copied byte for byte and checked for secrets instead.
  if (ext === '.json' && NPM_MANIFEST.has(lower)) {
    const hits = raw.toString('utf8').match(/\b[0-9a-f]{32,}\b/g) ?? [];
    const sourceSha = sha256(raw);
    record(destRel, raw, { source: rel.split(sep).join('/'), redaction: 'exempt-npm-manifest', identicalToSource: true, sourceSha256: sourceSha, hexStringsLongerThan32: hits.length });
    if (hits.length) warnings.push(`${rel}: contains ${hits.length} hex strings of 32+ chars (npm integrity hashes are base64; inspect before sharing)`);
    return;
  }
  const before = redactions;
  const buf = ext ? redactJsonBuffer(raw, ext) : raw;
  record(destRel, buf, { source: rel.split(sep).join('/'), redactedValues: redactions - before });
}

function copyTree(srcRel, destRel) {
  const srcAbs = join(root, srcRel);
  if (!existsSync(srcAbs)) { missing.push(srcRel); return; }
  const why = isDenied(srcRel);
  if (why) { skipped.push({ path: srcRel, reason: why }); return; }
  const walk = (dirAbs, outRel) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const childAbs = join(dirAbs, entry.name);
      const childRel = relative(root, childAbs);
      if (entry.isDirectory()) {
        const d = isDenied(childRel);
        if (d) { skipped.push({ path: childRel, reason: d }); continue; }
        walk(childAbs, join(outRel, entry.name));
      } else {
        copyFile(childAbs, join(outRel, entry.name));
      }
    }
  };
  if (statSync(srcAbs).isDirectory()) walk(srcAbs, destRel);
  else copyFile(srcAbs, destRel);
}

// 1. data directories (whatever exists), kept under data/ in the export
for (const d of DATA_DIRS) copyTree(d, d);
// 2. docs
for (const d of DOC_DIRS) copyTree(d, d);
// 3. root files
for (const f of ROOT_FILES) copyTree(f, f);
// 4. workspace package.json files (lockfile is at the root for npm workspaces)
for (const ws of ['apps/server', 'apps/web', 'packages/contracts', 'packages/world', 'packages/observability', 'packages/agent']) {
  copyTree(join(ws, 'package.json'), join(ws, 'package.json'));
  copyTree(join(ws, 'SMOKE.md'), join(ws, 'SMOKE.md'));
}

// 5. git log, one line per commit
{
  const git = spawnSync('git', ['log', '--format=%h %ad %s', '--date=iso-strict'], { cwd: root, encoding: 'utf8' });
  const text = git.status === 0 ? git.stdout : `git log unavailable (exit ${git.status}): ${(git.stderr || git.error?.message || '').trim()}\n`;
  record('git-log.txt', Buffer.from(text, 'utf8'), { generated: true });
  const status = spawnSync('git', ['status', '--short', '--branch'], { cwd: root, encoding: 'utf8' });
  record('git-status.txt', Buffer.from(status.status === 0 ? status.stdout : 'git status unavailable\n', 'utf8'), { generated: true });
}

// 6. demo-check output (failures allowed)
let demoCheckExit = null;
{
  const r = spawnSync(process.execPath, [join(root, 'scripts/demo-check.mjs')], { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env } });
  demoCheckExit = r.status;
  const text = `$ node scripts/demo-check.mjs\n# exit code: ${r.status ?? `signal ${r.signal}`}\n# run at: ${new Date().toISOString()}\n\n${r.stdout ?? ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
  record('demo-check.txt', Buffer.from(text, 'utf8'), { generated: true, exitCode: r.status });
}

// 7. manifest
manifest.sort((a, b) => a.path.localeCompare(b.path));
const summary = {
  createdAt: new Date().toISOString(),
  outputDir: relative(root, outDir),
  node: process.versions.node,
  files: manifest.length,
  bytes,
  redactedValues: redactions,
  demoCheckExitCode: demoCheckExit,
  missingSources: missing,
  skipped,
  warnings,
  rules: {
    neverCopied: ['.env', 'data/secrets.json', '.tools', 'node_modules', '.git', '.openclaw-home', 'file or directory names matching /token|secret/i'],
    redactedKeys: 'string values under keys matching /token|secret|invite/i inside copied .json and .jsonl files (nested strings included; numbers and booleans kept)',
    exempt: 'package.json and package-lock.json are copied unchanged (dependency names are keys); their sha256 equals the committed source',
  },
};
writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify({ ...summary, entries: manifest }, null, 2) + '\n');

console.log(`Export folder: ${outDir}`);
console.log(`Files: ${manifest.length} (${(bytes / 1024).toFixed(1)} KiB), redacted values: ${redactions}, demo-check exit: ${demoCheckExit}`);
if (missing.length) console.log(`Not present (skipped): ${missing.join(', ')}`);
if (skipped.length) console.log(`Excluded: ${skipped.map((s) => `${s.path} [${s.reason}]`).join('; ')}`);
if (warnings.length) console.log(`Warnings: ${warnings.join('; ')}`);
console.log('Manifest: MANIFEST.json (path, size, sha256 for every file in the folder)');
