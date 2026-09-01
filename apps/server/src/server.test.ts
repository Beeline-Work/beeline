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
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function readyz(database: SqlDatabase): Promise<Response> {
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
    return fetch(`http://127.0.0.1:${port}/readyz`);
  }

  it('returns 200 after a successful database query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await readyz({ query, transaction: vi.fn() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns 503 when the database query fails', async () => {
    const response = await readyz({
      query: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
      transaction: vi.fn(),
    });

    expect(response.status).toBe(503);
  });
});
