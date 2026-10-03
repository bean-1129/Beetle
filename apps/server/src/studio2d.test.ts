// 2D studio routes against a fake local model endpoint on an ephemeral loopback port.
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBeetleServer, type BeetleServer } from './index.ts';
import { parseModelJson } from './studio2d.ts';

const DIRECTOR = 'd1rector-token-for-studio2d-0123456789';
const AGENT = 'agent-token-for-studio2d-0123456789abcd';
const MODEL = 'test-model:1b';

type FakeModel = {
  url: string;
  chats: any[];
  generates: any[];
  /** Reply content for the next /api/chat; 'hang' never answers. */
  reply: string;
  onChat?: () => void;
  close(): Promise<void>;
};

async function startFakeModel(): Promise<FakeModel> {
  const fake: FakeModel = {
    url: '',
    chats: [],
    generates: [],
    reply: '{}',
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL }, { name: 'other:7b', model: 'other:7b' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/generate') {
        fake.generates.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, response: '', done: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        fake.chats.push(JSON.parse(raw));
        fake.onChat?.();
        if (fake.reply === 'hang') return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: MODEL, message: { role: 'assistant', content: fake.reply }, done: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}

type Harness = { server: BeetleServer; dataDir: string; fake: FakeModel | null };
const harnesses: Harness[] = [];

async function makeServer(ollamaBaseUrl?: string): Promise<Harness> {
  const fake = ollamaBaseUrl ? null : await startFakeModel();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'beetle-studio2d-test-'));
  const server = await createBeetleServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    publicUrl: 'http://127.0.0.1:7700',
    directorToken: DIRECTOR,
    agentToken: AGENT,
    startWorld: 'none',
    loadSnapshot: false,
    tickMode: 'manual',
    ollamaBaseUrl: ollamaBaseUrl ?? fake!.url,
    modelName: MODEL,
    webDistDir: null,
    logRequests: false,
  });
  await server.start();
  const h = { server, dataDir, fake };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.stop();
    await h.fake?.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  }
});

