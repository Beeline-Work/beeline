import { MMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import { guardReadModelBoot, snapshotForPersistence } from '@beeline/buzz-client';
import type {
  Agent,
  Community,
  CommunityMember,
  CommunityRole,
  DirectMessage,
  MergeTarget,
  PersonProfile,
  RoomRepositoryResolution,
  RoomSnapshot,
  WorkspaceSnapshot,
} from '@beeline/buzz-client';
import type { CornerSummary } from '@/buzz/corners';
import type { SessionSummary } from '@/sync/transport';

// v1 treated any stream event as if it were a conversational message. Its
// cursor can therefore outrun the preview and permanently retain old text.
export const BUZZ_CACHE_VERSION = 3;
export const BUZZ_CACHE_KEY = `buzz-local-cache-v${BUZZ_CACHE_VERSION}`;
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
  /** Direct Corner-open facts resolved during Room-list hydration. Lifecycle
   * remains the canonical state; these facts only prevent the list from
   * advertising work that the destination screen already disproves. */
  cornerOpenTruth?: Record<string, { archived?: boolean; mergeable?: boolean }>;
  latestMessage?: string;
  /** Timestamp/author of the previewed conversational message. `updatedAt`
   * tracks *any* event, so only this can drive an honest unread mark or an
   * attributed preview line. */
  latestMessageAt?: number;
  latestMessageAuthor?: string;
  participantCount?: number;
  /** Human-facing name of the repository bound to this Room, when one resolves. */
  repoName?: string;
  /** Model id one of the Room's agents publishes in its catalog, if any. */
  modelLabel?: string;
  /** A successful local create that the relay's list projection has not yet
   * returned. Snapshot swaps preserve this row until that exact Room appears
   * in a later structural read. */
  awaitingListReconciliation?: true;
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
  /** The only persisted Room history. Render DTOs are always selected at read time. */
  snapshot?: WorkspaceSnapshot;
  /** A corrupt normalized cache is held and rendered loudly until relay rebuild succeeds. */
  integrityHalt?: string;
  cursor?: number;
  /** True only after a complete initial history read, not merely a live event. */
  backfilled?: boolean;
  latestMessage?: string;
  /** Timestamp/id/author of the displayed conversational message, never a control event. */
  latestMessageAt?: number;
  latestMessageId?: string;
  latestMessageAuthor?: string;
  latestEventAt?: number;
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

export type PersistedBuzzCache = {
  bootIntegrityHalt: string | null;
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
  /** Commit an authoritatively successful Room create without waiting for a
   * potentially stale relay list projection. In-memory only; MMKV remains on
   * the background flush boundary. */
  upsertConfirmedChannel: (
    viewerPubkey: string,
    communityId: string | null,
    channel: ChannelDisplayItem,
  ) => void;
  patchChannel: (
    viewerPubkey: string,
    channelId: string,
    patch: Partial<ChannelCacheEntry>,
  ) => void;
  /** Move landed work in the Room index without creating unread/message copy. */
  bumpChannelRecency: (viewerPubkey: string, channelId: string, timestamp: number) => void;
  replaceSnapshot: (
    viewerPubkey: string,
    channelId: string,
    snapshot: WorkspaceSnapshot,
    cursor: number | undefined,
    summary?: RoomSummaryPatch,
  ) => void;
  updateSnapshot: (
    viewerPubkey: string,
    channelId: string,
    update: (snapshot: WorkspaceSnapshot | undefined) => WorkspaceSnapshot,
    cursor?: number,
    summary?: RoomSummaryPatch,
  ) => void;
  replaceProfiles: (viewerPubkey: string, communityId: string, profiles: PersonProfile[]) => void;
  /** Replace one viewer's cached Workspace set after a complete authoritative discovery. */
  reconcileWorkspaceSet: (
    viewerPubkey: string,
    workspaces: readonly Community[],
    activeWorkspaceId: string | null,
  ) => void;
  /** Purge a deleted/left Room from every cached list row of this viewer and
   * drop its transcript cache. Pairs with the durable tombstone in
   * `removed-rooms.ts`: the purge makes removal immediate, the tombstone is
   * what keeps a later relay refresh from re-materializing the row. */
  removeChannel: (viewerPubkey: string, channelId: string) => void;
  clear: () => void;
};

const emptyCache = (): PersistedBuzzCache => ({
  bootIntegrityHalt: null,
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
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => isRecord(entry))) as Record<
    string,
    Record<string, unknown>
  >;
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
        channels: Array.isArray(entry.channels)
          ? entry.channels.map((channel) => {
              if (!isRecord(channel)) return channel;
              const { corners: _presentationCache, ...normalized } = channel;
              return normalized;
            })
          : [],
        directMessages: Array.isArray(entry.directMessages) ? entry.directMessages : [],
        workspaceMembers: Array.isArray(entry.workspaceMembers) ? entry.workspaceMembers : [],
        communities: Array.isArray(entry.communities) ? entry.communities : [],
      } as ChannelListCacheEntry,
    ]),
  );
}

