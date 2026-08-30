import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { publishEvent, queryEvents, type HttpBridgeOptions } from './http.js';

const identity = createIdentity('http-test');
const opts: HttpBridgeOptions = {
  baseUrl: 'https://relay.example',
  host: 'relay.example',
  identity,
  batchQueries: true,
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
  it('retries transient HTTP failures with the same signed event until it lands', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const event = signedEvent();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const publishing = publishEvent(opts, event);
    const result = expect(publishing).resolves.toMatchObject({ status: 200, accepted: true });
    await vi.runAllTimersAsync();
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify(event),
      JSON.stringify(event),
      JSON.stringify(event),
    ]);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[0]?.[0]).toContain('HTTP 502');
    expect(warning.mock.calls[1]?.[0]).toContain('HTTP 503');
  });

  it('retries network errors and attempt timeouts before succeeding', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const publishing = publishEvent(opts, signedEvent());
    const result = expect(publishing).resolves.toMatchObject({ status: 200, accepted: true });
    await vi.runAllTimersAsync();
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient publish rejection', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(publishEvent(opts, signedEvent())).rejects.toMatchObject({
      kind: 'UNAUTHORIZED',
      status: 401,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: 400,
      body: 'invalid',
      kind: 'INVALID_EVENT',
      retryable: false,
      retryAfterMs: undefined,
    },
    {
      status: 408,
      body: 'timeout',
      kind: 'TIMEOUT',
      retryable: true,
      retryAfterMs: undefined,
    },
    {
      status: 429,
      body: JSON.stringify({ error: 'private quota detail; retry in 4s' }),
      kind: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: 4_000,
    },
  ] as const)(
    'returns a typed HTTP $status refusal with its structured retry posture',
    async ({ status, body, kind, retryable, retryAfterMs }) => {
      const fetchMock = vi.fn(async () => new Response(body, { status }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(publishEvent(opts, signedEvent())).rejects.toMatchObject({
        kind,
        status,
        retryable,
        retryAfterMs,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

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

  it('authenticates query and publish against their exact request URLs', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return new Response(
          String(input).endsWith('/query') ? '[]' : JSON.stringify({ accepted: true }),
          { status: 200 },
        );
      }),
    );

    await queryEvents(opts, [], identity.publicKey);
    await publishEvent(opts, signedEvent());

    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      const expectedUrl =
        index === 0 ? 'https://relay.example/query' : 'https://relay.example/events';
      const headers = request.init?.headers as Record<string, string>;
      const auth = authEvent(request.init);
      expect(request.input).toBe(expectedUrl);
      expect(request.init?.method).toBe('POST');
      expect(headers['x-pubkey']).toBe(identity.publicKey);
      expect(headers.host).toBe('relay.example');
      expect(auth.pubkey).toBe(identity.publicKey);
      expect(auth.tags).toContainEqual(['u', expectedUrl]);
      expect(auth.tags).toContainEqual(['method', 'POST']);
      expect(verifyEvent(auth)).toBe(true);
    }
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

  it('fails before relay polling when the auth signer and event signer differ', async () => {
    const otherIdentity = createIdentity('other-http-test');
    const mismatched = signEvent(
      {
        pubkey: otherIdentity.publicKey,
        created_at: 1_700_000_000,
        kind: 9001,
        tags: [['h', 'room-id']],
        content: '',
      },
      otherIdentity.secretKey,
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(publishEvent(opts, mismatched)).rejects.toMatchObject({
      kind: 'CLIENT_VALIDATION',
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an explicit negative publish acknowledgement as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ accepted: false, error: 'actor not authorized' }), {
            status: 200,
          }),
      ),
    );

    await expect(publishEvent(opts, signedEvent())).rejects.toMatchObject({
      kind: 'NEGATIVE_ACK',
      retryable: false,
    });
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

  it('batches distinct concurrent filters into one request and partitions the response', async () => {
    const alpha = { ...signedEvent(), id: 'alpha', kind: 1, tags: [['h', 'alpha-room']] };
    const beta = { ...signedEvent(), id: 'beta', kind: 2, tags: [['h', 'beta-room']] };
    let postedFilters: unknown;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      postedFilters = JSON.parse(String(init?.body));
      return new Response(JSON.stringify([alpha, beta]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [alphaEvents, betaEvents] = await Promise.all([
      queryEvents(opts, [{ kinds: [1], '#h': ['alpha-room'], limit: 5 }], identity.publicKey),
      queryEvents(opts, [{ kinds: [2], '#h': ['beta-room'], limit: 5 }], identity.publicKey),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedFilters).toEqual([
      { kinds: [1], '#h': ['alpha-room'], limit: 5 },
      { kinds: [2], '#h': ['beta-room'], limit: 5 },
    ]);
    expect(alphaEvents.map((event) => event.id)).toEqual(['alpha']);
    expect(betaEvents.map((event) => event.id)).toEqual(['beta']);
  });

  it('invalidates cached projections after a publish', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/query')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ accepted: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const filters = [{ kinds: [9_007], '#h': ['publish-cache-test'], limit: 5 }];

    await queryEvents(opts, filters, identity.publicKey);
    await queryEvents(opts, filters, identity.publicKey);
    await publishEvent(opts, signedEvent());
    await queryEvents(opts, filters, identity.publicKey);

    expect(fetchMock).toHaveBeenCalledTimes(3);
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
