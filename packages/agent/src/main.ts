// CLI entry: npm run agent -- [--mode openclaw|direct] [--once] [--health] [--setup-openclaw]
import { loadConfig, type AgentMode } from './config.ts';
import { createBeetleClient } from './tools.ts';
import { createOllamaClient } from './ollama.ts';
import { createDirectRunner } from './direct.ts';
import { createOpenClawRunner, checkOpenClawSetup, ensureOpenClawHome } from './openclaw.ts';
import { createAgentEventLog, startWorker } from './worker.ts';

function parseArgs(argv: string[]) {
  const out: { mode?: AgentMode; once: boolean; health: boolean; setupOpenclaw: boolean } = { once: false, health: false, setupOpenclaw: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--health') out.health = true;
    else if (a === '--setup-openclaw') out.setupOpenclaw = true;
    else if (a === '--mode') { const v = argv[++i]; if (v === 'openclaw' || v === 'direct') out.mode = v; else throw new Error('--mode must be openclaw or direct'); }
    else if (a.startsWith('--mode=')) { const v = a.slice(7); if (v === 'openclaw' || v === 'direct') out.mode = v; else throw new Error('--mode must be openclaw or direct'); }
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.health) {
    // Health does not need the agent token; tolerate a missing secrets file.
    const env = { ...process.env, BEETLE_AGENT_TOKEN: process.env.BEETLE_AGENT_TOKEN || 'health-check-no-token' };
    const config = await loadConfig({ env, mode: args.mode });
    const ollama = createOllamaClient({ baseUrl: config.ollamaBaseUrl, model: config.model });
    const client = createBeetleClient({ serverUrl: config.serverUrl, token: config.agentToken });
    const [model, server] = await Promise.all([ollama.health(), client.health()]);
    const openclaw = config.mode === 'openclaw' ? await checkOpenClawSetup(config) : null;
    const health = {
      mode: config.mode,
      model: { name: config.model, baseUrl: config.ollamaBaseUrl, reachable: model.reachable, present: model.present },
      server: { url: config.serverUrl, reachable: server.reachable, hasWorld: server.body?.hasWorld, worldVersion: server.body?.worldVersion },
      openclaw,
    };
    console.log(JSON.stringify(health, null, 2));
    process.exitCode = model.reachable && model.present && server.reachable ? 0 : 1;
    return;
  }
  const config = await loadConfig({ mode: args.mode });
  if (args.setupOpenclaw) {
    // Build the plugin, write the isolated OpenClaw home config and install the plugin; then exit.
    const result = ensureOpenClawHome(config, { build: true, log: (l) => console.log(l) });
    console.log(JSON.stringify({ ...result, ...(await checkOpenClawSetup(config)) }, null, 2));
    return;
  }
  const client = createBeetleClient({ serverUrl: config.serverUrl, token: config.agentToken });
  const eventLog = createAgentEventLog(config);
  const log = (line: string) => console.log(new Date().toISOString() + ' ' + line);
  const runner = config.mode === 'openclaw'
    ? createOpenClawRunner({ config, client, emit: (e) => eventLog.emit(e), log })
    : createDirectRunner({ config, client, emit: (e) => eventLog.emit(e), log });
  const worker = startWorker({ config, client, runner, eventLog, log, once: args.once });
  const stop = () => { log(`[${config.mode}] stopping after the current job`); worker.stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const { processed } = await worker.done;
  log(`[${config.mode}] worker stopped after ${processed} request${processed === 1 ? '' : 's'}`);
}

main().catch((err) => {
  console.error('agent failed to start: ' + (err as Error).message);
  process.exitCode = 1;
});
