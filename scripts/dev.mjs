#!/usr/bin/env node
// Starts the Beetle 2D server and, in dev mode, the Vite dev server, with prefixed logs.
//   node scripts/dev.mjs          server + Vite dev server (hot reload on http://127.0.0.1:5173)
//   node scripts/dev.mjs --prod   server only, serving the built app from apps/web/dist
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.slice(2).includes('--prod');

const env = {
  ...process.env,
  PATH: `${join(root, '.tools/node/bin')}:${process.env.PATH ?? ''}`,
};

const colors = { server: '\x1b[36m', web: '\x1b[33m' };
const procs = [];
let stopping = false;

function run(name, cmd, cmdArgs, cwd = root) {
  const p = spawn(cmd, cmdArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${colors[name] ?? ''}[${name}]\x1b[0m`;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        process.stdout.write(`${tag} ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code, signal) => {
    process.stdout.write(`${tag} exited (${code ?? signal})\n`);
    if (!stopping) stop(code ?? 1);
  });
  procs.push(p);
  return p;
}

function stop(code = 0) {
  stopping = true;
  for (const p of procs) if (p.exitCode === null && !p.killed) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

if (prod && !existsSync(join(root, 'apps/web/dist/studio2d.html'))) {
  console.error('apps/web/dist/studio2d.html is missing. Run: npm run build');
  process.exit(1);
}

run('server', 'npx', ['tsx', 'apps/server/src/main.ts']);
if (!prod) run('web', 'npx', ['vite'], join(root, 'apps/web'));

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
