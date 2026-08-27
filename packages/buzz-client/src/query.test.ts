import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { query, type QueryFunnelContext } from './query.js';
import type { RelayWs } from './ws.js';
import type { NostrEvent } from '@beeline/nostr';

function fakeEvent(id: string, tags: string[][] = []): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 100,
    kind: 9,
    tags,
    content: id,
    sig: 'b'.repeat(128),
  };
}

function httpCtx(identity = createIdentity('query-funnel')): QueryFunnelContext {
  return {
    http: { baseUrl: 'https://relay.test', host: 'relay.test', identity },
    identity,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('query() funnel', () => {
  it('uses the WS path when the socket is already connected', async () => {
    let capturedFilters: unknown;
    let capturedOnEose: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const fakeSocket = {
      connected: true,
      onClose: vi.fn(() => () => {}),
      subscribe: vi.fn((filters: unknown, onEvent: (event: NostrEvent) => void, opts) => {
        capturedFilters = filters;
        capturedOnEose = opts?.onEose;
        onEvent(fakeEvent('ws-one'));
        return unsubscribe;
      }),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ctx = { ...httpCtx(), ws: () => fakeSocket as unknown as RelayWs };
    const pending = query(ctx, [{ kinds: [9], limit: 1 }]);
    await vi.waitFor(() => expect(fakeSocket.subscribe).toHaveBeenCalled());
    capturedOnEose!();

    const events = await pending;
    expect(events.map((event) => event.id)).toEqual(['ws-one']);
    expect(capturedFilters).toEqual([{ kinds: [9], limit: 1 }]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to HTTP when there is no ws accessor at all', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([fakeEvent('http-one')])));
    vi.stubGlobal('fetch', fetchMock);

    const events = await query(httpCtx(), [{ kinds: [9], limit: 1 }]);

    expect(events.map((event) => event.id)).toEqual(['http-one']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to HTTP when the socket exists but is not connected, without forcing a connect', async () => {
    const subscribe = vi.fn();
    const disconnectedSocket = { connected: false, subscribe };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([fakeEvent('http-two')])));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = { ...httpCtx(), ws: () => disconnectedSocket as unknown as RelayWs };
    const events = await query(ctx, [{ kinds: [9], limit: 1 }]);

    expect(events.map((event) => event.id)).toEqual(['http-two']);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to HTTP when the WS attempt fails', async () => {
    const fakeSocket = {
      connected: true,
      onClose: vi.fn(() => () => {}),
      subscribe: vi.fn(() => {
        throw new Error('send failed: socket not open');
      }),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([fakeEvent('http-three')])));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = { ...httpCtx(), ws: () => fakeSocket as unknown as RelayWs };
    const events = await query(ctx, [{ kinds: [9], limit: 1 }]);

    expect(events.map((event) => event.id)).toEqual(['http-three']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('batches same-tick calls on the same socket into one multi-filter REQ, partitioned per caller', async () => {
    let capturedFilters: Record<string, unknown>[] = [];
    let capturedOnEose: (() => void) | undefined;
    const fakeSocket = {
      connected: true,
      onClose: vi.fn(() => () => {}),
      subscribe: vi.fn(
        (filters: Record<string, unknown>[], onEvent: (e: NostrEvent) => void, opts) => {
          capturedFilters = filters;
          capturedOnEose = opts?.onEose;
          onEvent(fakeEvent('room-a-event', [['h', 'room-a']]));
          onEvent(fakeEvent('room-b-event', [['h', 'room-b']]));
          return vi.fn();
        },
      ),
    };
    const identity = createIdentity('query-batching');
    const ctx: QueryFunnelContext = {
      http: { baseUrl: 'https://relay.test', host: 'relay.test', identity },
      identity,
      ws: () => fakeSocket as unknown as RelayWs,
    };

    // Two independent same-tick callers, each with its own #h scope and limit.
    const first = query(ctx, [{ kinds: [9], '#h': ['room-a'], limit: 1 }]);
    const second = query(ctx, [{ kinds: [9], '#h': ['room-b'], limit: 1 }]);
    await vi.waitFor(() => expect(fakeSocket.subscribe).toHaveBeenCalled());
    capturedOnEose!();

    const [firstEvents, secondEvents] = await Promise.all([first, second]);
    expect(fakeSocket.subscribe).toHaveBeenCalledOnce();
    expect(capturedFilters).toEqual([
      { kinds: [9], '#h': ['room-a'], limit: 1 },
      { kinds: [9], '#h': ['room-b'], limit: 1 },
    ]);
    expect(firstEvents.map((e) => e.id)).toEqual(['room-a-event']);
    expect(secondEvents.map((e) => e.id)).toEqual(['room-b-event']);
  });

  it('splits a same-tick fan-out before it exceeds the relay filter budget', async () => {
    const eose: Array<() => void> = [];
    const captured: Record<string, unknown>[][] = [];
    const fakeSocket = {
      connected: true,
      onClose: vi.fn(() => () => {}),
      subscribe: vi.fn(
        (filters: Record<string, unknown>[], onEvent: (e: NostrEvent) => void, opts) => {
          captured.push(filters);
          eose.push(opts.onEose);
          for (const filter of filters) {
            const room = (filter['#h'] as string[])[0]!;
            onEvent(fakeEvent(`${room}-event`, [['h', room]]));
          }
          return vi.fn();
        },
      ),
    };
    const identity = createIdentity('query-filter-budget');
    const ctx: QueryFunnelContext = {
      http: { baseUrl: 'https://relay.test', host: 'relay.test', identity },
      identity,
      ws: () => fakeSocket as unknown as RelayWs,
    };

    const reads = Array.from({ length: 9 }, (_, index) => {
      const room = `room-${index}`;
      return query(ctx, [{ kinds: [9], '#h': [room], limit: 1 }]);
    });
    await vi.waitFor(() => expect(fakeSocket.subscribe).toHaveBeenCalledTimes(2));
    eose.forEach((finish) => finish());

    const results = await Promise.all(reads);
    expect(captured.map((filters) => filters.length)).toEqual([8, 1]);
    expect(results.map((events) => events[0]?.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `room-${index}-event`),
    );
  });
});
