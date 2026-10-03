// Director token: from env/options, otherwise read or created in data/secrets.json (mode 0600).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import path from 'node:path';

export type Secrets = {
  directorToken: string;
  /** 'provided' (env/options), 'file' (read from data/secrets.json) or 'generated' (just created there). */
  source: 'provided' | 'file' | 'generated';
  /** Path of data/secrets.json when a file was read or written, otherwise null. */
  filePath: string | null;
};

const HEX32 = /^[0-9a-f]{32}$/;

export function newToken(): string {
  return randomBytes(16).toString('hex');
}

function isUsableToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function loadSecrets(opts: { dataDir: string; directorToken?: string | null }): Promise<Secrets> {
  if (isUsableToken(opts.directorToken)) {
    return { directorToken: opts.directorToken, source: 'provided', filePath: null };
  }

  const filePath = path.join(opts.dataDir, 'secrets.json');
  let fromFile: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fromFile = parsed as Record<string, unknown>;
  } catch {
    fromFile = {};
  }

  const existing = typeof fromFile.directorToken === 'string' && HEX32.test(fromFile.directorToken) ? fromFile.directorToken : null;
  if (existing) return { directorToken: existing, source: 'file', filePath };

  const directorToken = newToken();
  await mkdir(opts.dataDir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify({ directorToken }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, filePath);
  return { directorToken, source: 'generated', filePath };
}
