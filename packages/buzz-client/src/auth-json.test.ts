import { generateKeypair } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestAuthJson } from './auth-json.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth JSON transport', () => {
  it('maps network failures to a retryable offline error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Network request failed')));

    await expect(
      requestAuthJson('https://relay.example', '/auth/test', { identity: generateKeypair() }),
    ).rejects.toMatchObject({ code: 'offline', retryable: true });
  });

  it('preserves typed service errors and known details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'owner_grant_needed',
            message: 'owner must install the App',
            install_url: 'https://github.com/apps/beeline/installations/new',
            repository: 'acme/widget',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(requestAuthJson('https://relay.example', '/auth/test')).rejects.toMatchObject({
      code: 'owner_grant_needed',
      status: 403,
      details: {
        installUrl: 'https://github.com/apps/beeline/installations/new',
        repository: 'acme/widget',
      },
    });
  });

  it.each([null, [], 'not-json'])('rejects invalid JSON response bodies: %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(body === 'not-json' ? body : JSON.stringify(body), { status: 200 }),
        ),
    );

    await expect(requestAuthJson('https://relay.example', '/auth/test')).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    });
  });
});
