// Fake Ollama HTTP server for unit tests: scripted /api/chat replies, /api/tags, hang or refuse on demand.
import { createServer, type Server } from 'node:http';

export type FakeOllamaRequest = { at: number; method: string; path: string; body: Record<string, unknown> };
export type FakeOllamaReply = { status?: number; json?: unknown; delayMs?: number; hang?: boolean };
export type Responder = (req: FakeOllamaRequest, index: number) => FakeOllamaReply;

export type FakeOllama = {
  url: string;
  port: number;
  requests: FakeOllamaRequest[];
  /** Replies are consumed in order; after the queue drains, `fallback` answers. */
  queue: FakeOllamaReply[];
  fallback: Responder;
  push(...replies: FakeOllamaReply[]): void;
  close(): Promise<void>;
};

/** Build an Ollama-shaped chat response with the given assistant content. */
export function chatReply(content: string, extra: Partial<{ tool_calls: unknown[]; prompt_eval_count: number; eval_count: number; load_duration: number; total_duration: number; done_reason: string; model: string }> = {}): FakeOllamaReply {
  return {
    status: 200,
    json: {
      model: extra.model ?? 'fake-model',
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content, tool_calls: extra.tool_calls },
      done: true,
      done_reason: extra.done_reason ?? 'stop',
      prompt_eval_count: extra.prompt_eval_count ?? 100,
      eval_count: extra.eval_count ?? 50,
      load_duration: extra.load_duration ?? 1_000_000,
      total_duration: extra.total_duration ?? 50_000_000,
    },
  };
}

export async function startFakeOllama(opts: { port?: number; model?: string } = {}): Promise<FakeOllama> {
  const model = opts.model ?? 'qwen3.5:4b';
  const requests: FakeOllamaRequest[] = [];
  const queue: FakeOllamaReply[] = [];
  const hung = new Set<() => void>();
  const api: FakeOllama = {
    url: '', port: 0, requests, queue,
    fallback: () => chatReply('{}'),
    push: (...replies) => { queue.push(...replies); },
    close: () => new Promise<void>((resolve) => { for (const h of hung) h(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
  let index = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = {}; }
      const path = (req.url ?? '/').split('?')[0];
      const rec: FakeOllamaRequest = { at: Date.now(), method: req.method ?? 'GET', path, body };
      requests.push(rec);
      if (path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: model, model, size: 1, details: { quantization_level: 'fake' } }] }));
        return;
      }
      if (path !== '/api/chat') { res.writeHead(404); res.end('{}'); return; }
      const reply = queue.length ? queue.shift()! : api.fallback(rec, index);
      index++;
      if (reply.hang) {
        const release = () => { try { res.destroy(); } catch { /* ignore */ } };
        hung.add(release);
        req.on('close', () => hung.delete(release));
        return; // never answer
      }
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()); });
  api.port = (server.address() as { port: number }).port;
  api.url = `http://127.0.0.1:${api.port}`;
  return api;
}
