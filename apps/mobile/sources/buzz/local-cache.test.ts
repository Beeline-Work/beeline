import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  createWorkspaceSnapshot,
  reduceWorkspaceSnapshot,
  selectTranscript,
  type HumanMessage,
} from '@beeline/buzz-client';
import {
  MAX_CACHED_CHANNELS,
  channelCacheKey,
  clearBuzzLocalCache,
  flushBuzzLocalCacheForBackground,
  mergeChannelBasicsWithCache,
  useBuzzLocalCache,
} from './local-cache';
import { cacheLiveSessionEvents, revalidateCachedMessages } from './local-cache-sync';

const VIEWER = 'viewer';
const ROOM = 'room';

function humanMessage(id: string, createdAt: number, body = id): HumanMessage {
  return {
    type: 'human-message',
    eventId: id,
    channelId: ROOM,
    workspaceId: 'workspace',
    scope: 'channel',
    authorPubkey: VIEWER,
    createdAt,
    sourceKind: 9,
    signature: 'verified',
    body,
    attachments: [],
    mentionPubkeys: [],
  } as HumanMessage;
}

beforeEach(() => {
  clearBuzzLocalCache();
  mmkvValues.clear();
  mmkvWrites.mockClear();
});

describe('normalized Buzz cache', () => {
  it('never serializes during a foreground mutation and flushes only schema v3', () => {
    useBuzzLocalCache.getState().patchChannel(VIEWER, ROOM, { roomName: 'Read model room' });
    expect(mmkvWrites).not.toHaveBeenCalled();

    flushBuzzLocalCacheForBackground();
    expect(mmkvWrites).toHaveBeenCalledOnce();
    expect(mmkvValues.has('buzz-local-cache-v3')).toBe(true);
  });

  it('persists one normalized snapshot and strips presentation corner arrays', () => {
    const snapshot = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      humanMessage('human-1', 1, 'Never lose this'),
    );
    const store = useBuzzLocalCache.getState();
    store.setChannelList({
      viewerPubkey: VIEWER,
      communityId: 'workspace',
      channels: [{ id: ROOM, active: true, title: 'Room', corners: [{ id: 'stale' } as never] }],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: 1,
      lastAccessedAt: 1,
    });
    store.replaceSnapshot(VIEWER, ROOM, snapshot, 1);
    flushBuzzLocalCacheForBackground();

    const persisted = JSON.parse(mmkvValues.get('buzz-local-cache-v3')!);
    expect(persisted.channels[`${VIEWER}:${ROOM}`].snapshot).toEqual(snapshot);
    expect(persisted.channelLists[`${VIEWER}:workspace`].channels[0].corners).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain('messages');
  });

  it('folds live typed events exactly once into the cached snapshot', () => {
    useBuzzLocalCache
      .getState()
      .replaceSnapshot(
        VIEWER,
        ROOM,
        createWorkspaceSnapshot({ workspaceId: 'workspace' }),
        undefined,
      );
    const event = { type: 'read-model', sessionId: ROOM, event: humanMessage('same', 2) } as const;
    cacheLiveSessionEvents(VIEWER, ROOM, [event]);
    cacheLiveSessionEvents(VIEWER, ROOM, [event]);

    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM).map((item) => item.id)).toEqual(['same']);
  });

  it('merges a cold relay snapshot without erasing an event that arrived live first', async () => {
    const live = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      humanMessage('live', 3),
    );
    useBuzzLocalCache.getState().replaceSnapshot(VIEWER, ROOM, live, 3);
    const cold = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      humanMessage('older', 1),
    );
    const transport = {
      readModelBackfill: vi.fn(async () => ({
        snapshot: cold,
        events: [{ type: 'read-model', sessionId: ROOM, event: humanMessage('older', 1) }],
      })),
    };

    await revalidateCachedMessages(transport as never, VIEWER, ROOM);
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM).map((item) => item.id)).toEqual(['older', 'live']);
  });

  it('lets a Room Retry start a fresh backfill when the first hydration never settles', async () => {
    const recovered = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      humanMessage('recovered', 4, 'Recovered transcript'),
    );
    const transport = {
      readModelBackfill: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({
          snapshot: recovered,
          events: [{ type: 'read-model', sessionId: ROOM, event: humanMessage('recovered', 4) }],
        }),
    };

    const wedged = revalidateCachedMessages(transport as never, VIEWER, ROOM);
    expect(revalidateCachedMessages(transport as never, VIEWER, ROOM)).toBe(wedged);

    await revalidateCachedMessages(transport as never, VIEWER, ROOM, { force: true });

    expect(transport.readModelBackfill).toHaveBeenCalledTimes(2);
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM).map((item) => item.id)).toEqual(['recovered']);
  });

  it('keeps warm list enrichment while fresh structural basics arrive', () => {
    expect(
      mergeChannelBasicsWithCache(
        [{ id: ROOM, active: true, title: 'Fresh', updatedAt: 2 }],
        [
          {
            id: ROOM,
            active: true,
            title: 'Old',
            updatedAt: 1,
            latestMessage: 'hello',
            repoName: 'beeline',
          },
        ],
      )[0],
    ).toMatchObject({ title: 'Fresh', latestMessage: 'hello', repoName: 'beeline' });
  });

  it('bounds cached Rooms and removes a Room from every list for only that viewer', () => {
    const store = useBuzzLocalCache.getState();
    for (let index = 0; index <= MAX_CACHED_CHANNELS; index += 1) {
      store.patchChannel(VIEWER, `room-${index}`, { roomName: `Room ${index}` });
    }
    expect(Object.keys(useBuzzLocalCache.getState().channels)).toHaveLength(MAX_CACHED_CHANNELS);

    store.setChannelList({
      viewerPubkey: VIEWER,
      communityId: 'workspace',
      channels: [{ id: 'room-30', active: true, title: 'Room' }],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: 1,
      lastAccessedAt: 1,
    });
    store.removeChannel(VIEWER, 'room-30');
    expect(
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, 'room-30')],
    ).toBeUndefined();
    expect(useBuzzLocalCache.getState().channelLists[`${VIEWER}:workspace`]!.channels).toEqual([]);
  });
});
