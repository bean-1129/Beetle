// Entry point: loads .env (tiny parser, no dotenv package), starts the Beetle server, prints the director URL.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, parseDotEnv } from './config.ts';
import { createBeetleServer } from './index.ts';

async function loadDotEnv(): Promise<void> {
  const file = path.join(REPO_ROOT, '.env');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
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
  for (const note of server.startupNotes()) console.log(`[beetle] ${note}`);
  const secretsPath = server.secrets.filePath;
  const relative = secretsPath ? path.relative(REPO_ROOT, secretsPath) : '';
  const secretsNote = secretsPath
    ? `agent token: ${relative && !relative.startsWith('..') ? relative : secretsPath}`
    : 'agent token: from environment';
  console.log(`[beetle] listening on ${server.config.host}:${info.port} (${info.url}); ${secretsNote}`);
  // The director URL carries the token: print it only when the token was just generated into the secrets file,
  // or when explicitly asked, so screen recordings and redirected logs do not capture a long-lived secret.
  if (server.secrets.sources.director === 'file' || process.env.BEETLE_PRINT_DIRECTOR_URL === '1') {
    console.log(`[beetle] director: ${info.publicUrl}/director?token=${server.tokens.director}`);
  } else {
    console.log(`[beetle] director: ${info.publicUrl}/director?token=<BEETLE_DIRECTOR_TOKEN from environment>`);
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
