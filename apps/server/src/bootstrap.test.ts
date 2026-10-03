import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBeetleServer } from './index.ts';

describe('director token bootstrap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beetle-boot-'));
  let server: Awaited<ReturnType<typeof createBeetleServer>>;
  beforeAll(async () => {
    server = await createBeetleServer({ port: 0, host: '127.0.0.1', dataDir: dir, directorToken: 'boot-director-token-0000000000', agentToken: 'boot-agent-token-00000000000000' } as never);
  });
  afterAll(async () => { await server.stop?.(); rmSync(dir, { recursive: true, force: true }); });

  it('hands the director token to same-machine requests', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/director/bootstrap', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe('boot-director-token-0000000000');
  });

  it('refuses other devices on the network', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/director/bootstrap', remoteAddress: '203.0.113.7' });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain('boot-director-token');
  });
});
