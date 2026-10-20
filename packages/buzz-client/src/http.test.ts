import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { queryEvents, type HttpBridgeOptions } from './http.js';

const identity = createIdentity('http-test');
const opts: HttpBridgeOptions = {
  baseUrl: 'https://relay.example',
  host: 'relay.example',
  identity,
};

function authEvent(init?: RequestInit): NostrEvent {
  const headers = init?.headers as Record<string, string>;
  const encoded = headers.authorization.slice('Nostr '.length);
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
  );
  return JSON.parse(json) as NostrEvent;
}

function signedEvent(): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: 'authenticated publish',
    },
    identity.secretKey,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HTTP bridge NIP-98 auth', () => {
  it('retries transient HTTP failures on queryEvents before succeeding', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const querying = queryEvents(opts, [{ kinds: [1] }], identity.publicKey);
    const result = expect(querying).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries queryEvents network errors and attempt timeouts before succeeding', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('timed out', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const querying = queryEvents(opts, [{ kinds: [1] }], identity.publicKey);
    const result = expect(querying).resolves.toEqual([]);
    await vi.runAllTimersAsync();
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects when query fetches ignore abort and never settle', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const querying = queryEvents(opts, [{ kinds: [1] }], identity.publicKey);
    const result = expect(querying).rejects.toThrow('queryEvents failed after 3 attempts');
    await vi.runAllTimersAsync();
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient queryEvents rejection', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryEvents(opts, [{ kinds: [1] }], identity.publicKey)).rejects.toThrow(
      'HTTP 401',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('signs the public origin when a local proxy canonicalizes the Host tenant', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await queryEvents(
      {
        baseUrl: 'http://127.0.0.1:3010',
        host: '10.0.2.2:3010',
        publicOrigin: 'http://10.0.2.2:3010',
        identity,
      },
      [],
      identity.publicKey,
    );

    const [request, init] = fetchMock.mock.calls[0]!;
    expect(request).toBe('http://127.0.0.1:3010/query');
    expect((init.headers as Record<string, string>).host).toBe('10.0.2.2:3010');
    expect(authEvent(init).tags).toContainEqual(['u', 'http://10.0.2.2:3010/query']);
  });

  it('keeps the X-Pubkey-only fallback when no signer identity is supplied', async () => {
    let headers: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return new Response('[]', { status: 200 });
      }),
    );

    await queryEvents(
      { baseUrl: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' },
      [],
      identity.publicKey,
    );

    expect(headers?.['x-pubkey']).toBe(identity.publicKey);
    expect(headers?.authorization).toBeUndefined();
  });

  it('deduplicates concurrent projection reads without caching mutable state', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const filters = [{ kinds: [39_002], '#d': ['cache-test'], limit: 5 }];

    await Promise.all([
      queryEvents(opts, filters, identity.publicKey),
      queryEvents(opts, filters, identity.publicKey),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await queryEvents(opts, filters, identity.publicKey);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a found single-channel metadata read the same way as an immutable create event', async () => {
    const metadata = {
      ...signedEvent(),
      id: 'metadata-event',
      kind: 39_000,
      tags: [['d', 'chan']],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([metadata]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const filters = [{ kinds: [39_000], '#d': ['chan'], limit: 5 }];

    await queryEvents(opts, filters, identity.publicKey);
    await queryEvents(opts, filters, identity.publicKey);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a not-found or multi-id metadata read', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notFound = [{ kinds: [39_000], '#d': ['missing-chan'], limit: 5 }];
    const multiId = [{ kinds: [39_000], '#d': ['chan-a', 'chan-b'], limit: 5 }];

    await queryEvents(opts, notFound, identity.publicKey);
    await queryEvents(opts, notFound, identity.publicKey);
    await queryEvents(opts, multiId, identity.publicKey);
    await queryEvents(opts, multiId, identity.publicKey);

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('caches an unscoped create-event scan past the old 500ms window but expires it well short of the 5-minute immutable TTL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const filters = [{ kinds: [9_007], limit: 500 }];

    await queryEvents(opts, filters, identity.publicKey);
    vi.advanceTimersByTime(5_000);
    await queryEvents(opts, filters, identity.publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await queryEvents(opts, filters, identity.publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
