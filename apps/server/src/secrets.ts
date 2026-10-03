// Director and agent tokens: from env/options, otherwise read or created in data/secrets.json (mode 0600).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import path from 'node:path';

export type Secrets = {
  directorToken: string;
  agentToken: string;
  /** Where each token came from. */
  sources: { director: 'provided' | 'file'; agent: 'provided' | 'file' };
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

export async function loadSecrets(opts: { dataDir: string; directorToken?: string | null; agentToken?: string | null }): Promise<Secrets> {
  const provided = {
    director: isUsableToken(opts.directorToken) ? opts.directorToken : null,
    agent: isUsableToken(opts.agentToken) ? opts.agentToken : null,
  };
  if (provided.director && provided.agent) {
    return {
      directorToken: provided.director,
      agentToken: provided.agent,
      sources: { director: 'provided', agent: 'provided' },
      filePath: null,
    };
  }

  const filePath = path.join(opts.dataDir, 'secrets.json');
  let fromFile: { directorToken?: unknown; agentToken?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object') fromFile = parsed as { directorToken?: unknown; agentToken?: unknown };
  } catch {
    fromFile = {};
  }

  let changed = false;
  let fileDirector = typeof fromFile.directorToken === 'string' && HEX32.test(fromFile.directorToken) ? fromFile.directorToken : null;
  let fileAgent = typeof fromFile.agentToken === 'string' && HEX32.test(fromFile.agentToken) ? fromFile.agentToken : null;
  if (!fileDirector) { fileDirector = newToken(); changed = true; }
  if (!fileAgent) { fileAgent = newToken(); changed = true; }

  if (changed) {
    await mkdir(opts.dataDir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify({ directorToken: fileDirector, agentToken: fileAgent }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, filePath);
  }

  return {
    directorToken: provided.director ?? fileDirector,
    agentToken: provided.agent ?? fileAgent,
    sources: { director: provided.director ? 'provided' : 'file', agent: provided.agent ? 'provided' : 'file' },
    filePath,
  };
}
