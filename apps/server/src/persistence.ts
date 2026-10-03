// Atomic JSON persistence: snapshots, session state and build reports under the data dir.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorldSpecSchema, type BuildReport, type SessionState, type WorldSpec } from '@beetle/contracts';

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

export async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export type WorldSnapshotFile = { version: number; savedAt: number; spec: WorldSpec };

export type Persistence = {
  readonly dataDir: string;
  readonly snapshotsDir: string;
  readonly reportsDir: string;
  readonly eventsFile: string;
  readonly secretsFile: string;
  writeWorldSnapshot(version: number, spec: WorldSpec, savedAt: number): Promise<void>;
  writeSession(session: SessionState): Promise<void>;
  writeReport(report: BuildReport): Promise<void>;
  loadCurrentWorld(): Promise<WorldSnapshotFile | null>;
  /** data/snapshots/session.json when present and well-formed, else null (corruption is reported through onError). */
  loadSession(): Promise<SessionState | null>;
  /** Waits for every queued write to settle. */
  flush(): Promise<void>;
};

export function createPersistence(dataDir: string, onError: (where: string, err: unknown) => void = () => undefined): Persistence {
  const snapshotsDir = path.join(dataDir, 'snapshots');
  const reportsDir = path.join(dataDir, 'reports');
  // Writes to the same path are serialized so a slow write never races a later rename.
  const queues = new Map<string, Promise<void>>();
  let pending: Promise<void>[] = [];

  function enqueue(filePath: string, value: unknown): Promise<void> {
    const prev = queues.get(filePath) ?? Promise.resolve();
    const next = prev
      .then(() => atomicWriteJson(filePath, value))
      .catch((err) => onError(filePath, err));
    queues.set(filePath, next);
    pending.push(next);
    if (pending.length > 64) pending = pending.slice(-32);
    return next;
  }

  return {
    dataDir,
    snapshotsDir,
    reportsDir,
    eventsFile: path.join(dataDir, 'events', 'server.jsonl'),
    secretsFile: path.join(dataDir, 'secrets.json'),
    async writeWorldSnapshot(version, spec, savedAt) {
      const file: WorldSnapshotFile = { version, savedAt, spec };
      await Promise.all([
        enqueue(path.join(snapshotsDir, `world-v${version}.json`), file),
        enqueue(path.join(snapshotsDir, 'world-current.json'), file),
      ]);
    },
    writeSession(session) {
      return enqueue(path.join(snapshotsDir, 'session.json'), session);
    },
    writeReport(report) {
      const safeId = report.reportId.replace(/[^A-Za-z0-9_-]/g, '_');
      return enqueue(path.join(reportsDir, `${safeId}.json`), report);
    },
    async loadCurrentWorld() {
      const file = path.join(snapshotsDir, 'world-current.json');
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') onError(file, err);
        return null;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch (err) {
        onError(file, new Error(`world-current.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); starting from the default world`));
        return null;
      }
      if (!raw || typeof raw !== 'object') {
        onError(file, new Error('world-current.json is not an object; starting from the default world'));
        return null;
      }
      const obj = raw as { version?: unknown; savedAt?: unknown; spec?: unknown };
      const parsed = WorldSpecSchema.safeParse(obj.spec);
      if (!parsed.success) {
        onError(file, new Error('world-current.json spec does not match WorldSpecSchema: ' + parsed.error.issues.slice(0, 3).map((i) => i.path.join('.') + ' ' + i.message).join('; ')));
        return null;
      }
      const version = typeof obj.version === 'number' && Number.isInteger(obj.version) && obj.version >= 0 ? obj.version : parsed.data.worldVersion;
      return { version, savedAt: typeof obj.savedAt === 'number' ? obj.savedAt : 0, spec: { ...parsed.data, worldVersion: version } };
    },
    async loadSession() {
      const file = path.join(snapshotsDir, 'session.json');
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') onError(file, err);
        return null;
      }
      try {
        const raw = JSON.parse(text) as unknown;
        if (!raw || typeof raw !== 'object') throw new Error('session.json is not an object');
        const s = raw as Partial<SessionState>;
        if (typeof s.worldId !== 'string' || !Array.isArray(s.collectedRelicIds) || !Array.isArray(s.players)) throw new Error('session.json is missing required fields');
        return s as SessionState;
      } catch (err) {
        onError(file, err);
        return null;
      }
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}
