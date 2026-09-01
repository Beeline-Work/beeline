import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';

describe('server readiness', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function get(path: string, database: SqlDatabase): Promise<Response> {
    const server = createBeelineServer({
      database,
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}${path}`);
  }

  it('returns 200 after a successful database query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await get('/readyz', { query, transaction: vi.fn() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns 503 when the database query fails', async () => {
    const response = await get('/readyz', {
      query: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
      transaction: vi.fn(),
    });

    expect(response.status).toBe(503);
  });

  it('reports the release identity baked into the deployed image', async () => {
    vi.stubEnv('BEELINE_RELEASE_VERSION', 'v1.2.3');
    vi.stubEnv('BEELINE_RELEASE_SHA', '0123456789abcdef0123456789abcdef01234567');

    const response = await get('/version', {
      query: vi.fn(),
      transaction: vi.fn(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 'v1.2.3',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
    });
  });

  it('serves daemon release readiness without a phone bearer', async () => {
    const releaseReadiness = vi.fn().mockResolvedValue({
      daemons: [{ agentPubkey: 'a'.repeat(64), state: 'ready' }],
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: { releaseReadiness } as unknown as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/v1/releases/daemon-readiness`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      daemons: [{ agentPubkey: 'a'.repeat(64), state: 'ready' }],
    });
    expect(releaseReadiness).toHaveBeenCalledOnce();
  });
});
