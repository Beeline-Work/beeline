import { signEvent } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { LiveOverlayDecoder, applyLiveOverlay, visibleLiveOverlays } from './live-overlay.js';
import { composeRoomRows, addRoomPage, replaceRoomTail } from './room-response-partitions.js';
import { SignedEventOutbox } from './signed-event-outbox.js';
import { SurfaceResponseCache, surfaceCacheKey } from './surface-cache.js';
import { invalidatesSurface } from './surface-invalidation.js';
import { SurfaceRefreshScheduler } from './surface-refresh.js';
import type { RoomView, RoomViewMessage } from './room-view.js';

const ROOM = '7d111868-52eb-43ab-98ae-8a6c49b92da8';
const WORKSPACE = 'ec08be9d-9d9d-413e-b546-959d4abe39df';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function row(id: string, createdAt: number, requestId?: string): RoomViewMessage {
  const author = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Milo' };
  return {
    id, text: id.slice(0, 4), createdAt, author, presentation: 'message',
    reference: { channelId: ROOM, eventId: id, rootId: id },
    ...(requestId ? { requestId, liveTurnId: `live-turn:${requestId}` } : {}),
  };
}

function room(messages: readonly RoomViewMessage[]): RoomView {
  const identity = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Milo' };
  return {
    room: { id: ROOM, workspaceId: WORKSPACE, name: 'Room', archived: false, createdAt: 1, updatedAt: 2 },
    messages, members: [{ identity, role: 'member' }],
    viewer: { identity, role: 'member', permissions: { send: true, manage: false } },
    corners: [], watchFilters: [{ kinds: [9], '#h': [ROOM] }],
  };
}

describe('surface liveness scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('listens before reading, runs one trailing GET, and rejects an old generation', async () => {
    vi.useFakeTimers();
    const ready = deferred<void>();
    const first = deferred<number>();
    const second = deferred<number>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const applied: number[] = [];
    const scheduler = new SurfaceRefreshScheduler({ fetch, apply: (value) => applied.push(value) });

    const starting = scheduler.startAfter(ready.promise);
    scheduler.signal();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).not.toHaveBeenCalled();
    ready.resolve();
    await starting;
    await vi.runOnlyPendingTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);

    scheduler.signal();
    scheduler.signal();
    scheduler.advanceGeneration();
    first.resolve(1);
    await Promise.resolve();
    expect(applied).toEqual([]);

    scheduler.force();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    second.resolve(2);
    await Promise.resolve();
    expect(applied).toEqual([2]);
  });

  it('cannot starve under continuous signals or exceed two physical GETs per second', async () => {
    vi.useFakeTimers();
    let paints = 0;
    const fetch = vi.fn(async () => ++paints);
    const scheduler = new SurfaceRefreshScheduler({ fetch, apply: () => undefined });
    await scheduler.startAfter(Promise.resolve());
    for (let elapsed = 0; elapsed < 3_000; elapsed += 100) {
      scheduler.signal();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(7);
  });
});

describe('narrow live seam', () => {
  it('decodes verified overlays for ten viewers while draft/thought never invalidate GET state', () => {
    const agent = createIdentity('overlay-agent');
    const draft = signEvent({
      pubkey: agent.publicKey, created_at: 10, kind: 30078,
      tags: [['d', `agent-draft:${ROOM}`], ['h', ROOM], ['t', 'agent-draft'],
        ['agent', agent.publicKey], ['session', 'session'], ['request', 'request']],
      content: 'Hel',
    }, agent.secretKey);
    for (let viewer = 0; viewer < 10; viewer += 1) {
      const decoder = new LiveOverlayDecoder(ROOM, new Set([agent.publicKey]));
      expect(decoder.decode(draft)).toMatchObject({ kind: 'draft', text: 'Hel' });
    }
    expect(invalidatesSurface(draft, {
      kind: 'room', roomId: ROOM, familyIds: new Set([ROOM]), profileAuthors: new Set(),
    })).toBe(false);
  });

  it('suppresses a reordered final and close without duplicate bubbles', () => {
    const agent = createIdentity('overlay-final');
    const decoder = new LiveOverlayDecoder(ROOM, new Set([agent.publicKey]));
    const event = signEvent({
      pubkey: agent.publicKey, created_at: 10, kind: 30078,
      tags: [['d', `agent-draft:${ROOM}`], ['h', ROOM], ['t', 'agent-draft'],
        ['agent', agent.publicKey], ['request', 'request']], content: 'Done',
    }, agent.secretKey);
    const overlay = decoder.decode(event)!;
    expect(visibleLiveOverlays([overlay], [
      { ...row('1'.repeat(64), 11, 'request'), author: { pubkey: agent.publicKey, kind: 'agent', name: 'Milo' } },
    ])).toEqual([]);

    const close = signEvent({
      pubkey: agent.publicKey, created_at: 12, kind: 30078,
      tags: [['d', `agent-draft:${ROOM}`], ['h', ROOM], ['t', 'agent-draft'],
        ['agent', agent.publicKey], ['status', 'closed']], content: '',
    }, agent.secretKey);
    expect(applyLiveOverlay([overlay], decoder.decode(close)!)).toEqual([]);
  });
});

describe('separate response, cache, and outbox lifetimes', () => {
  it('preserves pages through 100 tail replacements and deduplicates only by stable id', () => {
    let partitions = addRoomPage({ pages: [] }, [row('1'.repeat(64), 1), row('2'.repeat(64), 2)]);
    partitions = addRoomPage(partitions, [row('2'.repeat(64), 2), row('3'.repeat(64), 3)]);
    for (let index = 0; index < 100; index += 1) {
      partitions = replaceRoomTail(partitions, room([row('4'.repeat(64), 4 + index)]));
    }
    expect(composeRoomRows(partitions).map((message) => message.id)).toEqual([
      '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64),
    ]);
  });

  it('keys warm DTOs by origin and viewer and evicts malformed cache entries', async () => {
    const values = new Map<string, string>();
    const cache = new SurfaceResponseCache({
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); },
      remove: async (key) => { values.delete(key); },
      keys: async () => [...values.keys()],
    });
    const address = { relayOrigin: 'https://relay.example', viewerPubkey: 'a'.repeat(64), endpoint: `/room/${ROOM}` };
    const key = surfaceCacheKey(address);
    values.set(key, '{bad');
    await expect(cache.read(address, (value): value is RoomView => Boolean(value))).resolves.toBeNull();
    expect(surfaceCacheKey({ ...address, viewerPubkey: 'b'.repeat(64) })).not.toBe(key);
  });

  it('retries the exact signed event and reconciles only the authoritative id', async () => {
    const identity = createIdentity('outbox');
    const event = signEvent({ pubkey: identity.publicKey, created_at: 10, kind: 9,
      tags: [['h', ROOM]], content: 'yes' }, identity.secretKey);
    let persisted: readonly any[] = [];
    const outbox = new SignedEventOutbox({
      load: async () => persisted,
      save: async (records) => { persisted = records; },
    });
    await outbox.enqueue(event, { ...row(event.id, event.created_at), author: {
      pubkey: identity.publicKey, kind: 'human', name: 'Ada',
    } });
    await outbox.attempted(event.id);
    expect(outbox.list()[0]?.event).toEqual(event);
    await outbox.reconcile(new Set([event.id]));
    expect(outbox.list()).toEqual([]);
  });
});
