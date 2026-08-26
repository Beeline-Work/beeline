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
  selectKnownCommunities,
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

  it('commits a large live burst with one cache notification', () => {
    useBuzzLocalCache
      .getState()
      .replaceSnapshot(
        VIEWER,
        ROOM,
        createWorkspaceSnapshot({ workspaceId: 'workspace' }),
        undefined,
      );
    const replaceSnapshot = vi.spyOn(useBuzzLocalCache.getState(), 'replaceSnapshot');
    const events = Array.from({ length: 240 }, (_, index) => ({
      type: 'read-model' as const,
      sessionId: ROOM,
      event: humanMessage(`live-${index}`, index + 1),
    }));

    cacheLiveSessionEvents(VIEWER, ROOM, events);

    expect(replaceSnapshot).toHaveBeenCalledOnce();
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM)).toHaveLength(240);
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

  it('queues a live message until a cold snapshot exists, then renders it', async () => {
    const liveEvent = {
      type: 'read-model',
      sessionId: ROOM,
      event: humanMessage('live-during-hydration', 3),
    } as const;
    cacheLiveSessionEvents(VIEWER, ROOM, [liveEvent]);
    expect(useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]).toBeUndefined();

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
    expect(selectTranscript(snapshot, ROOM).map((item) => item.id)).toEqual([
      'older',
      'live-during-hydration',
    ]);
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

  it('keeps two successively confirmed Rooms visible through one-behind snapshot swaps', () => {
    const store = useBuzzLocalCache.getState();
    store.setChannelList({
      viewerPubkey: VIEWER,
      communityId: 'workspace',
      channels: [],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: 1,
      lastAccessedAt: 1,
    });

    store.upsertConfirmedChannel(VIEWER, 'workspace', {
      id: 'first-room',
      active: true,
      title: 'Tubing capital',
      createdAt: 2,
      updatedAt: 2,
    });
    store.patchChannelList(VIEWER, 'workspace', {
      channels: mergeChannelBasicsWithCache(
        [],
        useBuzzLocalCache.getState().channelLists[`${VIEWER}:workspace`]!.channels,
      ),
    });

    store.upsertConfirmedChannel(VIEWER, 'workspace', {
      id: 'second-room',
      active: true,
      title: 'Brrr',
      createdAt: 3,
      updatedAt: 3,
    });
    const reconciled = mergeChannelBasicsWithCache(
      [{ id: 'first-room', active: true, title: 'Tubing capital', createdAt: 2, updatedAt: 2 }],
      useBuzzLocalCache.getState().channelLists[`${VIEWER}:workspace`]!.channels,
    );

    expect(reconciled.map((room) => room.id)).toEqual(['second-room', 'first-room']);
    expect(reconciled.find((room) => room.id === 'first-room')).not.toHaveProperty(
      'awaitingListReconciliation',
    );
    expect(reconciled.find((room) => room.id === 'second-room')).toMatchObject({
      awaitingListReconciliation: true,
    });
    expect(mmkvWrites).not.toHaveBeenCalled();
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

  it('evicts a deleted Workspace deck and repoints the active list in memory', () => {
    const store = useBuzzLocalCache.getState();
    const tubing = { communityId: 'tubing-1', name: 'Tubing Crew' } as never;
    const personal = { communityId: 'personal-1', name: 'Personal' } as never;
    for (const [communityId, room, communities] of [
      ['tubing-1', 'tubing-room', [tubing]],
      ['personal-1', 'personal-room', [personal, tubing]],
    ] as const) {
      store.setChannelList({
        viewerPubkey: VIEWER,
        communityId,
        channels: [{ id: room, active: true, title: room }],
        directMessages: [],
        workspaceMembers: [],
        communities: [...communities],
        personalWorkspaceId: 'personal-1',
        viewerIsAgent: false,
        canEditWorkspaceAvatar: false,
        updatedAt: 1,
        lastAccessedAt: 1,
      });
      store.patchChannel(VIEWER, room, { communityId });
      store.replaceProfiles(VIEWER, communityId, []);
    }
    expect(useBuzzLocalCache.getState().activeListKeyByViewer[VIEWER]).toBe(
      `${VIEWER}:personal-1`,
    );
    mmkvWrites.mockClear();

    store.reconcileWorkspaceSet(VIEWER, [tubing], 'tubing-1');

    const reconciled = useBuzzLocalCache.getState();
    expect(selectKnownCommunities(reconciled, VIEWER)).toEqual([tubing]);
    expect(reconciled.channelLists[`${VIEWER}:personal-1`]).toBeUndefined();
    expect(reconciled.channelLists[`${VIEWER}:tubing-1`]!.personalWorkspaceId).toBeNull();
    expect(reconciled.channels[`${VIEWER}:personal-room`]).toBeUndefined();
    expect(reconciled.profiles[`${VIEWER}:personal-1`]).toBeUndefined();
    expect(reconciled.activeListKeyByViewer[VIEWER]).toBe(`${VIEWER}:tubing-1`);
    expect(mmkvWrites).not.toHaveBeenCalled();
  });
});

describe('stale cached thread roots', () => {
  const ROOT = 'root-event';
  const S1 = 'reply-one';
  const S2 = 'reply-two';
  const S3 = 'reply-three';

  function threaded(id: string, createdAt: number, parent?: { eventId: string; rootId: string }) {
    return {
      ...humanMessage(id, createdAt, `body-${id}`),
      ...(parent
        ? {
            reply: {
              channelId: ROOM,
              eventId: parent.eventId,
              rootId: parent.rootId,
            },
          }
        : {}),
    } as HumanMessage;
  }

  /** R -> S1 -> S2 -> S3 with the stale mid-thread roots a pre-fix build
   * persisted for messages parsed from truncated or incremental windows. */
  function staleThreadedSnapshot() {
    let snapshot = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      threaded(ROOT, 1),
    );
    snapshot = reduceWorkspaceSnapshot(
      snapshot,
      threaded(S1, 2, { eventId: ROOT, rootId: ROOT }),
    );
    snapshot = reduceWorkspaceSnapshot(
      snapshot,
      threaded(S2, 3, { eventId: S1, rootId: S1 }),
    );
    return reduceWorkspaceSnapshot(snapshot, threaded(S3, 4, { eventId: S2, rootId: S2 }));
  }

  function persistedCachePayload(snapshot: unknown): string {
    return JSON.stringify({
      bootIntegrityHalt: null,
      activeViewerPubkey: null,
      activeListKeyByViewer: {},
      channelLists: {},
      channels: {
        [`${VIEWER}:${ROOM}`]: {
          viewerPubkey: VIEWER,
          channelId: ROOM,
          updatedAt: 1,
          lastAccessedAt: 1,
          snapshot,
        },
      },
      profiles: {},
    });
  }

  it('repairs stale persisted thread roots when the v3 cache is restored at boot', async () => {
    vi.resetModules();
    mmkvValues.set('buzz-local-cache-v3', persistedCachePayload(staleThreadedSnapshot()));
    const restored = await import('./local-cache');
    const journal = restored.useBuzzLocalCache.getState().channels[`${VIEWER}:${ROOM}`]!.snapshot!
      .rooms[ROOM]!.eventJournal;
    expect((journal[S2] as HumanMessage).reply!.rootId).toBe(ROOT);
    expect((journal[S3] as HumanMessage).reply!.rootId).toBe(ROOT);
    // Already-correct claims stay untouched.
    expect((journal[S1] as HumanMessage).reply!.rootId).toBe(ROOT);
    expect((journal[ROOT] as HumanMessage).reply).toBeUndefined();
  });

  it('leaves healthy snapshots byte-identical and unverifiable chains alone', async () => {
    vi.resetModules();
    mmkvValues.set('buzz-local-cache-v3', persistedCachePayload(staleThreadedSnapshot()));
    const { repairCachedThreadRoots } = await import('./local-cache');

    // A chain that climbs to its true root inside the journal is rewritten...
    const journal = repairCachedThreadRoots(staleThreadedSnapshot()).rooms[ROOM]!.eventJournal;
    expect((journal[S3] as HumanMessage).reply!.rootId).toBe(ROOT);

    // ...a fully healthy snapshot returns the same reference (no churn)...
    let healthy = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      threaded(ROOT, 1),
    );
    healthy = reduceWorkspaceSnapshot(
      healthy,
      threaded(S1, 2, { eventId: ROOT, rootId: ROOT }),
    );
    healthy = reduceWorkspaceSnapshot(
      healthy,
      threaded(S2, 3, { eventId: S1, rootId: ROOT }),
    );
    expect(repairCachedThreadRoots(healthy)).toBe(healthy);

    // ...and a chain whose top falls outside the journal keeps its claims.
    const orphaned = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      threaded(S3, 4, { eventId: S2, rootId: S2 }),
    );
    expect(repairCachedThreadRoots(orphaned)).toBe(orphaned);
  });

  it('does not loop on a cyclic stored thread index', async () => {
    vi.resetModules();
    const { repairCachedThreadRoots } = await import('./local-cache');
    let cyclic = reduceWorkspaceSnapshot(
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      threaded('cycle-a', 1, { eventId: 'cycle-b', rootId: 'cycle-b' }),
    );
    cyclic = reduceWorkspaceSnapshot(
      cyclic,
      threaded('cycle-b', 2, { eventId: 'cycle-a', rootId: 'cycle-a' }),
    );
    expect(repairCachedThreadRoots(cyclic)).toBe(cyclic);
  });
});
