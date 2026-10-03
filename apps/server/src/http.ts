// Fastify routes: health, same-machine director bootstrap, 2D studio (director token) and the static web client.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerToken, isLoopbackUrl, isSameMachine, safeEqual } from './auth.ts';
import { redactUrl, type ServerContext } from './context.ts';
import { registerStudio2d } from './studio2d.ts';

export const ROUTES = {
  health: '/api/health',
  directorBootstrap: '/api/director/bootstrap',
} as const;

export type ModelStatus = { name: string; reachable: boolean; present: boolean };

const MODEL_CACHE_MS = 5000;
const MODEL_TIMEOUT_MS = 1500;

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Model reachability: GET /api/tags only, loopback endpoints only, cached for 5 s. */
function createModelStatus(ctx: ServerContext): () => Promise<ModelStatus> {
  let cache: { at: number; value: ModelStatus } | null = null;
  return async () => {
    const now = Date.now();
    if (cache && now - cache.at < MODEL_CACHE_MS) return cache.value;
    const { modelName, ollamaBaseUrl } = ctx.config;
    const value: ModelStatus = { name: modelName, reachable: false, present: false };
    if (isLoopbackUrl(ollamaBaseUrl)) {
      try {
        const res = await fetch(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
        if (res.ok) {
          value.reachable = true;
          const body = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
          const models = Array.isArray(body?.models) ? body.models : [];
          value.present = models.some((m) => m?.name === modelName || m?.model === modelName);
        }
      } catch {
        value.reachable = false;
      }
    }
    cache = { at: now, value };
    return value;
  };
}

export async function registerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  // Lenient JSON: an empty body on a JSON POST means {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('body is not valid JSON') as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      ctx.events.emit({ name: 'http.error', outcome: 'fail', data: { method: req.method, url: redactUrl(req.url), message: err.message } });
    }
    void reply.code(status).send({ ok: false, error: status >= 500 ? 'internal error' : err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ ok: false, error: `no route for ${req.method} ${redactUrl(req.url)}` });
  });

  if (ctx.config.logRequests) {
    app.addHook('onResponse', (req, reply, done) => {
      if (!req.url.startsWith(ROUTES.health)) {
        console.log(`[beetle] ${req.method} ${redactUrl(req.url)} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
      }
      done();
    });
  }

  function requireDirector(req: FastifyRequest, reply: FastifyReply): boolean {
    const token = bearerToken(req.headers as Record<string, unknown>);
    if (!token) {
      void reply.code(401).send({ ok: false, error: 'director token required' });
      return false;
    }
    if (!safeEqual(token, ctx.secrets.directorToken)) {
      void reply.code(403).send({ ok: false, error: 'this token cannot use director routes' });
      return false;
    }
    return true;
  }

  const modelStatus = createModelStatus(ctx);
  app.get(ROUTES.health, async () => ({ ok: true, model: await modelStatus() }));

  // Same-machine bootstrap: pages opened on this machine get the director token without a ?token= link.
  // Other LAN devices are refused and still need the token link.
  app.get(ROUTES.directorBootstrap, async (req, reply) => {
    if (!isSameMachine(req.socket.remoteAddress)) {
      return reply.code(403).send({ ok: false, error: 'Open the token link on this device, or use this machine.' });
    }
    reply.header('cache-control', 'no-store');
    return { token: ctx.secrets.directorToken };
  });

  registerStudio2d(app, ctx, { requireDirector });

  await registerStatic(app, ctx);
}

async function registerStatic(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const dir = ctx.config.webDistDir;
  if (dir && (await directoryExists(dir))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, {
      root: path.resolve(dir),
      prefix: '/',
      index: false,
      wildcard: true,
      cacheControl: false,
      setHeaders(res, filePath) {
        const rel = path.relative(path.resolve(dir), filePath).split(path.sep).join('/');
        res.setHeader('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    const studio = (_req: FastifyRequest, reply: FastifyReply) => reply.sendFile('studio2d.html');
    app.get('/', studio);
    app.get('/2d', studio);
    return;
  }
  app.get('/', async (_req, reply) => {
    void reply.type('text/plain; charset=utf-8');
    return 'Beetle server is running. The web client is not built yet (apps/web/dist missing). API: /api/health';
  });
}
