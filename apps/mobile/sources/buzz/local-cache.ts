import { MMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import type {
  Agent,
  ChannelMember,
  Community,
  CommunityMember,
  CommunityRole,
  DirectMessage,
  MergeTarget,
  PersonProfile,
} from '@beeline/buzz-client';
import { cornerStatusPrecedence, type CornerStatus, type CornerSummary } from '@/buzz/corners';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';
import { isRetiredAgentStateNotice } from './retired-agent-notices';
import { upsertChatMessages } from '@/sync/transport/buzz-event-projection';
import type { SessionSummary } from '@/sync/transport';

// v1 treated any stream event as if it were a conversational message. Its
// cursor can therefore outrun the preview and permanently retain old text.
const CACHE_VERSION = 2;
const CACHE_KEY = `buzz-local-cache-v${CACHE_VERSION}`;
export const MAX_CACHED_MESSAGES_PER_CHANNEL = 200;
export const MAX_CACHED_CHANNELS = 30;
const MAX_CACHED_LISTS = 12;
const MAX_CACHED_PROFILE_SCOPES = 12;
// MMKV is synchronous. A full snapshot can contain 30 Room transcripts, so it
// must never be serialized from a foreground interaction (send, mention, back,
// or list focus). We only flush the dirty snapshot once the app is backgrounded.

const storage = new MMKV({ id: 'buzz-local-cache' });

export type ChannelDisplayItem = SessionSummary & {
  archived?: boolean;
  parentChannelId?: string;
  corners?: CornerSummary[];
  latestMessage?: string;
  /** Timestamp/author of the previewed conversational message. `updatedAt`
   * tracks *any* event, so only this can drive an honest unread mark or an
   * attributed preview line. */
  latestMessageAt?: number;
  latestMessageAuthor?: string;
  participantCount?: number;
};

export type DirectMessageDisplayItem = {
  id: string;
  peerPubkey: string;
  peerName: string;
  peerKind: 'person' | 'agent';
  peerAgent?: Agent;
  avatarUrl?: string;
  latestMessage?: string;
  latestMessageAt?: number;
  updatedAt: number;
};

export type WorkspaceMemberDisplayItem = Omit<
  DirectMessageDisplayItem,
  'id' | 'latestMessage' | 'latestMessageAt' | 'updatedAt'
> & {
  /** Workspace role for a person entry; agents don't carry one here. */
  role?: CommunityRole;
};

/** The conversational-preview fields a message sync contributes to a channel
 * entry and to every list that shows that channel as a row. */
export type RoomSummaryPatch = {
  latestMessage?: string;
  latestMessageAt?: number;
  latestMessageId?: string;
  latestMessageAuthor?: string;
  latestEventAt?: number;
};

export type ChannelListCacheEntry = {
  viewerPubkey: string;
  communityId: string | null;
  channels: ChannelDisplayItem[];
  directMessages: DirectMessageDisplayItem[];
  workspaceMembers: WorkspaceMemberDisplayItem[];
  communities: Community[];
  personalWorkspaceId: string | null;
  viewerIsAgent: boolean;
  viewerAvatarUrl?: string;
  canEditWorkspaceAvatar: boolean;
  updatedAt: number;
  lastAccessedAt: number;
};

export type ChannelCacheEntry = {
  viewerPubkey: string;
  channelId: string;
  messages?: ChatDisplayMessage[];
  cursor?: number;
  /** True only after a complete initial history read, not merely a live event. */
  backfilled?: boolean;
  latestMessage?: string;
  /** Timestamp/id/author of the displayed conversational message, never a control event. */
  latestMessageAt?: number;
  latestMessageId?: string;
  latestMessageAuthor?: string;
  latestEventAt?: number;
  roomMembers?: ChannelMember[];
  availablePeople?: CommunityMember[];
  availableAgents?: Agent[];
  communityId?: string | null;
  parentChannelId?: string;
  directMessage?: DirectMessage | null;
  roomName?: string;
  archived?: boolean;
  mergeTarget?: MergeTarget | null;
  updatedAt: number;
  lastAccessedAt: number;
};

type PersistedBuzzCache = {
  activeViewerPubkey: string | null;
  activeListKeyByViewer: Record<string, string>;
  channelLists: Record<string, ChannelListCacheEntry>;
  channels: Record<string, ChannelCacheEntry>;
  profiles: Record<string, PersonProfile[]>;
};

type BuzzCacheState = PersistedBuzzCache & {
  setActiveViewer: (viewerPubkey: string) => void;
  setChannelList: (entry: ChannelListCacheEntry) => void;
  patchChannelList: (
    viewerPubkey: string,
    communityId: string | null,
    patch: Partial<ChannelListCacheEntry>,
  ) => void;
  patchChannel: (
    viewerPubkey: string,
    channelId: string,
    patch: Partial<ChannelCacheEntry>,
  ) => void;
  replaceMessages: (
    viewerPubkey: string,
    channelId: string,
    messages: ChatDisplayMessage[],
    cursor: number | undefined,
    summary?: RoomSummaryPatch,
  ) => void;
  upsertMessages: (
    viewerPubkey: string,
    channelId: string,
    messages: ChatDisplayMessage[],
    cursor?: number,
    summary?: RoomSummaryPatch,
  ) => void;
  updateMessages: (
    viewerPubkey: string,
    channelId: string,
    update: (messages: ChatDisplayMessage[]) => ChatDisplayMessage[],
  ) => void;
  /** Keep an already-listed room-list corner card's lifecycle and meaningful
   * event time current without waiting for a full list reload. Never fabricates
   * a new corner entry and never walks status or activity backwards. */
  patchCornerStatus: (
    viewerPubkey: string,
    roomId: string,
    corner: { subchannelId: string; status: CornerStatus; lastActivityAt?: number },
  ) => void;
  replaceProfiles: (viewerPubkey: string, communityId: string, profiles: PersonProfile[]) => void;
  clear: () => void;
};

const emptyCache = (): PersistedBuzzCache => ({
  activeViewerPubkey: null,
  activeListKeyByViewer: {},
  channelLists: {},
  channels: {},
  profiles: {},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOfEntries(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => isRecord(entry)),
  ) as Record<string, Record<string, unknown>>;
}

function recordOfArrays(value: unknown): Record<string, unknown[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => Array.isArray(entry)),
  ) as Record<string, unknown[]>;
}

