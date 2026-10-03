import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBeetleServer, type BeetleServer } from './index.ts';

describe('director token bootstrap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beetle-boot-'));
  let server: BeetleServer;
  beforeAll(async () => {
    server = await createBeetleServer({ port: 0, host: '127.0.0.1', dataDir: dir, directorToken: 'boot-director-token-0000000000', webDistDir: null, logRequests: false });
  });
  afterAll(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });

  it('hands the director token to same-machine requests', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/director/bootstrap', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().token).toBe('boot-director-token-0000000000');
  });

  it('refuses other devices on the network', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/director/bootstrap', remoteAddress: '203.0.113.7' });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain('boot-director-token');
  });
});

describe('server basics', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('generates a director token into data/secrets.json and reuses it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'beetle-secrets-'));
    dirs.push(dataDir);
    const first = await createBeetleServer({ port: 0, host: '127.0.0.1', dataDir, webDistDir: null, logRequests: false, env: {} });
    expect(first.secrets.source).toBe('generated');
    const file = JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8'));
    expect(Object.keys(file)).toEqual(['directorToken']);
    expect(file.directorToken).toBe(first.tokens.director);
    expect(statSync(join(dataDir, 'secrets.json')).mode & 0o777).toBe(0o600);
    await first.stop();
    const second = await createBeetleServer({ port: 0, host: '127.0.0.1', dataDir, webDistDir: null, logRequests: false, env: {} });
    expect(second.secrets.source).toBe('file');
    expect(second.tokens.director).toBe(first.tokens.director);
    await second.stop();
  });

  it('health reports the model, listens on port 0 and logs events without tokens', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'beetle-health-'));
    dirs.push(dataDir);
    const token = 'health-director-token-000000000';
    const server = await createBeetleServer({ port: 0, host: '127.0.0.1', dataDir, directorToken: token, ollamaBaseUrl: 'http://10.255.255.1:11434', modelName: 'm:1b', webDistDir: null, logRequests: false });
    const info = await server.start();
    expect(info.port).toBeGreaterThan(0);
    const res = await fetch(`${info.url}/api/health`);
    expect(await res.json()).toEqual({ ok: true, model: { name: 'm:1b', reachable: false, present: false } });
    await server.stop();
    const log = readFileSync(join(dataDir, 'events', 'server.jsonl'), 'utf8');
    expect(log).toContain('server.started');
    expect(log).not.toContain(token);
  });

  it('serves the 2D studio at / and /2d with long-cached assets', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'beetle-static-'));
    dirs.push(dataDir);
    const web = join(dataDir, 'dist');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'studio2d.html'), '<!doctype html><title>studio</title>');
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    const server = await createBeetleServer({ port: 0, host: '127.0.0.1', dataDir, directorToken: 'static-director-token-000000000', webDistDir: web, logRequests: false });
    for (const url of ['/', '/2d']) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('studio');
    }
    const asset = await server.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await server.app.inject({ method: 'GET', url: '/nope.html' })).statusCode).toBe(404);
    await server.stop();
  });
});
