/** Production-relay proof for transient publish retry and 4xx fail-fast behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { publishEvent, queryEvents } from './http.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker } from './live-helpers.js';

const reachable = await isRelayUp();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.runIf(reachable)('live publish resilience', () => {
  it('retries an injected 502, logs it, and lands the exact event on the relay', async () => {
    const identity = createIdentity(`publish-retry-live-${Date.now()}`);
    const opts = { baseUrl: DEFAULT_BASE_URL, host: DEFAULT_HOST, identity };
    const marker = uniqueMarker('publish-retry-live');
    const event = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['t', marker]],
        content: `publish retry production proof ${marker}`,
      },
      identity.secretKey,
    );
    const realFetch = globalThis.fetch.bind(globalThis);
    let publishAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events') && publishAttempts++ === 0) {
          return new Response('injected Cloudflare tunnel blip', { status: 502 });
        }
        return realFetch(input, init);
      }),
    );

    const result = await publishEvent(opts, event);
    expect(result).toMatchObject({ accepted: true });
    expect(publishAttempts).toBe(2);

    const landed = await queryEvents(opts, [{ ids: [event.id], limit: 5 }], identity.publicKey);
    expect(landed.map((candidate) => candidate.id)).toEqual([event.id]);
    console.log(
      `[live] retry=HTTP_502 attempts=${publishAttempts} landed=${event.id.slice(0, 12)} relay=${DEFAULT_BASE_URL}`,
    );
  });

  it('does not retry an injected 401', async () => {
    const identity = createIdentity(`publish-401-live-${Date.now()}`);
    const event = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [['t', uniqueMarker('publish-401-live')]],
        content: 'must fail fast',
      },
      identity.secretKey,
    );
    let publishAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        publishAttempts++;
        return new Response('injected unauthorized', { status: 401 });
      }),
    );

    await expect(
      publishEvent({ baseUrl: DEFAULT_BASE_URL, host: DEFAULT_HOST, identity }, event),
    ).rejects.toThrow('HTTP 401');
    expect(publishAttempts).toBe(1);
    console.log(`[live] fail-fast=HTTP_401 attempts=${publishAttempts}`);
  });
});

describe.runIf(!reachable)('live publish resilience (skipped)', () => {
  it('requires a reachable relay', () => {
    console.log(`[live] SKIP publish resilience proof: relay unreachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