function restoreChannelLists(value: unknown): Record<string, ChannelListCacheEntry> {
  return Object.fromEntries(
    Object.entries(recordOfEntries(value)).map(([key, entry]) => [
      key,
      {
        ...entry,
        channels: Array.isArray(entry.channels) ? entry.channels : [],
        directMessages: Array.isArray(entry.directMessages) ? entry.directMessages : [],
        workspaceMembers: Array.isArray(entry.workspaceMembers) ? entry.workspaceMembers : [],
        communities: Array.isArray(entry.communities) ? entry.communities : [],
      } as ChannelListCacheEntry,
    ]),
  );
}

function restoreChannels(value: unknown): Record<string, ChannelCacheEntry> {
  return Object.fromEntries(
    Object.entries(recordOfEntries(value)).map(([key, entry]) => {
      const { messages, roomMembers, availablePeople, availableAgents, ...rest } = entry;
      // A transcript cached by an older build still holds the retired daemon
      // state notices (`retired-agent-notices.ts`). The projection drops them
      // for every event that arrives from now on, but the cache is what paints
      // the first frame, so the wall would survive here until a revalidation
      // that never rewrites an already-stored row.
      // The same floor clears any stale `isNew` entrance-animation flag a
      // pre-strip build persisted: the flag is transient "arrived this
      // session" state (`message-reveal.ts`), and a restored one replays the
      // new-message animation on old messages at first paint.
      const kept = Array.isArray(messages)
        ? messages
            .filter((message) => !isRetiredAgentStateNotice(message?.text ?? ''))
            .map(({ isNew: _staleNewFlag, ...message }) => message)
        : undefined;
      return [
        key,
        {
          ...rest,
          ...(kept ? { messages: kept } : {}),
          ...(Array.isArray(roomMembers) ? { roomMembers } : {}),
          ...(Array.isArray(availablePeople) ? { availablePeople } : {}),
          ...(Array.isArray(availableAgents) ? { availableAgents } : {}),
        } as ChannelCacheEntry,
      ];
    }),
  );
}

