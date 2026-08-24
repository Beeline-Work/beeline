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
  mergedRepoName,
  profileCacheKey,
  useBuzzLocalCache,
} from './local-cache';
import {
  cacheLiveSessionEvent,
  cacheLiveSessionEvents,
  refreshRoomListCornersForUnknownSignals,
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

function controlEvent(id: string, createdAt: number, tags: string[][], content = id): SessionEvent {
  return {
    type: 'raw',
    sessionId: 'room',
    payload: { id, createdAt, content, pubkey: 'agent', tags },
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

  it('never persists the transient new-message flag into the MMKV snapshot', () => {
    const store = useBuzzLocalCache.getState();
    // A live-arrived message carries `isNew` in memory — that is what drives
    // its one entrance animation while the transcript is on screen.
    store.upsertMessages(viewer, 'room', [{ ...message('fresh', 10), isNew: true }], 10);
    expect(
      useBuzzLocalCache
        .getState()
        .channels[`${viewer}:room`]?.messages?.find((m) => m.id === 'fresh')?.isNew,
    ).toBe(true);

    flushBuzzLocalCacheForBackground();
    const persisted = JSON.parse(mmkvValues.get('buzz-local-cache-v2') ?? '{}');
    const persistedMessage = persisted.channels[`${viewer}:room`].messages.find(
      (m: { id: string }) => m.id === 'fresh',
    );
    // The flag must not survive serialization: a restored transcript that
    // still carries it replays the new-message entrance on old messages.
    expect(persistedMessage.isNew).toBeUndefined();
  });

  it('does not mark an already-cached message as new when warm revalidation re-fetches it', async () => {
    // Reproduction of the replay bug: a room's cold open hydrates the cache,
    // then warm delta revalidation re-fetches from the persisted cursor. That
    // cursor is inclusive, so the SAME event id comes back — and warm
    // revalidation projects every fetched event as `isNew`. If the upsert
    // merge let that flag through, an already-known message would flip to the
    // typewriter/entrance path on every room open.
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
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    const sessionEventsBackfill = vi
      .fn()
      .mockResolvedValueOnce([event('known', 10)])
      // Warm pass: inclusive cursor edge re-delivers the known event AND a
      // genuinely new one that arrived while the room stayed open.
      .mockResolvedValueOnce([event('known', 10), event('arrived', 11)]);
    const transport = { sessionEventsBackfill };

    await revalidateCachedMessages(transport as never, viewer, 'room'); // cold hydrate
    await revalidateCachedMessages(transport as never, viewer, 'room'); // warm refetch

    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(cached?.messages?.map((m) => m.id)).toEqual(['known', 'arrived']);
    // A known id re-fetched must NOT carry the new-arrival trigger...
    expect(cached?.messages?.find((m) => m.id === 'known')?.isNew).toBeUndefined();
    // ...while a first-insertion id still animates exactly once.
    expect(cached?.messages?.find((m) => m.id === 'arrived')?.isNew).toBe(true);
  });

  it('does not mark a cached message new when live delivery replays its event id', () => {
    // Simulate a restored transcript: the known id is in the cache WITHOUT
    // the transient flag (persist() strips it). A WS resubscribe replay that
    // re-delivers that same event id must not turn it into a new arrival.
    useBuzzLocalCache.getState().replaceMessages(viewer, 'room', [message('replayed', 20)], 20);
    cacheLiveSessionEvent(viewer, 'room', event('replayed', 20));
    cacheLiveSessionEvent(viewer, 'room', event('fresh-live', 21));
    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(cached?.messages?.map((m) => m.id)).toEqual(['replayed', 'fresh-live']);
    expect(cached?.messages?.find((m) => m.id === 'replayed')?.isNew).toBeUndefined();
    expect(cached?.messages?.find((m) => m.id === 'fresh-live')?.isNew).toBe(true);
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

  it('keeps a resolved repo tag across a warm basics upsert that lacks one', () => {
    // Reproduction of the owner report: the repo tag rendered on first paint
    // (cached row carries `repoName`), then vanished seconds later when the
    // warm refresh committed fresh basics that never carry enrichment. A
    // warm update without the value must not clobber a present one.
    expect(
      mergeChannelBasicsWithCache(
        [{ id: 'room', active: true, title: 'Fresh title', updatedAt: 20 }],
        [
          {
            id: 'room',
            active: true,
            title: 'Cached title',
            updatedAt: 12,
            repoName: 'lunchboxfortwo/beeline',
            modelLabel: 'ox-alpha',
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        title: 'Fresh title',
        repoName: 'lunchboxfortwo/beeline',
        modelLabel: 'ox-alpha',
      }),
    ]);
  });

  it('a warm upsert carrying a changed repoName still updates it', () => {
    expect(
      mergeChannelBasicsWithCache(
        [{ id: 'room', active: true, title: 'Fresh', updatedAt: 5, repoName: 'org/moved-repo' }],
        [{ id: 'room', active: true, title: 'Cached', updatedAt: 12, repoName: 'org/old-repo' }],
      ),
    ).toEqual([expect.objectContaining({ repoName: 'org/moved-repo' })]);
  });

  it('mergedRepoName changes the row only on a definitive relay answer', () => {
    const repository = (name: string) => ({
      kind: 'repository' as const,
      repository: {
        channelId: 'room',
        binding: { key: 'k', name, localOnly: false },
        source: 'config' as const,
      },
    });
    // A confirmed binding carries the (possibly changed) name.
    expect(mergedRepoName('old/name', repository('new/name'))).toBe('new/name');
    // A confirmed absence genuinely clears it.
    expect(mergedRepoName('old/name', { kind: 'none' })).toBeUndefined();
    // "Config exists but no admin authorizes it" is NOT an absence — keep.
    expect(
      mergedRepoName('old/name', { kind: 'unverified', reason: 'no admin author' }),
    ).toBe('old/name');
    // A failed/thrown read is not evidence either — keep.
    expect(mergedRepoName('old/name', undefined)).toBe('old/name');
    // And nothing is invented where nothing was known before.
    expect(mergedRepoName(undefined, { kind: 'unverified', reason: 'x' })).toBeUndefined();
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

  it('strips stale new-message flags a pre-strip build persisted before they reach startup rendering', async () => {
    mmkvValues.set(
      'buzz-local-cache-v2',
      JSON.stringify({
        activeViewerPubkey: viewer,
        activeListKeyByViewer: {},
        channelLists: {},
        channels: {
          [`${viewer}:room`]: {
            viewerPubkey: viewer,
            channelId: 'room',
            cursor: 10,
            backfilled: true,
            messages: [
              { id: 'old-1', timestamp: 1, text: 'old one', isUser: false, isNew: true },
              { id: 'old-2', timestamp: 2, text: 'old two', isUser: false },
            ],
          },
        },
        profiles: {},
      }),
    );

    vi.resetModules();
    const warm = await import('./local-cache');
    const restoredMessages = warm.useBuzzLocalCache.getState().channels[`${viewer}:room`]?.messages;
    expect(restoredMessages?.map((m) => m.id)).toEqual(['old-1', 'old-2']);
    // Every restored row is history: none may enter the transcript claiming
    // to be newly arrived, or its entrance animation replays on first paint.
    expect(restoredMessages?.every((m) => m.isNew === undefined)).toBe(true);
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
    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(1, 'room', { limit: 200 });
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

  it('keeps a busy corner\'s opening narration on a cold open, past the old 50-event limit', async () => {
    // A relay's `limit` returns the N most recent matching events — there is
    // no way to ask for "the first N" directly. Simulate that faithfully: a
    // channel whose total kind:9 traffic (61 events: activity/status noise
    // interleaved with narration) exceeds the OLD 50-event cold-fetch cap but
    // not the current 200-event one.
    const opening = controlEvent('opening-narration', 1, [['t', 'agent-message']], 'Starting work.');
    const noise = Array.from({ length: 60 }, (_, index) => event(`noise-${index}`, index + 2));
    const all = [opening, ...noise];
    const sessionEventsBackfill = vi.fn((_channelId: string, opts: { limit?: number }) =>
      Promise.resolve(opts.limit ? all.slice(-opts.limit) : all),
    );

    await revalidateCachedMessages({ sessionEventsBackfill } as never, viewer, 'corner');

    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'corner')];
    expect(cached?.messages?.some((item) => item.id === 'opening-narration')).toBe(true);
  });

  it('flips a stale cached archived=false corner to archived once a fresh archive event lands', async () => {
    useBuzzLocalCache.getState().patchChannel(viewer, 'corner', {
      archived: false,
      cursor: 10,
      backfilled: true,
      messages: [message('open-status', 10)],
    });
    const sessionEventsBackfill = vi
      .fn()
      .mockResolvedValue([
        controlEvent('archived-status', 11, [
          ['t', 'body-control'],
          ['status', 'archived'],
        ]),
      ]);

    const result = await revalidateCachedMessages(
      { sessionEventsBackfill } as never,
      viewer,
      'corner',
    );

    expect(sessionEventsBackfill).toHaveBeenCalledWith('corner', { afterSeq: 10 });
    expect(result.archiveChannel).toBe(true);
    expect(useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'corner')]?.archived).toBe(
      true,
    );
  });

  it('replaces a cached OPEN room-chat corner card with ARCHIVED once the close status card lands', async () => {
    useBuzzLocalCache.getState().patchChannel(viewer, 'room', {
      cursor: 10,
      backfilled: true,
      messages: [
        {
          id: 'corner-corner-1',
          text: 'starting',
          isUser: false,
          timestamp: 10,
          corner: { subchannelId: 'corner-1', agentPubkey: 'agent', status: 'live' },
        },
      ],
    });
    const sessionEventsBackfill = vi
      .fn()
      .mockResolvedValue([
        controlEvent('archived-status', 11, [
          ['t', 'body-control'],
          ['subchannel', 'corner-1'],
          ['status', 'archived'],
        ]),
      ]);

    await revalidateCachedMessages({ sessionEventsBackfill } as never, viewer, 'room');

    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(cached?.messages).toHaveLength(1);
    expect(cached?.messages?.[0]).toMatchObject({
      id: 'corner-corner-1',
      corner: { subchannelId: 'corner-1', status: 'archived' },
    });
  });

  it('walks a room-chat inline corner card forward to ARCHIVED from a live event, not just revalidation', () => {
    useBuzzLocalCache.getState().patchChannel(viewer, 'room', {
      cursor: 10,
      backfilled: true,
      messages: [
        {
          id: 'corner-corner-1',
          text: 'starting',
          isUser: false,
          timestamp: 10,
          corner: { subchannelId: 'corner-1', agentPubkey: 'agent', status: 'live' },
        },
      ],
    });

    cacheLiveSessionEvent(
      viewer,
      'room',
      controlEvent('archived-status', 11, [
        ['t', 'body-control'],
        ['subchannel', 'corner-1'],
        ['status', 'archived'],
      ]),
    );

    const cached = useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room')];
    expect(cached?.messages?.[0]).toMatchObject({
      id: 'corner-corner-1',
      corner: { subchannelId: 'corner-1', status: 'archived' },
    });
  });

  it('keeps the Room-list sidebar corner card current when a corner is archived after the list snapshot was fetched', () => {
    const now = Date.now();
    useBuzzLocalCache.getState().setChannelList({
      viewerPubkey: viewer,
      communityId: 'workspace',
      channels: [
        {
          id: 'room',
          active: true,
          title: 'Room',
          corners: [
            { id: 'corner-1', name: 'implement-this', openerPubkey: 'agent', status: 'live' },
          ],
        },
      ],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: now,
      lastAccessedAt: now,
    });

    // The corner-close control event is delivered to the PARENT Room's live
    // subscription (channels.tsx subscribes per-room, not per-corner) — this
    // is the exact live path the Room-list sidebar's own subscription uses.
    cacheLiveSessionEvent(
      viewer,
      'room',
      controlEvent('archived-status', 11, [
        ['t', 'body-control'],
        ['subchannel', 'corner-1'],
        ['status', 'archived'],
      ]),
    );

    expect(
      useBuzzLocalCache.getState().channelLists[`${viewer}:workspace`]?.channels[0]?.corners,
    ).toEqual([
      {
        id: 'corner-1',
        name: 'implement-this',
        openerPubkey: 'agent',
        status: 'archived',
        lastActivityAt: 11,
      },
    ]);
  });

  it('never regresses or fabricates a sidebar corner card from an out-of-order or unlisted signal', () => {
    const now = Date.now();
    useBuzzLocalCache.getState().setChannelList({
      viewerPubkey: viewer,
      communityId: 'workspace',
      channels: [
        {
          id: 'room',
          active: true,
          title: 'Room',
          corners: [
            { id: 'corner-1', name: 'implement-this', openerPubkey: 'agent', status: 'archived' },
          ],
        },
      ],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: now,
      lastAccessedAt: now,
    });

    // A stale reorder replay of an earlier 'live' status must not walk the
    // already-archived corner backwards.
    cacheLiveSessionEvent(
      viewer,
      'room',
      controlEvent('stale-status', 5, [
        ['t', 'body-control'],
        ['subchannel', 'corner-1'],
        ['status', 'live'],
      ]),
    );
    // A signal for a corner not yet in the sidebar snapshot must not
    // fabricate a new, under-specified entry.
    cacheLiveSessionEvent(
      viewer,
      'room',
      controlEvent('unlisted-status', 12, [
        ['t', 'body-control'],
        ['subchannel', 'corner-2'],
        ['status', 'archived'],
      ]),
    );

    expect(
      useBuzzLocalCache.getState().channelLists[`${viewer}:workspace`]?.channels[0]?.corners,
    ).toEqual([{ id: 'corner-1', name: 'implement-this', openerPubkey: 'agent', status: 'archived' }]);
  });

  it('refreshes the Room-list lifecycle when a live signal announces a newly opened corner', async () => {
    const now = Date.now();
    const firstCorner = {
      id: 'corner-1',
      name: 'first-task',
      openerPubkey: 'agent',
      status: 'live' as const,
    };
    const secondCorner = {
      id: 'corner-2',
      name: 'second-task',
      openerPubkey: 'agent',
      status: 'open' as const,
    };
    useBuzzLocalCache.getState().setChannelList({
      viewerPubkey: viewer,
      communityId: 'workspace',
      channels: [{ id: 'room', active: true, title: 'Room', corners: [firstCorner] }],
      directMessages: [],
      workspaceMembers: [],
      communities: [],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: false,
      updatedAt: now,
      lastAccessedAt: now,
    });
    const projections = cacheLiveSessionEvents(viewer, 'room', [
      controlEvent('new-corner-status', 12, [
        ['t', 'body-control'],
        ['subchannel', 'corner-2'],
        ['status', 'open'],
      ]),
    ]);
    const listSubchannelLifecycle = vi.fn(async () => [firstCorner, secondCorner]);

    await refreshRoomListCornersForUnknownSignals(
      { listSubchannelLifecycle } as never,
      viewer,
      'room',
      projections,
    );

    expect(listSubchannelLifecycle).toHaveBeenCalledWith('room');
    expect(
      useBuzzLocalCache.getState().channelLists[`${viewer}:workspace`]?.channels[0]?.corners,
    ).toEqual([firstCorner, secondCorner]);
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

    expect(sessionEventsBackfill).toHaveBeenCalledWith('room', { limit: 200 });
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

    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(1, 'room', { limit: 200 });
    expect(sessionEventsBackfill).toHaveBeenNthCalledWith(2, 'room', { limit: 200 });
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
  /**
   * The room list stays subscribed to this store even while a Room covers it,
   * and its selector reads `channelLists`. Rebuilding that map on every write
   * re-rendered and re-sorted the whole list once per delivered live batch,
   * for no visible difference — so an unchanged write must be identity-stable.
   */
  describe('room-list writes are identity-stable when nothing changed', () => {
    const seedList = () =>
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey: viewer,
        communityId: 'workspace',
        channels: [
          {
            id: 'room',
            active: true,
            title: 'Room',
            latestMessage: 'settled preview',
            updatedAt: 12,
            corners: [
              { id: 'corner-1', name: 'work', openerPubkey: 'agent', status: 'live' },
            ],
          },
        ],
        directMessages: [],
        workspaceMembers: [],
        communities: [],
        personalWorkspaceId: null,
        viewerIsAgent: false,
        canEditWorkspaceAvatar: false,
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
      });

    it('keeps the same channelLists object when a preview write changes nothing', () => {
      seedList();
      const before = useBuzzLocalCache.getState().channelLists;

      useBuzzLocalCache.getState().upsertMessages(viewer, 'room', [], undefined, {
        latestMessage: 'settled preview',
        latestEventAt: 12,
      });

      expect(useBuzzLocalCache.getState().channelLists).toBe(before);
    });

    it('still publishes a genuinely new preview', () => {
      seedList();
      const before = useBuzzLocalCache.getState().channelLists;

      useBuzzLocalCache.getState().upsertMessages(viewer, 'room', [], undefined, {
        latestMessage: 'brand new preview',
        latestEventAt: 20,
      });

      const after = useBuzzLocalCache.getState().channelLists;
      expect(after).not.toBe(before);
      expect(after[`${viewer}:workspace`]?.channels[0]).toMatchObject({
        latestMessage: 'brand new preview',
        updatedAt: 20,
      });
    });

    it('keeps the same channelLists object when a corner signal repeats its status', () => {
      seedList();
      const before = useBuzzLocalCache.getState().channelLists;

      useBuzzLocalCache
        .getState()
        .patchCornerStatus(viewer, 'room', { subchannelId: 'corner-1', status: 'live' });

      expect(useBuzzLocalCache.getState().channelLists).toBe(before);
    });

    it('moves a repeated lifecycle signal forward when its meaningful-event time advances', () => {
      seedList();

      useBuzzLocalCache.getState().patchCornerStatus(viewer, 'room', {
        subchannelId: 'corner-1',
        status: 'live',
        lastActivityAt: 99,
      });

      expect(
        useBuzzLocalCache.getState().channelLists[`${viewer}:workspace`]?.channels[0]?.corners?.[0],
      ).toMatchObject({ status: 'live', lastActivityAt: 99 });
    });

    it('still advances a corner whose status genuinely moved', () => {
      seedList();
      const before = useBuzzLocalCache.getState().channelLists;

      useBuzzLocalCache.getState().patchCornerStatus(viewer, 'room', {
        subchannelId: 'corner-1',
        status: 'archived',
        lastActivityAt: 99,
      });

      const after = useBuzzLocalCache.getState().channelLists;
      expect(after).not.toBe(before);
      expect(after[`${viewer}:workspace`]?.channels[0]?.corners?.[0]).toMatchObject({
        status: 'archived',
        lastActivityAt: 99,
      });
    });
  });

  describe('removeChannel purges a deleted Room from the local cache', () => {
    const seedWithRooms = () => {
      const now = Date.now();
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey: viewer,
        communityId: 'workspace',
        channels: [
          { id: 'room-a', active: true, title: 'Keep', updatedAt: now },
          { id: 'room-b', active: false, archived: true, title: 'Gone', updatedAt: now },
        ],
        directMessages: [],
        workspaceMembers: [],
        communities: [],
        personalWorkspaceId: null,
        viewerIsAgent: false,
        canEditWorkspaceAvatar: false,
        updatedAt: now,
        lastAccessedAt: now,
      });
      useBuzzLocalCache
        .getState()
        .replaceMessages(viewer, 'room-b', [message('m1', 5)], 5);
    };

    it('drops the row from every list of this viewer and the transcript cache', () => {
      seedWithRooms();
      useBuzzLocalCache.getState().removeChannel(viewer, 'room-b');
      const state = useBuzzLocalCache.getState();
      expect(state.channelLists[`${viewer}:workspace`]?.channels.map(({ id }) => id)).toEqual([
        'room-a',
      ]);
      expect(state.channels[channelCacheKey(viewer, 'room-b')]).toBeUndefined();
    });

    it('leaves other viewers and other channels untouched', () => {
      seedWithRooms();
      const now = Date.now();
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey: 'other-viewer',
        communityId: 'workspace',
        channels: [{ id: 'room-b', active: false, archived: true, title: 'Gone', updatedAt: now }],
        directMessages: [],
        workspaceMembers: [],
        communities: [],
        personalWorkspaceId: null,
        viewerIsAgent: false,
        canEditWorkspaceAvatar: false,
        updatedAt: now,
        lastAccessedAt: now,
      });

      useBuzzLocalCache.getState().removeChannel(viewer, 'room-b');

      const state = useBuzzLocalCache.getState();
      expect(state.channelLists[`other-viewer:workspace`]?.channels).toHaveLength(1);
      expect(state.channelLists[`${viewer}:workspace`]?.channels).toHaveLength(1);
    });

    it('is identity-stable when the channel is already absent', () => {
      seedWithRooms();
      const before = useBuzzLocalCache.getState().channelLists;
      useBuzzLocalCache.getState().removeChannel(viewer, 'room-never-existed');
      expect(useBuzzLocalCache.getState().channelLists).toBe(before);
    });
  });
});
