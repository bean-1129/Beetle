// createBeetleServer: assembles config, secrets, the event log and the HTTP routes for main.ts and in-process tests.
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { configFromEnv, derivePublicUrl, type ServerConfig } from './config.ts';
import { createEventLog, type EventLog, type ServerContext } from './context.ts';
import { registerRoutes } from './http.ts';
import { loadSecrets, type Secrets } from './secrets.ts';

export type { ServerConfig } from './config.ts';
export type { EventLog, ServerEvent } from './context.ts';

export type BeetleServerOptions = {
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  dataDir?: string;
  publicUrl?: string | null;
  directorToken?: string;
  ollamaBaseUrl?: string;
  modelName?: string;
  webDistDir?: string | null;
  logRequests?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type BeetleServer = {
  app: FastifyInstance;
  config: ServerConfig;
  secrets: Secrets;
  events: EventLog;
  tokens: { director: string };
  start(): Promise<{ host: string; port: number; url: string; publicUrl: string }>;
  stop(): Promise<void>;
  port(): number;
  publicUrl(): string;
};

export async function createBeetleServer(opts: BeetleServerOptions = {}): Promise<BeetleServer> {
  const base = configFromEnv(opts.env ?? process.env);
  const config: ServerConfig = {
    ...base,
    host: opts.host ?? base.host,
    port: opts.port ?? base.port,
    publicUrl: opts.publicUrl === undefined ? base.publicUrl : opts.publicUrl,
    dataDir: opts.dataDir ?? base.dataDir,
    directorToken: opts.directorToken ?? base.directorToken,
    ollamaBaseUrl: opts.ollamaBaseUrl ?? base.ollamaBaseUrl,
    modelName: opts.modelName ?? base.modelName,
    webDistDir: opts.webDistDir === undefined ? base.webDistDir : opts.webDistDir,
    logRequests: opts.logRequests ?? base.logRequests,
  };

  const secrets = await loadSecrets({ dataDir: config.dataDir, directorToken: config.directorToken });
  const events = createEventLog({ filePath: path.join(config.dataDir, 'events', 'server.jsonl') });
  const ctx: ServerContext = { config, secrets, events };

  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1024 * 1024 });
  await registerRoutes(app, ctx);

  let listeningPort = config.port;
  const publicUrl = () => derivePublicUrl(config.publicUrl, listeningPort);
  let started = false;
  let stopped = false;

  return {
    app,
    config,
    secrets,
    events,
    tokens: { director: secrets.directorToken },
    async start() {
      if (started) throw new Error('server already started');
      started = true;
      await app.listen({ host: config.host, port: config.port });
      const addr = app.server.address();
      if (addr && typeof addr === 'object') listeningPort = addr.port;
      events.emit({ name: 'server.started', data: { host: config.host, port: listeningPort, model: config.modelName } });
      const local = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
      return { host: config.host, port: listeningPort, url: `http://${local}:${listeningPort}`, publicUrl: publicUrl() };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      events.emit({ name: 'server.stopped' });
      await app.close();
      await events.flush();
    },
    port: () => listeningPort,
    publicUrl,
  };
}