export function channelListCacheKey(viewerPubkey: string, communityId: string | null): string {
  return `${viewerPubkey}:${communityId ?? 'standalone'}`;
}

export function channelCacheKey(viewerPubkey: string, channelId: string): string {
  return `${viewerPubkey}:${channelId}`;
}

export function profileCacheKey(viewerPubkey: string, communityId: string): string {
  return `${viewerPubkey}:${communityId}`;
}

function trimRecord<T extends { lastAccessedAt: number }>(
  values: Record<string, T>,
  maximum: number,
): Record<string, T> {
  const entries = Object.entries(values);
  if (entries.length <= maximum) return values;
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => b.lastAccessedAt - a.lastAccessedAt).slice(0, maximum),
  );
}

function loadCache(): PersistedBuzzCache {
  try {
    const serialized = storage.getString(CACHE_KEY);
    if (!serialized) return emptyCache();
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) throw new Error('Invalid Buzz local cache');
    return {
      activeViewerPubkey: typeof parsed.activeViewerPubkey === 'string' ? parsed.activeViewerPubkey : null,
      activeListKeyByViewer: Object.fromEntries(
        Object.entries(parsed.activeListKeyByViewer ?? {}).filter(
          ([, value]) => typeof value === 'string',
        ),
      ),
      channelLists: restoreChannelLists(parsed.channelLists),
      channels: restoreChannels(parsed.channels),
      profiles: recordOfArrays(parsed.profiles) as Record<string, PersonProfile[]>,
    };
  } catch {
    try {
      storage.delete(CACHE_KEY);
    } catch {
      // A damaged or unavailable cache must never prevent the app from booting.
    }
    return emptyCache();
  }
}

function persisted(state: BuzzCacheState): PersistedBuzzCache {
  return {
    activeViewerPubkey: state.activeViewerPubkey,
    activeListKeyByViewer: state.activeListKeyByViewer,
    channelLists: state.channelLists,
    channels: Object.fromEntries(
      Object.entries(state.channels).map(([key, entry]) => [
        key,
        {
          ...entry,
          // Optimistic rows are replaced by their confirmed event, and
          // `isNew` is a transient "arrived while watching" signal owned by
          // `message-reveal.ts` — persisting either replays the entrance
          // animation on old messages after hydration.
          messages: entry.messages
            ?.filter((message) => !message.id.startsWith('optimistic-'))
            .map(({ isNew: _transient, ...message }) => message),
        },
      ]),
    ),
    profiles: state.profiles,
  };
}

function boundedMessages(messages: ChatDisplayMessage[]): ChatDisplayMessage[] {
  return messages.slice(-MAX_CACHED_MESSAGES_PER_CHANNEL);
}

/** Keep warm previews and Room enrichment while fresh structural basics load. */
export function mergeChannelBasicsWithCache(
  basics: ChannelDisplayItem[],
  cached: ChannelDisplayItem[] = [],
): ChannelDisplayItem[] {
  const cachedById = new Map(cached.map((channel) => [channel.id, channel]));
  return basics.map((channel) => {
    const existing = cachedById.get(channel.id);
    if (!existing) return channel;
    const updatedAt = Math.max(
      channel.updatedAt ?? channel.createdAt ?? 0,
      existing.updatedAt ?? existing.createdAt ?? 0,
    );
    return {
      ...channel,
      ...(existing.corners !== undefined ? { corners: existing.corners } : {}),
      ...(existing.latestMessage !== undefined ? { latestMessage: existing.latestMessage } : {}),
      ...(existing.latestMessageAt !== undefined
        ? { latestMessageAt: existing.latestMessageAt }
        : {}),
      ...(existing.latestMessageAuthor !== undefined
        ? { latestMessageAuthor: existing.latestMessageAuthor }
        : {}),
      ...(existing.participantCount !== undefined
        ? { participantCount: existing.participantCount }
        : {}),
      ...(updatedAt > 0 ? { updatedAt } : {}),
    };
  });
}

