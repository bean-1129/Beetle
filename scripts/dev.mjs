#!/usr/bin/env node
// Starts the Beetle server, the agent worker and (in dev mode) the Vite dev server with prefixed logs.
// Usage: node scripts/dev.mjs [--prod] [--no-agent] [--agent-mode openclaw|direct]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const prod = args.includes('--prod');
const noAgent = args.includes('--no-agent');
const agentModeIdx = args.indexOf('--agent-mode');
const agentMode = agentModeIdx >= 0 ? args[agentModeIdx + 1] : process.env.BEETLE_AGENT_MODE || 'openclaw';

const env = {
  ...process.env,
  PATH: `${join(root, '.tools/node/bin')}:${join(root, '.tools/npm-global/bin')}:${process.env.PATH ?? ''}`,
  BEETLE_AGENT_MODE: agentMode,
};

const colors = { server: '\x1b[36m', agent: '\x1b[35m', web: '\x1b[33m' };
const procs = [];

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
  p.on('exit', (code, signal) => process.stdout.write(`${tag} exited (${code ?? signal})\n`));
  procs.push(p);
  return p;
}

if (prod && !existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist is missing. Run: npm run build');
  process.exit(1);
}

run('server', 'npx', ['tsx', 'apps/server/src/main.ts']);
if (!noAgent) {
  // Give the server a moment to write data/secrets.json before the agent reads it.
  setTimeout(() => run('agent', 'npx', ['tsx', 'packages/agent/src/main.ts', '--mode', agentMode]), 2500);
}
if (!prod) run('web', 'npx', ['vite'], join(root, 'apps/web'));

const stop = () => {
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