/**
 * Repair the cached thread index of a restored snapshot.
 *
 * Snapshots persisted by earlier builds can carry stale `reply.rootId` values
 * (a mid-thread ancestor instead of the true root) whenever history was
 * parsed from a truncated or incremental window. The stored parent links are
 * still trustworthy — an event's `reply.eventId` comes verbatim from its raw
 * NIP-10 `reply` tag — so the true root is re-derived by climbing parent
 * links inside the journal before any composer reply can sign ancestry from
 * the stale value (which the relay refuses with `root tag does not match
 * thread ancestry`).
 *
 * Only chains that climb to a verified top-level message are rewritten; a
 * chain whose top falls outside the journal keeps its existing claims, and a
 * healthy snapshot returns byte-identical so warm restores never churn.
 */
export function repairCachedThreadRoots(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  let changed = false;
  const rooms = Object.fromEntries(
    Object.entries(snapshot.rooms).map(([channelId, room]) => {
      const repairedJournal = repairedThreadJournal(room.eventJournal);
      if (repairedJournal === room.eventJournal) return [channelId, room];
      changed = true;
      return [channelId, { ...room, eventJournal: repairedJournal }];
    }),
  );
  return changed ? { ...snapshot, rooms } : snapshot;
}

type ThreadedJournalMessage = {
  eventId: string;
  reply?: { eventId?: unknown; rootId?: unknown };
};

function threadedMessage(event: unknown): ThreadedJournalMessage | undefined {
  if (
    event !== null &&
    typeof event === 'object' &&
    ((event as { type?: unknown }).type === 'human-message' ||
      (event as { type?: unknown }).type === 'agent-message')
  ) {
    return event as ThreadedJournalMessage;
  }
  return undefined;
}

function replyParentOf(event: ThreadedJournalMessage): string | undefined {
  const reply = event.reply;
  return typeof reply?.eventId === 'string' ? reply.eventId : undefined;
}

function repairedThreadJournal(
  journal: RoomSnapshot['eventJournal'],
): RoomSnapshot['eventJournal'] {
  // Memoized verdict per event id: the verified thread-root event id, or null
  // when that id's chain cannot be verified inside this journal.
  const verdicts = new Map<string, string | null>();
  let next: RoomSnapshot['eventJournal'] | null = null;

  const resolveVerifiedRoot = (startId: string): string | null => {
    const memo = verdicts.get(startId);
    if (memo !== undefined) return memo;
    const path: string[] = [];
    let verdict: string | null = null;
    let cursor = startId;
    while (true) {
      const cached = verdicts.get(cursor);
      if (cached !== undefined) {
        verdict = cached;
        break;
      }
      if (path.includes(cursor)) break; // cycle: unverifiable
      path.push(cursor);
      const event = threadedMessage(journal[cursor]);
      if (!event) break; // non-message or missing ancestor: unverifiable
      const parent = replyParentOf(event);
      if (!parent) {
        verdict = cursor; // genuine top-level message
        break;
      }
      if (!journal[parent] || !threadedMessage(journal[parent])) break;
      cursor = parent;
    }
    for (const id of path) verdicts.set(id, verdict);
    return verdict;
  };

  for (const eventId of Object.keys(journal)) {
    const event = threadedMessage(journal[eventId]);
    if (!event || !replyParentOf(event)) continue;
    const root = resolveVerifiedRoot(eventId);
    if (root === null || root === eventId) continue;
    if (event.reply?.rootId !== root) {
      next = {
        ...(next ?? journal),
        [eventId]: { ...event, reply: { ...event.reply!, rootId: root } },
      } as RoomSnapshot['eventJournal'];
    }
  }
  return next ?? journal;
}

