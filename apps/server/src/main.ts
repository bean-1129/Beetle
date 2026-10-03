// Entry point: loads .env (tiny parser, no dotenv package), starts the Beetle 2D server and prints its URL.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, parseDotEnv } from './config.ts';
import { createBeetleServer } from './index.ts';

async function loadDotEnv(): Promise<void> {
  let text: string;
  try {
    text = await readFile(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  await loadDotEnv();
  const server = await createBeetleServer();
  const info = await server.start();
  console.log(`[beetle] listening on ${server.config.host}:${info.port}; model ${server.config.modelName}`);
  console.log(`[beetle] open ${info.url}/ (pages on this machine fetch the token automatically)`);
  // The token link is printed only when the token was just generated, so logs and recordings do not keep a long-lived secret.
  if (server.secrets.source === 'generated') {
    console.log(`[beetle] other devices: ${info.publicUrl}/?token=${server.tokens.director}`);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[beetle] ${signal} received, stopping`);
    server.stop().then(() => process.exit(0), (err) => {
      console.error('[beetle] stop failed', err instanceof Error ? err.message : err);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[beetle] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
