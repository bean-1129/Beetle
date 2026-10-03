// 2D studio routes: local-model JSON calls through the configured loopback Ollama endpoint.
// GET /api/2d/status (public), POST /api/2d/warm | /api/2d/llm | /api/2d/cancel (director token).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isLoopbackUrl } from './auth.ts';
import type { ServerContext } from './context.ts';

export const STUDIO2D_ROUTES = {
  status: '/api/2d/status',
  warm: '/api/2d/warm',
  llm: '/api/2d/llm',
  cancel: '/api/2d/cancel',
} as const;

export const STUDIO2D_LIMITS = {
  maxConcurrent: 2,
  timeoutMs: 120_000,
  statusTimeoutMs: 1500,
  defaultNumCtx: 8192,
} as const;

export const LlmBodySchema = z.object({
  id: z.string().min(1).max(64).optional(),
  system: z.string().max(20_000),
  prompt: z.string().max(20_000),
  schema: z.record(z.unknown()).optional(),
  temperature: z.number().min(0).max(1.5).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
  numCtx: z.number().int().min(0).max(32_768).optional(),
}).strict();

export const CancelBodySchema = z.object({ id: z.string().min(1).max(64) }).strict();
const WarmBodySchema = z.object({}).strict();

/** Tolerant JSON parse for model replies: strips code fences, falls back to the outermost {...}. */
export function parseModelJson(text: string): unknown {
  if (typeof text !== 'string') return undefined;
  let s = text.trim();
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type Guards = {
  requireDirector(req: FastifyRequest, reply: FastifyReply): boolean;
};

function fail(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ ok: false, error });
}

export function registerStudio2d(app: FastifyInstance, ctx: ServerContext, guards: Guards): void {
  const inflight = new Map<string, AbortController>();
  let active = 0;
  let seq = 0;

  const baseUrl = () => ctx.config.ollamaBaseUrl.replace(/\/+$/, '');
  const modelName = () => ctx.config.modelName;
  const loopbackOnly = () => isLoopbackUrl(ctx.config.ollamaBaseUrl);

  app.get(STUDIO2D_ROUTES.status, async () => {
    const out = { online: false, models: [] as string[], image: false as const };
    if (!loopbackOnly()) return out;
    try {
      const res = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(STUDIO2D_LIMITS.statusTimeoutMs) });
      if (res.ok) {
        out.online = true;
        const body = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
        const list = Array.isArray(body?.models) ? body.models : [];
        out.models = list
          .map((m) => (typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : ''))
          .filter((n) => n !== '')
          .slice(0, 200);
      }
    } catch {
      out.online = false;
    }
    return out;
  });

  app.post(STUDIO2D_ROUTES.warm, async (req, reply) => {
    if (!guards.requireDirector(req, reply)) return reply;
    const parsed = WarmBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(reply, 400, 'body must be an empty object');
    const model = modelName();
    if (!loopbackOnly()) return { ok: false, model, error: 'model endpoint must be a loopback address' };
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl()}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '1h' }),
        signal: AbortSignal.timeout(STUDIO2D_LIMITS.timeoutMs),
      });
      await res.text().catch(() => '');
      ctx.events.emit({ name: 'studio2d.warm', model, outcome: res.ok ? 'ok' : 'fail', durationMs: Date.now() - started, data: { ok: res.ok, status: res.status } });
      return res.ok ? { ok: true, model } : { ok: false, model, error: `model endpoint returned ${res.status}` };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      ctx.events.emit({ name: 'studio2d.warm', model, outcome: 'fail', durationMs: Date.now() - started, data: { ok: false } });
      return { ok: false, model, error: `model endpoint unreachable: ${error}`.slice(0, 300) };
    }
  });

  app.post(STUDIO2D_ROUTES.cancel, async (req, reply) => {
    if (!guards.requireDirector(req, reply)) return reply;
    const parsed = CancelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const controller = inflight.get(parsed.data.id);
    if (controller) controller.abort(new Error('cancelled'));
    return { ok: true, cancelled: Boolean(controller) };
  });

  app.post(STUDIO2D_ROUTES.llm, async (req, reply) => {
    if (!guards.requireDirector(req, reply)) return reply;
    const parsed = LlmBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(reply, 400, parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const body = parsed.data;
    const model = modelName();
    if (!loopbackOnly()) return { ok: false, error: 'model endpoint must be a loopback address' };
    if (body.id && inflight.has(body.id)) return fail(reply, 409, `a call with id ${body.id} is already running`);
    if (active >= STUDIO2D_LIMITS.maxConcurrent) return fail(reply, 429, `too many model calls in flight (max ${STUDIO2D_LIMITS.maxConcurrent})`);

    const id = body.id ?? `studio2d-${++seq}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, STUDIO2D_LIMITS.timeoutMs);
    inflight.set(id, controller);
    active += 1;
    const started = Date.now();
    let result: { ok: true; json: unknown; model: string; ms: number } | { ok: false; error: string };
    let outcome: 'ok' | 'fail' | 'cancelled' = 'fail';
    try {
      const res = await fetch(`${baseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format: body.schema ?? 'json',
          messages: [
            { role: 'system', content: body.system },
            { role: 'user', content: body.prompt },
          ],
          options: {
            temperature: body.temperature,
            num_predict: body.maxTokens,
            num_ctx: body.numCtx || STUDIO2D_LIMITS.defaultNumCtx,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        await res.text().catch(() => '');
        result = { ok: false, error: `model endpoint returned ${res.status}` };
      } else {
        const data = (await res.json()) as { message?: { content?: unknown } };
        const content = typeof data?.message?.content === 'string' ? data.message.content : '';
        const json = parseModelJson(content);
        if (json === undefined) {
          result = { ok: false, error: 'model reply was not valid JSON' };
        } else {
          outcome = 'ok';
          result = { ok: true, json, model, ms: Date.now() - started };
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        outcome = timedOut ? 'fail' : 'cancelled';
        result = { ok: false, error: timedOut ? `model call timed out after ${STUDIO2D_LIMITS.timeoutMs / 1000}s` : 'cancelled' };
      } else {
        const message = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: `model endpoint unreachable: ${message}`.slice(0, 300) };
      }
    } finally {
      clearTimeout(timer);
      if (inflight.get(id) === controller) inflight.delete(id);
      active -= 1;
    }
    const durationMs = Date.now() - started;
    // Never log prompt or reply text.
    ctx.events.emit({ name: 'studio2d.llm', model, outcome, durationMs, data: { ok: result.ok, model, durationMs } });
    return result;
  });
}
