import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());
const mmkvWrites = vi.hoisted(() => vi.fn());

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvWrites(key, value);
      mmkvValues.set(key, value);
    }
    delete(key: string) {
      mmkvValues.delete(key);
    }
  },
}));

import {
  MAX_CACHED_CHANNELS,
  MAX_CACHED_MESSAGES_PER_CHANNEL,
  channelCacheKey,
  clearBuzzLocalCache,
  flushBuzzLocalCacheForBackground,
  mergeChannelBasicsWithCache,
  profileCacheKey,
  useBuzzLocalCache,
} from './local-cache';
import {
  cacheLiveSessionEvent,
  cacheLiveSessionEvents,
  revalidateCachedMessages,
} from './local-cache-sync';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';
import type { SessionEvent } from '@/sync/transport';

const viewer = 'viewer';

function message(id: string, timestamp: number): ChatDisplayMessage {
  return { id, timestamp, text: id, isUser: false };
}

function event(id: string, createdAt: number, content = id): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: { id, createdAt, content, pubkey: 'peer', tags: [] },
  };
}

beforeEach(() => {
  clearBuzzLocalCache();
  mmkvValues.clear();
  mmkvWrites.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Buzz local cache', () => {
  it('never serializes the full MMKV cache from a foreground caller turn', () => {
    const store = useBuzzLocalCache.getState();
    store.patchChannel(viewer, 'room', { roomName: 'First update' });
    store.patchChannel(viewer, 'room', { roomName: 'Final update' });

    // Cache mutations run from Room live handlers, the composer, and the
    // list's focus refresh. Writing here would block those UI interactions.
    expect(mmkvWrites).not.toHaveBeenCalled();

    flushBuzzLocalCacheForBackground();

    expect(mmkvWrites).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(mmkvValues.get('buzz-local-cache-v2') ?? '{}').channels[`${viewer}:room`]
        .roomName,
    ).toBe('Final update');
  });

  it('keeps a max-size transcript cache out of the mention/send UI turn', () => {
    const store = useBuzzLocalCache.getState();
    for (let room = 0; room < MAX_CACHED_CHANNELS; room += 1) {
      store.replaceMessages(
        viewer,
        `room-${room}`,
        Array.from({ length: MAX_CACHED_MESSAGES_PER_CHANNEL }, (_, index) =>
          message(`room-${room}-message-${index}`, index),
        ),
        MAX_CACHED_MESSAGES_PER_CHANNEL,
      );
    }
    flushBuzzLocalCacheForBackground();
    mmkvWrites.mockClear();

    // This is the same cache mutation made by the optimistic message in the
    // composer. It must not stringify 6,000 messages or enter synchronous
    // MMKV before the UI receives the next interaction.
    store.upsertMessages(viewer, 'room-0', [message('mention-send', Date.now())]);
    expect(mmkvWrites).not.toHaveBeenCalled();

    flushBuzzLocalCacheForBackground();
    expect(mmkvWrites).toHaveBeenCalledTimes(1);
  });

  it('keeps warm previews while refreshed channel basics are revalidated', () => {
    expect(
      mergeChannelBasicsWithCache(
        [{ id: 'room', active: true, title: 'Fresh title', updatedAt: 5 }],
        [
          {
            id: 'room',
            active: true,
            title: 'Cached title',
            updatedAt: 12,
            latestMessage: 'Warm preview',
            participantCount: 3,
            corners: [],
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        title: 'Fresh title',
        updatedAt: 12,
        latestMessage: 'Warm preview',
        participantCount: 3,
        corners: [],
      }),
    ]);
  });

  it('caps messages and evicts least-recently-used Rooms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = useBuzzLocalCache.getState();
    store.replaceMessages(
      viewer,
      'oldest',
      Array.from({ length: MAX_CACHED_MESSAGES_PER_CHANNEL + 20 }, (_, index) =>
        message(String(index), index),
      ),
      220,
    );
    expect(
      useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'oldest')]?.messages,
    ).toHaveLength(MAX_CACHED_MESSAGES_PER_CHANNEL);

    for (let index = 0; index < MAX_CACHED_CHANNELS; index += 1) {
      vi.advanceTimersByTime(1);
      useBuzzLocalCache.getState().patchChannel(viewer, `room-${index}`, { roomName: `${index}` });
    }
    const channels = useBuzzLocalCache.getState().channels;
    expect(Object.keys(channels)).toHaveLength(MAX_CACHED_CHANNELS);
    expect(channels[channelCacheKey(viewer, 'oldest')]).toBeUndefined();
  });

  it('replaces authoritative profile snapshots so removed profiles do not linger', () => {
    const store = useBuzzLocalCache.getState();
    const profile = (pubkey: string) => ({
      communityId: 'workspace',
      pubkey,
      name: pubkey,
      updatedAt: 1,
      raw: {} as never,
    });
    store.replaceProfiles(viewer, 'workspace', [profile('alice'), profile('bob')]);
    store.replaceProfiles(viewer, 'workspace', [profile('bob')]);
    expect(
      useBuzzLocalCache
        .getState()
        .profiles[profileCacheKey(viewer, 'workspace')]?.map((item) => item.pubkey),
    ).toEqual(['bob']);
  });

  it('restores lists, messages, rosters, and profiles from MMKV on a warm start', async () => {
    const now = Date.now();
    const store = useBuzzLocalCache.getState();
    store.setChannelList({
      viewerPubkey: viewer,
      communityId: 'workspace',
      channels: [{ id: 'room', active: true, title: 'Cached Room' }],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: now,
      lastAccessedAt: now,
    });
    store.replaceMessages(viewer, 'room', [message('cached', 1)], 1, {
      latestMessage: 'recent preview',
      latestMessageAt: 1,
      latestMessageId: 'cached',
      latestEventAt: 1,
    });
    store.patchChannel(viewer, 'room', { roomMembers: [{ pubkey: 'alice', role: 'member' }] });
    store.replaceProfiles(viewer, 'workspace', [
      {
        communityId: 'workspace',
        pubkey: 'alice',
        name: 'Alice',
        updatedAt: 1,
        raw: {} as never,
      },
    ]);

    flushBuzzLocalCacheForBackground();

    vi.resetModules();
    const warm = await import('./local-cache');
    const restored = warm.useBuzzLocalCache.getState();
    expect(restored.channelLists[`${viewer}:workspace`]?.channels[0]?.title).toBe('Cached Room');
    expect(restored.channels[`${viewer}:room`]?.messages?.[0]?.text).toBe('cached');
    expect(restored.channels[`${viewer}:room`]).toMatchObject({
      latestMessage: 'recent preview',
      latestMessageAt: 1,
      latestMessageId: 'cached',
    });
    expect(restored.channels[`${viewer}:room`]?.roomMembers?.[0]?.pubkey).toBe('alice');
    expect(restored.profiles[`${viewer}:workspace`]?.[0]?.name).toBe('Alice');
  });

  it('repairs legacy and malformed persisted values before they reach startup rendering', async () => {
    mmkvValues.set(
      'buzz-local-cache-v2',
      JSON.stringify({
        activeViewerPubkey: viewer,
        activeListKeyByViewer: { [viewer]: `${viewer}:workspace`, broken: 9 },
        channelLists: {
          [`${viewer}:workspace`]: {
            viewerPubkey: viewer,
            communityId: 'workspace',
            channels: null,
            directMessages: { stale: true },
            workspaceMembers: 'old-format',
            communities: [{ communityId: 'workspace', name: 'Workspace' }],
          },
          corrupt: null,
        },
        channels: {
          [`${viewer}:room`]: { viewerPubkey: viewer, channelId: 'room', messages: 'not-an-array' },
          corrupt: null,
        },
        profiles: {
          [`${viewer}:workspace`]: [{ pubkey: 'alice', name: 'Alice' }],
          corrupt: { name: 'not-an-array' },
        },
      }),
    );

    vi.resetModules();
    const warm = await import('./local-cache');
    const restored = warm.useBuzzLocalCache.getState();

    expect(restored.activeListKeyByViewer).toEqual({ [viewer]: `${viewer}:workspace` });
    expect(restored.channelLists[`${viewer}:workspace`]).toMatchObject({
      viewerPubkey: viewer,
      communities: [{ communityId: 'workspace', name: 'Workspace' }],
    });
    expect(restored.channelLists[`${viewer}:workspace`]?.channels).toEqual([]);
    expect(restored.channelLists[`${viewer}:workspace`]?.directMessages).toEqual([]);
    expect(restored.channelLists[`${viewer}:workspace`]?.workspaceMembers).toEqual([]);
    expect(restored.channels[`${viewer}:room`]?.messages).toBeUndefined();
    expect(restored.profiles[`${viewer}:workspace`]).toEqual([{ pubkey: 'alice', name: 'Alice' }]);
    expect(restored.channelLists.corrupt).toBeUndefined();
    expect(restored.channels.corrupt).toBeUndefined();
    expect(restored.profiles.corrupt).toBeUndefined();
  });

  it('uses a persisted cursor for delta revalidation and writes live events to the same cache', async () => {
    const now = Date.now();
    useBuzzLocalCache.getState().setChannelList({
      viewerPubkey: viewer,
      communityId: 'workspace',
      channels: [{ id: 'room', active: true, title: 'Room' }],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: now,
      lastAccessedAt: now,
    });
    const sessionEventsBackfill = vi
      .fn()
      .mockResolvedValueOnce([event('first', 10)])
      .mockResolvedValueOnce([event('second', 11)]);
    const transport = { sessionEventsBackfill };

    await revalidateCachedMessages(transport as never, viewer, 'room');
    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(1, 'room', { limit: 50 });
    expect(useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')]?.cursor).toBe(10);
    expect(useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')]?.backfilled).toBe(
      true,
    );

    await revalidateCachedMessages(transport as never, viewer, 'room');
    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(2, 'room', { afterSeq: 10 });

    cacheLiveSessionEvent(viewer, 'room', event('live', 12));
    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(cached?.cursor).toBe(12);
    expect(cached?.messages?.map((item) => item.id)).toEqual(['first', 'second', 'live']);
    expect(
      useBuzzLocalCache.getState().channelLists[`${viewer}:workspace`]?.channels[0],
    ).toMatchObject({ latestMessage: 'live', updatedAt: 12 });
  });

  it('replaces an old preview when a newer message shares the stream cursor second', async () => {
    const store = useBuzzLocalCache.getState();
    store.setChannelList({
      viewerPubkey: viewer,
      communityId: 'workspace',
      channels: [{ id: 'room', active: true, title: 'Room', latestMessage: 'ancient preview' }],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    store.patchChannel(viewer, 'room', {
      latestMessage: 'ancient preview',
      latestMessageAt: 10,
      latestMessageId: 'event-a',
      latestEventAt: 12,
      cursor: 12,
      backfilled: true,
      messages: [message('ancient preview', 10)],
    });

    await revalidateCachedMessages(
      { sessionEventsBackfill: vi.fn().mockResolvedValue([event('fresh preview', 12)]) } as never,
      viewer,
      'room',
    );

    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(cached).toMatchObject({
      latestMessage: 'fresh preview',
      latestMessageAt: 12,
      latestMessageId: 'fresh preview',
    });
    expect(useBuzzLocalCache.getState().channelLists[`${viewer}:workspace`]?.channels[0])
      .toMatchObject({ latestMessage: 'fresh preview', updatedAt: 12 });
  });

  it('does a full backfill without dropping a live event that created the cache first', async () => {
    const sessionEventsBackfill = vi.fn().mockResolvedValue([event('history', 10)]);
    cacheLiveSessionEvent(viewer, 'room', event('live', 12));

    await revalidateCachedMessages({ sessionEventsBackfill } as never, viewer, 'room');

    expect(sessionEventsBackfill).toHaveBeenCalledWith('room', { limit: 50 });
    expect(
      useBuzzLocalCache
        .getState()
        .channels[channelCacheKey(viewer, 'room')]?.messages?.map((item) => item.id),
    ).toEqual(['history', 'live']);
    expect(
      useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')]?.latestMessage,
    ).toBe('live');
  });

  it('retries an empty initial snapshot with a full history read', async () => {
    const sessionEventsBackfill = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event('late-history', 10)]);

    await revalidateCachedMessages({ sessionEventsBackfill } as never, viewer, 'room');
    await revalidateCachedMessages({ sessionEventsBackfill } as never, viewer, 'room');

    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(1, 'room', { limit: 50 });
    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(2, 'room', { limit: 50 });
  });

  it('cacheLiveSessionEvents writes a whole burst of live events in one store update, same result as one at a time', () => {
    const burst = [event('one', 1), event('two', 2), event('three', 3)];

    cacheLiveSessionEvents(viewer, 'room', burst);

    const batched = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(batched?.messages?.map((item) => item.id)).toEqual(['one', 'two', 'three']);
    expect(batched?.cursor).toBe(3);
    expect(batched?.latestMessage).toBe('three');

    clearBuzzLocalCache();
    for (const single of burst) cacheLiveSessionEvent(viewer, 'room', single);
    const sequential = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(sequential?.messages?.map((item) => item.id)).toEqual(
      batched?.messages?.map((item) => item.id),
    );
    expect(sequential?.cursor).toBe(batched?.cursor);
  });
});
