import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenAfterBestEffortRecovery } from './startup.js';

describe('server startup containment', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('listens after a rejected presence recovery and reports it once', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    servers.push(server);
    const report = vi.fn();

    await listenAfterBestEffortRecovery(
      server,
      async () => {
        throw new Error('canceling statement due to statement timeout');
      },
      0,
      '127.0.0.1',
      25,
      report,
    );

    expect(server.listening).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      '[startup] presence recovery unavailable; continuing',
      'canceling statement due to statement timeout',
    );
  });

  it('listens after a hung presence recovery reaches its bound', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    servers.push(server);
    const report = vi.fn();

    await listenAfterBestEffortRecovery(
      server,
      () => new Promise(() => {}),
      0,
      '127.0.0.1',
      5,
      report,
    );

    expect(server.listening).toBe(true);
    expect(report).toHaveBeenCalledWith(
      '[startup] presence recovery unavailable; continuing',
      'timed out after 5ms',
    );
  });
});
