import type { AddressInfo } from 'node:net';
import type { CornerBriefDraft } from '@beeline/api-contract/daemon';
import * as Sentry from '@sentry/node';
import { expect, it, vi } from 'vitest';
import { validateCornerBrief } from './corner-brief.js';
import { LiveHub } from './live.js';
import { createBeelineServer, type ServerOptions } from './server.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

it('Reproduction R-S12: returns the approval refusal over HTTP without capturing it', async () => {
  vi.mocked(Sentry.captureException).mockClear();
  const server = createBeelineServer({
    database: { query: async () => ({ rows: [], rowCount: 0 }) },
    auth: { authenticateDaemon: async () => 'fixture-agent', authenticatePhone: async () => null },
    phone: {},
    // Stand-in for command authority and persistence; run the real validator
    // and HTTP error boundary without modifying a live corner.
    daemon: { execute: async (_name: string, input: { brief: CornerBriefDraft }) => {
      validateCornerBrief(input.brief);
    } },
    live: new LiveHub(),
    mediaMaximumBytes: 1,
  } as unknown as ServerOptions);
  const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/v1/daemon/operations/createCorner`, {
      method: 'POST',
      headers: { authorization: 'Bearer isolated-sentry-proof-token', 'content-type': 'application/json' },
      body: JSON.stringify({ brief: { spec: 'Test assignment', approval: { sourceMessageId: '' } } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'corner brief approval must name a human Room message' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    logging.mockRestore();
  }
});
