// Thin Ollama /api/chat client. Loopback only, never streams, never executes model output.
import { assertLoopbackUrl } from './config.ts';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export type ChatMessage = { role: ChatRole; content: string; tool_name?: string };
export type ToolDefinition = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolCall = { name: string; arguments: Record<string, unknown> };

export type ChatRequest = {
  messages: ChatMessage[];
  /** JSON schema object (structured output) or 'json'. */
  format?: Record<string, unknown> | 'json';
  tools?: ToolDefinition[];
  temperature?: number;
  numPredict?: number;
  numCtx?: number;
  think?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
};

export type ChatResult = {
  model: string;
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  outputTokens: number;
  loadMs: number;
  totalMs: number; // as reported by Ollama
  wallMs: number; // measured here
  doneReason: string | undefined;
};

export type OllamaErrorKind = 'timeout' | 'unreachable' | 'http' | 'bad_response' | 'aborted';
export class OllamaError extends Error {
  constructor(public readonly kind: OllamaErrorKind, message: string, public readonly status?: number) {
    super(message);
    this.name = 'OllamaError';
  }
}

export type OllamaClient = {
  readonly baseUrl: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  /** GET /api/tags: { reachable, present } for the configured model. Never any other endpoint. */
  health(timeoutMs?: number): Promise<{ reachable: boolean; present: boolean; models: string[] }>;
};

export type OllamaClientOptions = {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
};

const NUM_CTX = 8192;

export function createOllamaClient(opts: OllamaClientOptions): OllamaClient {
  const baseUrl = assertLoopbackUrl(opts.baseUrl, 'OLLAMA_BASE_URL');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 90_000;

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? opts.model;
    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (req.signal) signals.push(req.signal);
    const signal = AbortSignal.any(signals);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      stream: false,
      think: req.think ?? false,
      options: { temperature: req.temperature ?? 0.2, num_ctx: req.numCtx ?? NUM_CTX, num_predict: req.numPredict ?? 1024 },
    };
    if (req.format) body.format = req.format;
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetchImpl(baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const e = err as Error & { name?: string; cause?: unknown };
      if (e.name === 'TimeoutError' || signals[0].aborted) throw new OllamaError('timeout', `model call timed out after ${timeoutMs} ms`);
      if (e.name === 'AbortError') throw new OllamaError('aborted', 'model call aborted');
      throw new OllamaError('unreachable', `Ollama unreachable at ${baseUrl}: ${e.message}`);
    }
    const wallMs = Math.round(performance.now() - t0);
    let json: Record<string, unknown>;
    let text = '';
    try {
      text = await res.text();
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new OllamaError(res.ok ? 'bad_response' : 'http', `Ollama returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) {
      throw new OllamaError('http', `Ollama HTTP ${res.status}: ${String((json as { error?: unknown }).error ?? text.slice(0, 200))}`, res.status);
    }
    const message = (json.message ?? {}) as { content?: unknown; tool_calls?: unknown };
    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
    const toolCalls: ToolCall[] = [];
    for (const c of rawCalls) {
      const fn = (c as { function?: { name?: unknown; arguments?: unknown } }).function;
      if (!fn || typeof fn.name !== 'string') continue;
      let args: Record<string, unknown> = {};
      if (fn.arguments && typeof fn.arguments === 'object') args = fn.arguments as Record<string, unknown>;
      else if (typeof fn.arguments === 'string') { try { args = JSON.parse(fn.arguments) as Record<string, unknown>; } catch { args = {}; } }
      toolCalls.push({ name: fn.name, arguments: args });
    }
    return {
      model,
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      promptTokens: num(json.prompt_eval_count),
      outputTokens: num(json.eval_count),
      loadMs: Math.round(num(json.load_duration) / 1e6),
      totalMs: Math.round(num(json.total_duration) / 1e6),
      wallMs,
      doneReason: typeof json.done_reason === 'string' ? json.done_reason : undefined,
    };
  }

  async function health(timeoutMs = 1500) {
    try {
      const res = await fetchImpl(baseUrl + '/api/tags', { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { reachable: false, present: false, models: [] };
      const json = (await res.json()) as { models?: { name?: string }[] };
      const models = (json.models ?? []).map((m) => m.name ?? '').filter(Boolean);
      return { reachable: true, present: models.includes(opts.model), models };
    } catch {
      return { reachable: false, present: false, models: [] };
    }
  }

  return { baseUrl, model: opts.model, chat, health };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Parse model text as JSON. Tolerates a leading/trailing code fence. Never evaluates anything.
 * Returns { ok: false, error } for malformed or truncated output.
 */
export function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  if (!s) return { ok: false, error: 'empty output' };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    const msg = (err as Error).message;
    const truncated = /Unexpected end of JSON input|Unterminated string|end of data/i.test(msg) || ((s.startsWith('{') || s.startsWith('[')) && unbalancedDepth(s) > 0);
    return { ok: false, error: truncated ? `truncated JSON (${msg})` : `malformed JSON (${msg})` };
  }
}

/** Bracket depth left open at the end of the text (ignoring brackets inside strings). Positive means cut off. */
function unbalancedDepth(s: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return inString ? Math.max(depth, 1) : depth;
}
