import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
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
  profileCacheKey,
  useBuzzLocalCache,
} from './local-cache';
import { cacheLiveSessionEvent, revalidateCachedMessages } from './local-cache-sync';
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
});

describe('Buzz local cache', () => {
  it('caps messages and evicts least-recently-used Rooms', () => {
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
    store.replaceMessages(viewer, 'room', [message('cached', 1)], 1);
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

    vi.resetModules();
    const warm = await import('./local-cache');
    const restored = warm.useBuzzLocalCache.getState();
    expect(restored.channelLists[`${viewer}:workspace`]?.channels[0]?.title).toBe('Cached Room');
    expect(restored.channels[`${viewer}:room`]?.messages?.[0]?.text).toBe('cached');
    expect(restored.channels[`${viewer}:room`]?.roomMembers?.[0]?.pubkey).toBe('alice');
    expect(restored.profiles[`${viewer}:workspace`]?.[0]?.name).toBe('Alice');
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
});
