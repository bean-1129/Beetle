// Standalone fake Beetle server for the OpenClaw smoke test. Never the real server.
// Usage: BEETLE_FAKE_PORT=7711 BEETLE_FAKE_TOKEN=<hex> BEETLE_FAKE_LOG=<file> npx tsx packages/agent/test-support/run-fake-server.ts
import { writeFileSync } from 'node:fs';
import { startFakeBeetleServer } from './fake-beetle-server.ts';

const port = Number(process.env.BEETLE_FAKE_PORT ?? 7711);
const token = process.env.BEETLE_FAKE_TOKEN;
if (!token || token.length < 16) { console.error('BEETLE_FAKE_TOKEN (16+ chars) is required'); process.exit(1); }
const logFile = process.env.BEETLE_FAKE_LOG;
const stateFile = process.env.BEETLE_FAKE_STATE;

const server = await startFakeBeetleServer({ port, token, logFile, verbose: true, claimLongPollMs: 2000 });
console.log(`[fake-beetle] listening on ${server.url} (fixture world v${server.state.version}); log ${logFile ?? 'stdout only'}`);

const kind = (process.env.BEETLE_FAKE_REQUEST_KIND ?? 'edit') as 'edit' | 'brief';
const prompt = process.env.BEETLE_FAKE_REQUEST_PROMPT ?? 'Turn the water into lava and add a bridge from the orchard island to the temple island.';
if (process.env.BEETLE_FAKE_ENQUEUE !== '0') {
  const req = server.enqueue({ kind, prompt, id: process.env.BEETLE_FAKE_REQUEST_ID });
  console.log(`[fake-beetle] queued request ${req.id} (${req.kind}): ${req.prompt}`);
}

function dumpState() {
  if (!stateFile) return;
  const snapshot = {
    version: server.state.version,
    hazard: server.state.spec?.hazard.kind,
    bridges: server.state.spec?.bridges.map((b) => b.id),
    requests: [...server.state.requests.values()],
    statuses: server.state.statuses,
    finishes: server.state.finishes,
    reports: server.state.reports,
    commits: server.state.commits,
    calls: server.requests.map((r) => ({ seq: r.seq, method: r.method, path: r.path, tokenOk: r.tokenOk, status: r.status })),
  };
  writeFileSync(stateFile, JSON.stringify(snapshot, null, 2));
}
const timer = setInterval(dumpState, 1000);
const stop = async () => { clearInterval(timer); dumpState(); await server.close(); console.log('[fake-beetle] stopped'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