/**
 * Room-list previews, updated in place.
 *
 * Every returned object is identity-preserved when its content did not
 * actually change. A live agent turn writes one of these per delivered batch,
 * and the room list stays subscribed to this store even while it is covered
 * by a Room — unconditionally rebuilding the map made every one of those
 * writes re-render and re-sort the whole list for no visible difference.
 */
function updateListSummaries(
  lists: Record<string, ChannelListCacheEntry>,
  viewerPubkey: string,
  channelId: string,
  summary?: RoomSummaryPatch,
): Record<string, ChannelListCacheEntry> {
  if (!summary?.latestMessage) return lists;
  const updatedAt = summary.latestEventAt ?? 0;
  // The preview fields the list rows read. Reference identity is preserved
  // whenever every one of them already matches, so a live turn that changes
  // nothing visible does not re-render or re-sort the list.
  const preview = {
    latestMessage: summary.latestMessage,
    latestMessageAt: summary.latestMessageAt,
    updatedAt,
  };
  let listsChanged = false;
  const next = Object.fromEntries(
    Object.entries(lists).map(([key, entry]) => {
      if (entry.viewerPubkey !== viewerPubkey) return [key, entry];
      let entryChanged = false;
      const channels = entry.channels.map((channel) => {
        if (
          channel.id !== channelId ||
          (channel.latestMessage === preview.latestMessage &&
            channel.latestMessageAt === preview.latestMessageAt &&
            channel.latestMessageAuthor === summary.latestMessageAuthor &&
            channel.updatedAt === updatedAt)
        ) {
          return channel;
        }
        entryChanged = true;
        return { ...channel, ...preview, latestMessageAuthor: summary.latestMessageAuthor };
      });
      const directMessages = entry.directMessages.map((dm) => {
        if (
          dm.id !== channelId ||
          (dm.latestMessage === preview.latestMessage &&
            dm.latestMessageAt === preview.latestMessageAt &&
            dm.updatedAt === updatedAt)
        ) {
          return dm;
        }
        entryChanged = true;
        return { ...dm, ...preview };
      });
      if (!entryChanged) return [key, entry];
      listsChanged = true;
      return [
        key,
        {
          ...entry,
          channels: [...channels].sort(
            (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
          ),
          directMessages: [...directMessages].sort(
            (a, b) => b.updatedAt - a.updatedAt || a.peerName.localeCompare(b.peerName),
          ),
        },
      ];
    }),
  );
  return listsChanged ? next : lists;
}

/**
 * The room-list corner array (`ChannelDisplayItem.corners`) is fetched once
 * per `channels.tsx` load/focus via `listSubchannelLifecycle`; a corner that
 * gets archived while that snapshot is still resident (e.g. the app stays
 * foregrounded) would otherwise keep showing its pre-archive status until the
 * next full reload. Only ever updates an already-listed corner in place —
 * never fabricates one from a bare status signal — and never walks its
 * status or activity time backwards (same precedence guard used for chat
 * message cards).
 */
function updateListCornerStatus(
  lists: Record<string, ChannelListCacheEntry>,
  viewerPubkey: string,
  roomId: string,
  corner: { subchannelId: string; status: CornerStatus; lastActivityAt?: number },
): Record<string, ChannelListCacheEntry> {
  let listsChanged = false;
  const next = Object.fromEntries(
    Object.entries(lists).map(([key, entry]) => {
      if (entry.viewerPubkey !== viewerPubkey) return [key, entry];
      let entryChanged = false;
      const channels = entry.channels.map((channel) => {
        if (channel.id !== roomId || !channel.corners) return channel;
        let changed = false;
        const corners = channel.corners.map((existing) => {
          if (
            existing.id !== corner.subchannelId ||
            cornerStatusPrecedence(corner.status) < cornerStatusPrecedence(existing.status)
          ) {
            return existing;
          }
          const statusChanged = existing.status !== corner.status;
          const activityChanged =
            corner.lastActivityAt !== undefined &&
            corner.lastActivityAt > (existing.lastActivityAt ?? existing.createdAt ?? 0);
          if (!statusChanged && !activityChanged) return existing;
          changed = true;
          return {
            ...existing,
            status: corner.status,
            ...(activityChanged ? { lastActivityAt: corner.lastActivityAt } : {}),
          };
        });
        if (!changed) return channel;
        entryChanged = true;
        return { ...channel, corners };
      });
      if (!entryChanged) return [key, entry];
      listsChanged = true;
      return [key, { ...entry, channels }];
    }),
  );
  // Identity-preserved when nothing moved: this runs once per `.corner`
  // signal on every live batch and every revalidation, and a new map object
  // re-renders the room list whether or not a status actually changed.
  return listsChanged ? next : lists;
}

const initial = loadCache();

export const useBuzzLocalCache = create<BuzzCacheState>()((set) => ({
  ...initial,
  setActiveViewer: (viewerPubkey) => set({ activeViewerPubkey: viewerPubkey }),
  setChannelList: (entry) =>
    set((state) => {
      const key = channelListCacheKey(entry.viewerPubkey, entry.communityId);
      return {
        activeViewerPubkey: entry.viewerPubkey,
        activeListKeyByViewer: { ...state.activeListKeyByViewer, [entry.viewerPubkey]: key },
        channelLists: trimRecord({ ...state.channelLists, [key]: entry }, MAX_CACHED_LISTS),
      };
    }),
  patchChannelList: (viewerPubkey, communityId, patch) =>
    set((state) => {
      const key = channelListCacheKey(viewerPubkey, communityId);
      const current = state.channelLists[key];
      if (!current) return state;
      const now = Date.now();
      return {
        channelLists: {
          ...state.channelLists,
          [key]: { ...current, ...patch, updatedAt: now, lastAccessedAt: now },
        },
      };
    }),
  patchCornerStatus: (viewerPubkey, roomId, corner) =>
    set((state) => {
      const channelLists = updateListCornerStatus(
        state.channelLists,
        viewerPubkey,
        roomId,
        corner,
      );
      // No status moved: skip the write entirely rather than notifying every
      // subscriber with an identical snapshot.
      return channelLists === state.channelLists ? state : { channelLists };
    }),
  patchChannel: (viewerPubkey, channelId, patch) =>
    set((state) => {
      const key = channelCacheKey(viewerPubkey, channelId);
      const now = Date.now();
      const current = state.channels[key] ?? {
        viewerPubkey,
        channelId,
        updatedAt: now,
        lastAccessedAt: now,
      };
      return {
        channels: trimRecord(
          {
            ...state.channels,
            [key]: { ...current, ...patch, updatedAt: now, lastAccessedAt: now },
          },
          MAX_CACHED_CHANNELS,
        ),
      };
    }),
  replaceMessages: (viewerPubkey, channelId, messages, cursor, summary) =>
    set((state) => {
      const key = channelCacheKey(viewerPubkey, channelId);
      const now = Date.now();
      const current = state.channels[key] ?? {
        viewerPubkey,
        channelId,
        updatedAt: now,
        lastAccessedAt: now,
      };
      return {
        channelLists: updateListSummaries(state.channelLists, viewerPubkey, channelId, summary),
        channels: trimRecord(
          {
            ...state.channels,
            [key]: {
              ...current,
              ...summary,
              messages: boundedMessages(messages),
              cursor,
              backfilled: true,
              updatedAt: now,
              lastAccessedAt: now,
            },
          },
          MAX_CACHED_CHANNELS,
        ),
      };
    }),
  upsertMessages: (viewerPubkey, channelId, messages, cursor, summary) =>
    set((state) => {
      const key = channelCacheKey(viewerPubkey, channelId);
      const now = Date.now();
      const current = state.channels[key] ?? {
        viewerPubkey,
        channelId,
        updatedAt: now,
        lastAccessedAt: now,
      };
      return {
        channelLists: updateListSummaries(state.channelLists, viewerPubkey, channelId, summary),
        channels: trimRecord(
          {
            ...state.channels,
            [key]: {
              ...current,
              ...summary,
              messages: boundedMessages(upsertChatMessages(current.messages ?? [], messages)),
              cursor: Math.max(current.cursor ?? 0, cursor ?? 0) || undefined,
              updatedAt: now,
              lastAccessedAt: now,
            },
          },
          MAX_CACHED_CHANNELS,
        ),
      };
    }),
  updateMessages: (viewerPubkey, channelId, update) =>
    set((state) => {
      const key = channelCacheKey(viewerPubkey, channelId);
      const current = state.channels[key];
      if (!current?.messages) return state;
      const now = Date.now();
      return {
        channels: {
          ...state.channels,
          [key]: {
            ...current,
            messages: boundedMessages(update(current.messages)),
            updatedAt: now,
            lastAccessedAt: now,
          },
        },
      };
    }),
  replaceProfiles: (viewerPubkey, communityId, profiles) =>
    set((state) => {
      const key = profileCacheKey(viewerPubkey, communityId);
      const updated = { ...state.profiles, [key]: profiles };
      const keys = Object.keys(updated);
      if (keys.length <= MAX_CACHED_PROFILE_SCOPES) return { profiles: updated };
      const retained = keys
        .filter((candidate) => candidate !== key)
        .slice(1 - MAX_CACHED_PROFILE_SCOPES);
      return {
        profiles: Object.fromEntries(
          [...retained, key].map((candidate) => [candidate, updated[candidate]]),
        ),
      };
    }),
  clear: () => set(emptyCache()),
}));

let cacheDirty = false;

/**
 * Write the warm-start cache only after the app leaves the foreground.
 *
 * This is intentionally exported for the root AppState owner instead of
 * subscribing to AppState here: cache mutations stay synchronous in-memory,
 * while the costly JSON/MMKV boundary is kept out of every UI turn.
 */
export function flushBuzzLocalCacheForBackground(): void {
  if (!cacheDirty) return;
  cacheDirty = false;
  storage.set(CACHE_KEY, JSON.stringify(persisted(useBuzzLocalCache.getState())));
}

useBuzzLocalCache.subscribe((state) => {
  // Deliberately don't serialize `state` here. It can contain thousands of
  // messages, and this subscription runs inside the caller's UI turn.
  void state;
  cacheDirty = true;
});

export function selectChannelList(
  state: BuzzCacheState,
  viewerPubkey: string | null,
  requestedCommunity?: string,
): ChannelListCacheEntry | undefined {
  if (!viewerPubkey) return undefined;
  if (requestedCommunity) {
    return state.channelLists[channelListCacheKey(viewerPubkey, requestedCommunity)];
  }
  const activeKey = state.activeListKeyByViewer[viewerPubkey];
  return activeKey ? state.channelLists[activeKey] : undefined;
}

export function getCachedChannel(
  viewerPubkey: string,
  channelId: string,
): ChannelCacheEntry | undefined {
  return useBuzzLocalCache.getState().channels[channelCacheKey(viewerPubkey, channelId)];
}

export function setActiveBuzzCacheViewer(viewerPubkey: string): void {
  useBuzzLocalCache.getState().setActiveViewer(viewerPubkey);
}

export function clearBuzzLocalCache(): void {
  useBuzzLocalCache.getState().clear();
  cacheDirty = false;
  storage.delete(CACHE_KEY);
}