function restoreChannels(value: unknown): Record<string, ChannelCacheEntry> {
  return Object.fromEntries(
    Object.entries(recordOfEntries(value)).map(([key, entry]) => {
      const { snapshot, availablePeople, availableAgents, ...rest } = entry;
      const guarded = snapshot === undefined ? undefined : guardReadModelBoot(snapshot);
      return [
        key,
        {
          ...rest,
          ...(guarded?.status === 'ready'
            ? { snapshot: repairCachedThreadRoots(guarded.snapshot) }
            : {}),
          ...(guarded?.status === 'integrity-halt' ? { integrityHalt: guarded.diagnostic } : {}),
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

export function decodePersistedBuzzCache(serialized: string | undefined): PersistedBuzzCache {
  try {
    if (!serialized) return emptyCache();
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) throw new Error('Invalid Buzz local cache');
    return {
      bootIntegrityHalt: null,
      activeViewerPubkey:
        typeof parsed.activeViewerPubkey === 'string' ? parsed.activeViewerPubkey : null,
      activeListKeyByViewer: Object.fromEntries(
        Object.entries(parsed.activeListKeyByViewer ?? {}).filter(
          ([, value]) => typeof value === 'string',
        ),
      ),
      channelLists: restoreChannelLists(parsed.channelLists),
      channels: restoreChannels(parsed.channels),
      profiles: recordOfArrays(parsed.profiles) as Record<string, PersonProfile[]>,
    };
  } catch (error) {
    return {
      ...emptyCache(),
      bootIntegrityHalt: `The normalized read-model cache could not be decoded: ${String(error)}`,
    };
  }
}

function loadCache(): PersistedBuzzCache {
  return decodePersistedBuzzCache(storage.getString(BUZZ_CACHE_KEY));
}

function persisted(state: BuzzCacheState): PersistedBuzzCache {
  return {
    bootIntegrityHalt: state.bootIntegrityHalt,
    activeViewerPubkey: state.activeViewerPubkey,
    activeListKeyByViewer: state.activeListKeyByViewer,
    channelLists: state.channelLists,
    channels: Object.fromEntries(
      Object.entries(state.channels).map(([key, channel]) => [
        key,
        channel.snapshot
          ? { ...channel, snapshot: snapshotForPersistence(channel.snapshot) }
          : channel,
      ]),
    ),
    profiles: state.profiles,
  };
}

/**
 * Field-wise repo-name merge for the Room list's warm refresh.
 *
 * A warm update that could not establish the binding must NOT clobber a name
 * a previous pass already resolved (same principle as the isNew fix in
 * `upsertChatMessages`): the repo tag rendered on first paint and then
 * vanished seconds later because the refresh path collapsed "read failed"
 * and "config exists but no admin authorizes it" into "no repository".
 * Only a definitive relay answer may change the row: `repository` carries
 * the (possibly new) name, `none` genuinely clears it, and `unverified` or
 * a failed read (`resolution === undefined`) keeps the previous value.
 */
export function mergedRepoName(
  previous: string | undefined,
  resolution: RoomRepositoryResolution | undefined,
): string | undefined {
  if (!resolution) return previous;
  if (resolution.kind === 'repository') return resolution.repository.binding.name ?? undefined;
  if (resolution.kind === 'none') return undefined;
  return previous;
}

/** Keep warm previews and Room enrichment while fresh structural basics load. */
export function mergeChannelBasicsWithCache(
  basics: ChannelDisplayItem[],
  cached: ChannelDisplayItem[] = [],
): ChannelDisplayItem[] {
  const cachedById = new Map(cached.map((channel) => [channel.id, channel]));
  const basicIds = new Set(basics.map((channel) => channel.id));
  const reconciled = basics.map((channel) => {
    const existing = cachedById.get(channel.id);
    if (!existing) return channel;
    const updatedAt = Math.max(
      channel.updatedAt ?? channel.createdAt ?? 0,
      existing.updatedAt ?? existing.createdAt ?? 0,
    );
    return {
      ...channel,
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
      // Enrichment the basics loader never fetches: a warm basics upsert
      // that lacks these must not strip what the last full enrich resolved.
      // Fill the gap only — a fresh value (if one ever appears) still wins.
      ...(channel.repoName === undefined && existing.repoName !== undefined
        ? { repoName: existing.repoName }
        : {}),
      ...(channel.modelLabel === undefined && existing.modelLabel !== undefined
        ? { modelLabel: existing.modelLabel }
        : {}),
      ...(channel.cornerOpenTruth === undefined && existing.cornerOpenTruth !== undefined
        ? { cornerOpenTruth: existing.cornerOpenTruth }
        : {}),
      ...(updatedAt > 0 ? { updatedAt } : {}),
    };
  });
  for (const channel of cached) {
    if (channel.awaitingListReconciliation && !basicIds.has(channel.id)) {
      reconciled.push(channel);
    }
  }
  return reconciled.sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
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

const initial = loadCache();

export const useBuzzLocalCache = create<BuzzCacheState>()((set) => ({
  ...initial,
  setActiveViewer: (viewerPubkey) => set({ activeViewerPubkey: viewerPubkey }),
  setChannelList: (entry) =>
    set((state) => {
      const key = channelListCacheKey(entry.viewerPubkey, entry.communityId);
      const normalizedEntry = {
        ...entry,
        channels: entry.channels.map(({ corners: _presentationCache, ...channel }) => channel),
      };
      return {
        activeViewerPubkey: entry.viewerPubkey,
        activeListKeyByViewer: { ...state.activeListKeyByViewer, [entry.viewerPubkey]: key },
        channelLists: trimRecord(
          { ...state.channelLists, [key]: normalizedEntry },
          MAX_CACHED_LISTS,
        ),
      };
    }),
  patchChannelList: (viewerPubkey, communityId, patch) =>
    set((state) => {
      const key = channelListCacheKey(viewerPubkey, communityId);
      const current = state.channelLists[key];
      if (!current) return state;
      const now = Date.now();
      const normalizedPatch = patch.channels
        ? {
            ...patch,
            channels: patch.channels.map(({ corners: _presentationCache, ...channel }) => channel),
          }
        : patch;
      return {
        channelLists: {
          ...state.channelLists,
          [key]: { ...current, ...normalizedPatch, updatedAt: now, lastAccessedAt: now },
        },
      };
    }),
  upsertConfirmedChannel: (viewerPubkey, communityId, channel) =>
    set((state) => {
      const key = channelListCacheKey(viewerPubkey, communityId);
      const current = state.channelLists[key];
      if (!current) return state;
      const now = Date.now();
      const { corners: _presentationCache, ...confirmed } = channel;
      const channels = [
        { ...confirmed, awaitingListReconciliation: true as const },
        ...current.channels.filter((candidate) => candidate.id !== channel.id),
      ].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
      return {
        channelLists: {
          ...state.channelLists,
          [key]: { ...current, channels, updatedAt: now, lastAccessedAt: now },
        },
      };
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
  bumpChannelRecency: (viewerPubkey, channelId, timestamp) =>
    set((state) => {
      let listsChanged = false;
      const channelLists = Object.fromEntries(
        Object.entries(state.channelLists).map(([key, entry]) => {
          if (entry.viewerPubkey !== viewerPubkey) return [key, entry];
          let entryChanged = false;
          const channels = entry.channels.map((channel) => {
            if (channel.id !== channelId || (channel.updatedAt ?? 0) >= timestamp) return channel;
            entryChanged = true;
            return { ...channel, updatedAt: timestamp };
          });
          if (!entryChanged) return [key, entry];
          listsChanged = true;
          return [
            key,
            {
              ...entry,
              channels: channels.sort(
                (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
              ),
            },
          ];
        }),
      );
      return listsChanged ? { channelLists } : state;
    }),
  replaceSnapshot: (viewerPubkey, channelId, snapshot, cursor, summary) =>
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
              snapshot,
              integrityHalt: undefined,
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
  updateSnapshot: (viewerPubkey, channelId, update, cursor, summary) =>
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
              snapshot: update(current.snapshot),
              integrityHalt: undefined,
              cursor: Math.max(current.cursor ?? 0, cursor ?? 0) || undefined,
              updatedAt: now,
              lastAccessedAt: now,
            },
          },
          MAX_CACHED_CHANNELS,
        ),
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
  reconcileWorkspaceSet: (viewerPubkey, workspaces, activeWorkspaceId) =>
    set((state) => {
      const confirmedIds = new Set(workspaces.map((workspace) => workspace.communityId));
      const staleWorkspaceIds = new Set<string>();
      const removedRoomIds = new Set<string>();
      for (const entry of Object.values(state.channelLists)) {
        if (entry.viewerPubkey !== viewerPubkey) continue;
        for (const workspace of entry.communities) {
          if (!confirmedIds.has(workspace.communityId)) {
            staleWorkspaceIds.add(workspace.communityId);
          }
        }
        if (entry.communityId && !confirmedIds.has(entry.communityId)) {
          staleWorkspaceIds.add(entry.communityId);
          for (const channel of entry.channels) removedRoomIds.add(channel.id);
        }
      }

      const channelLists = Object.fromEntries(
        Object.entries(state.channelLists).flatMap(([key, entry]) => {
          if (
            entry.viewerPubkey === viewerPubkey &&
            entry.communityId &&
            !confirmedIds.has(entry.communityId)
          ) {
            return [];
          }
          if (entry.viewerPubkey !== viewerPubkey) return [[key, entry]];
          return [
            [
              key,
              {
                ...entry,
                communities: [...workspaces],
                personalWorkspaceId:
                  entry.personalWorkspaceId && confirmedIds.has(entry.personalWorkspaceId)
                    ? entry.personalWorkspaceId
                    : null,
              },
            ],
          ];
        }),
      ) as Record<string, ChannelListCacheEntry>;
      const activeKey = activeWorkspaceId
        ? channelListCacheKey(viewerPubkey, activeWorkspaceId)
        : null;
      if (activeKey && !channelLists[activeKey]) {
        const template =
          state.channelLists[state.activeListKeyByViewer[viewerPubkey] ?? ''] ??
          Object.values(state.channelLists).find((entry) => entry.viewerPubkey === viewerPubkey);
        if (template) {
          const now = Date.now();
          channelLists[activeKey] = {
            ...template,
            communityId: activeWorkspaceId,
            channels: [],
            directMessages: [],
            workspaceMembers: [],
            communities: [...workspaces],
            personalWorkspaceId:
              template.personalWorkspaceId && confirmedIds.has(template.personalWorkspaceId)
                ? template.personalWorkspaceId
                : null,
            updatedAt: now,
            lastAccessedAt: now,
          };
        }
      }
      const channels = Object.fromEntries(
        Object.entries(state.channels).filter(([, channel]) => {
          if (channel.viewerPubkey !== viewerPubkey) return true;
          if (channel.communityId) return confirmedIds.has(channel.communityId);
          return !removedRoomIds.has(channel.channelId);
        }),
      );
      const profiles = Object.fromEntries(
        Object.entries(state.profiles).filter(([key]) => {
          for (const workspaceId of staleWorkspaceIds) {
            if (key === profileCacheKey(viewerPubkey, workspaceId)) return false;
          }
          return true;
        }),
      );
      const activeListKeyByViewer = { ...state.activeListKeyByViewer };
      if (activeKey && channelLists[activeKey]) activeListKeyByViewer[viewerPubkey] = activeKey;
      else delete activeListKeyByViewer[viewerPubkey];

      return { channelLists, channels, profiles, activeListKeyByViewer };
    }),
  removeChannel: (viewerPubkey, channelId) =>
    set((state) => {
      let listsChanged = false;
      const channelLists = Object.fromEntries(
        Object.entries(state.channelLists).map(([key, entry]) => {
          if (entry.viewerPubkey !== viewerPubkey) return [key, entry];
          const channels = entry.channels.filter((channel) => channel.id !== channelId);
          if (channels.length === entry.channels.length) return [key, entry];
          listsChanged = true;
          return [key, { ...entry, channels }];
        }),
      );
      const channelKey = channelCacheKey(viewerPubkey, channelId);
      if (!listsChanged && !state.channels[channelKey]) return state;
      const channels = { ...state.channels };
      delete channels[channelKey];
      return listsChanged ? { channelLists, channels } : { channels };
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
  storage.set(BUZZ_CACHE_KEY, JSON.stringify(persisted(useBuzzLocalCache.getState())));
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

/** Workspace metadata is viewer-wide even though Room decks are cached per Workspace. */
export function selectKnownCommunities(
  state: BuzzCacheState,
  viewerPubkey: string | null,
): Community[] {
  if (!viewerPubkey) return [];
  const known = new Map<string, Community>();
  for (const entry of Object.values(state.channelLists)) {
    if (entry.viewerPubkey !== viewerPubkey) continue;
    for (const community of entry.communities) {
      known.set(community.communityId, { ...known.get(community.communityId), ...community });
    }
  }
  return [...known.values()];
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
  storage.delete(BUZZ_CACHE_KEY);
}