async function api(server: BeetleServer, method: 'GET' | 'POST', url: string, opts: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await server.app.inject({ method, url, headers, payload: opts.body === undefined ? undefined : JSON.stringify(opts.body), remoteAddress: '127.0.0.1' });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

describe('parseModelJson', () => {
  it('strips code fences and falls back to the outermost object', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Sure! {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
    expect(parseModelJson('{"x":[1,2]}')).toEqual({ x: [1, 2] });
    expect(parseModelJson('no json here')).toBeUndefined();
  });
});

describe('2d studio routes', () => {
  it('status is public and lists the local models', async () => {
    const { server } = await makeServer();
    const res = await api(server, 'GET', '/api/2d/status');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ online: true, models: [MODEL, 'other:7b'], image: false });
  });

  it('llm returns parsed json from a fenced reply and forwards the request shape', async () => {
    const { server, fake } = await makeServer();
    fake!.reply = 'Here you go:\n```json\n{"tiles":[1,2,3],"name":"cave"}\n```';
    const res = await api(server, 'POST', '/api/2d/llm', {
      token: DIRECTOR,
      body: { id: 'gen-1', system: 'You design 2D levels.', prompt: 'a small cave', temperature: 0.3, maxTokens: 512 },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, json: { tiles: [1, 2, 3], name: 'cave' }, model: MODEL });
    expect(typeof res.json.ms).toBe('number');
    const sent = fake!.chats[0];
    expect(sent).toMatchObject({ model: MODEL, stream: false, think: false, format: 'json' });
    expect(sent.options).toEqual({ temperature: 0.3, num_predict: 512, num_ctx: 8192 });
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You design 2D levels.' },
      { role: 'user', content: 'a small cave' },
    ]);
    // Event logged without prompt text.
    const logged = server.events.recent(50, (e) => e.name === 'studio2d.llm');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ outcome: 'ok', model: MODEL, data: { ok: true, model: MODEL } });
    expect(typeof logged[0].durationMs).toBe('number');
    expect(JSON.stringify(logged)).not.toContain('a small cave');
    expect(JSON.stringify(logged)).not.toContain('2D levels');
  });

  it('forwards a schema as the format and honours numCtx', async () => {
    const { server, fake } = await makeServer();
    const schema = { type: 'object', properties: { w: { type: 'integer' } }, required: ['w'] };
    fake!.reply = '{"w":12}';
    const res = await api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { system: 's', prompt: 'p', schema, numCtx: 4096 } });
    expect(res.json).toMatchObject({ ok: true, json: { w: 12 } });
    expect(fake!.chats[0].format).toEqual(schema);
    expect(fake!.chats[0].options.num_ctx).toBe(4096);
  });

  it('rejects non-director tokens, missing tokens and invalid bodies', async () => {
    const { server, fake } = await makeServer();
    for (const route of ['/api/2d/llm', '/api/2d/warm', '/api/2d/cancel']) {
      expect((await api(server, 'POST', route, { token: AGENT, body: { system: 's', prompt: 'p', id: 'x' } })).status).toBe(403);
      expect((await api(server, 'POST', route, { body: { system: 's', prompt: 'p', id: 'x' } })).status).toBe(401);
    }
    const extra = await api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { system: 's', prompt: 'p', host: 'http://evil' } });
    expect(extra.status).toBe(400);
    expect(extra.json.ok).toBe(false);
    const hot = await api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { system: 's', prompt: 'p', temperature: 2 } });
    expect(hot.status).toBe(400);
    expect(fake!.chats).toHaveLength(0);
  });

  it('warm loads the model with keep_alive 1h', async () => {
    const { server, fake } = await makeServer();
    const res = await api(server, 'POST', '/api/2d/warm', { token: DIRECTOR });
    expect(res.json).toEqual({ ok: true, model: MODEL });
    expect(fake!.generates[0]).toMatchObject({ model: MODEL, keep_alive: '1h', stream: false });
  });

  it('cancel aborts an in-flight call', async () => {
    const { server, fake } = await makeServer();
    fake!.reply = 'hang';
    const arrived = new Promise<void>((resolve) => { fake!.onChat = resolve; });
    const pending = api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { id: 'slow-1', system: 's', prompt: 'p' } });
    await arrived;
    const cancel = await api(server, 'POST', '/api/2d/cancel', { token: DIRECTOR, body: { id: 'slow-1' } });
    expect(cancel.status).toBe(200);
    expect(cancel.json.ok).toBe(true);
    expect(cancel.json.cancelled).toBe(true);
    const res = await pending;
    expect(res.json).toEqual({ ok: false, error: 'cancelled' });
    // Unknown ids are a no-op.
    expect((await api(server, 'POST', '/api/2d/cancel', { token: DIRECTOR, body: { id: 'slow-1' } })).json).toEqual({ ok: true, cancelled: false });
  });

  it('caps concurrent model calls at two', async () => {
    const { server, fake } = await makeServer();
    fake!.reply = 'hang';
    let seen = 0;
    const two = new Promise<void>((resolve) => { fake!.onChat = () => { seen += 1; if (seen === 2) resolve(); }; });
    const a = api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { id: 'a', system: 's', prompt: 'p' } });
    const b = api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { id: 'b', system: 's', prompt: 'p' } });
    await two;
    const c = await api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { id: 'c', system: 's', prompt: 'p' } });
    expect(c.status).toBe(429);
    await api(server, 'POST', '/api/2d/cancel', { token: DIRECTOR, body: { id: 'a' } });
    await api(server, 'POST', '/api/2d/cancel', { token: DIRECTOR, body: { id: 'b' } });
    expect((await a).json.error).toBe('cancelled');
    expect((await b).json.error).toBe('cancelled');
  });

  it('refuses a non-loopback model endpoint without contacting it', async () => {
    const { server } = await makeServer('http://10.255.255.1:11434');
    const status = await api(server, 'GET', '/api/2d/status');
    expect(status.json).toEqual({ online: false, models: [], image: false });
    const res = await api(server, 'POST', '/api/2d/llm', { token: DIRECTOR, body: { system: 's', prompt: 'p' } });
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toMatch(/loopback/);
    const warm = await api(server, 'POST', '/api/2d/warm', { token: DIRECTOR });
    expect(warm.json.ok).toBe(false);
  });
});
