import type { MergeTarget } from '@beeline/buzz-client';
import { latestRoomMessageSummary, type RoomMessageSummary } from '@/buzz/room-list-summary';
import {
  getCachedChannel,
  useBuzzLocalCache,
  type ChannelCacheEntry,
  type RoomSummaryPatch,
} from '@/buzz/local-cache';
import type { BuzzRigTransport } from '@/sync/transport';
import type { SessionEvent } from '@/sync/transport';
import { invalidateCornerLifecycleCache } from '@/sync/transport/corner-lifecycle-cache';
import {
  projectChatEvent,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';

export type MessageSyncResult = {
  entry: ChannelCacheEntry;
  mergeTarget?: MergeTarget | null;
  /** Preview deployment for the merge-ready tip, when its host published one. */
  previewUrl?: string | null;
  archiveChannel: boolean;
};

const inFlightRevalidations = new Map<string, Promise<MessageSyncResult>>();
const inFlightCornerRevalidations = new Map<string, Promise<void>>();

/**
 * A cold channel's initial backfill returns its N most recent matching kind:9
 * events, per standard Nostr REQ `limit` semantics — there is no relay query
 * that returns "the first N" directly. Every channel interleaves narration
 * with status/activity housekeeping on the same kind, so a corner busy enough
 * to publish more than this many kind:9 events total pushes its own opening
 * narration out of the "most recent N" window before this ever runs — the
 * corner then opens mid-thought, with its earliest narrative segment(s)
 * looking silently dropped even though they were durably published. A corner
 * is a bounded single-task session (unlike a Room's unbounded history), so a
 * generous cap makes that eviction rare in practice without changing a Room's
 * intentional "open on a short recent window" behavior.
 */
const COLD_BACKFILL_LIMIT = 200;

function isNewerRoomMessage(candidate: RoomMessageSummary, cached?: ChannelCacheEntry): boolean {
  const cachedTimestamp = cached?.latestMessageAt;
  if (cachedTimestamp === undefined) return true;
  if (candidate.timestamp !== cachedTimestamp) return candidate.timestamp > cachedTimestamp;
  return candidate.id.localeCompare(cached?.latestMessageId ?? '') > 0;
}

function messageSummaryPatch(
  candidate: RoomMessageSummary | null,
  cached?: ChannelCacheEntry,
): RoomSummaryPatch {
  if (!candidate || !isNewerRoomMessage(candidate, cached)) return {};
  return {
    latestMessage: candidate.text,
    latestMessageAt: candidate.timestamp,
    latestMessageId: candidate.id,
    latestMessageAuthor: candidate.authorPubkey,
  };
}

export function sessionEventCursor(event: SessionEvent): number | undefined {
  if (event.type === 'assistant_delta') return event.seq;
  if (event.type !== 'raw' || !event.payload || typeof event.payload !== 'object') return undefined;
  const payload = event.payload as { createdAt?: unknown; created_at?: unknown };
  if (typeof payload.createdAt === 'number') return payload.createdAt;
  return typeof payload.created_at === 'number' ? payload.created_at : undefined;
}

function isLandedRoomEvent(event: SessionEvent): boolean {
  if (event.type !== 'raw' || !event.payload || typeof event.payload !== 'object') return false;
  const tags = (event.payload as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return false;
  const has = (name: string, value: string) =>
    tags.some((tag) => Array.isArray(tag) && tag[0] === name && tag[1] === value);
  return (
    has('delivery', 'landed') ||
    has('t', 'landed') ||
    has('t', 'land-summary') ||
    has('t', 'merge-summary')
  );
}

function projectEvents(events: SessionEvent[], viewerPubkey: string, isNew: boolean) {
  let messages: ChatDisplayMessage[] = [];
  let mergeTarget: MergeTarget | null | undefined;
  // The preview belongs to the merge target it rode in on: a withdrawn target
  // must never leave a stale PREVIEW row pointing at an older tip's deploy.
  let previewUrl: string | null | undefined;
  let archiveChannel = false;
  for (const event of events) {
    const projected = projectChatEvent(event, viewerPubkey, isNew);
    if (projected.mergeTarget) {
      mergeTarget = projected.mergeTarget;
      previewUrl = projected.previewUrl ?? null;
    }
    if (projected.clearMergeTarget) {
      mergeTarget = null;
      previewUrl = null;
    }
    if (projected.archiveChannel) archiveChannel = true;
    if (projected.message) messages = upsertChatMessages(messages, [projected.message]);
  }
  return { messages, mergeTarget, previewUrl, archiveChannel };
}

/**
 * A `.corner`-tagged control message (posted to a Room when one of its
 * corners changes lifecycle status, e.g. on archive) keeps that Room's own
 * transcript current for free via the precedence-guarded message cache. The
 * Room-list sidebar's corner array is a separate, once-fetched snapshot
 * (`listSubchannelLifecycle`) that never sees these messages on its own —
 * mirror the same signal into it so an archive that lands while the sidebar
 * snapshot is still resident does not keep showing a stale status.
 */
function applyCornerStatusSignals(
  viewerPubkey: string,
  roomId: string,
  messages: ChatDisplayMessage[],
): void {
  let invalidatedLifecycleCache = false;
  for (const message of messages) {
    if (message.corner) {
      useBuzzLocalCache.getState().patchCornerStatus(viewerPubkey, roomId, {
        ...message.corner,
        lastActivityAt: message.timestamp,
      });
      if (!invalidatedLifecycleCache) {
        // Same signal as the sidebar patch above: a real status change
        // should not wait out `listSubchannelLifecycle`'s short-TTL cache.
        invalidateCornerLifecycleCache(roomId);
        invalidatedLifecycleCache = true;
      }
    }
  }
}

/** Revalidate only events at/after the persisted cursor; stable ids absorb the inclusive edge. */
async function performMessageRevalidation(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
): Promise<MessageSyncResult> {
  const cached = getCachedChannel(viewerPubkey, channelId);
  // An empty initial read is not a durable history cursor: relay membership
  // projections can make that first authorized read race the messages already
  // in the Room. Keep requesting a bounded full snapshot until at least one
  // message has actually been observed.
  const warm =
    (cached?.messages?.length ?? 0) > 0 &&
    cached?.cursor !== undefined &&
    cached.backfilled === true;
  const fetchStartedAt = Math.floor(Date.now() / 1000);
  const events = await transport.sessionEventsBackfill(
    channelId,
    warm ? { afterSeq: cached.cursor } : { limit: COLD_BACKFILL_LIMIT },
  );
  const projected = projectEvents(events, viewerPubkey, warm);
  const eventCursor = events.reduce(
    (maximum, event) => Math.max(maximum, sessionEventCursor(event) ?? 0),
    0,
  );
  // An empty Room is still warm after its first successful relay read. Keep one
  // overlap second so an event racing the HTTP query is picked up next time.
  const cursor = Math.max(cached?.cursor ?? 0, eventCursor || Math.max(0, fetchStartedAt - 1));
  const summary = messageSummaryPatch(latestRoomMessageSummary(events), cached);
  const latestEventAt = Math.max(cached?.latestEventAt ?? 0, eventCursor) || undefined;
  const store = useBuzzLocalCache.getState();
  if (warm) {
    store.upsertMessages(viewerPubkey, channelId, projected.messages, cursor, {
      ...summary,
      ...(latestEventAt ? { latestEventAt } : {}),
    });
  } else {
    store.replaceMessages(
      viewerPubkey,
      channelId,
      upsertChatMessages(projected.messages, cached?.messages ?? []),
      cursor,
      {
        ...summary,
        ...(latestEventAt ? { latestEventAt } : {}),
      },
    );
  }
  if (projected.archiveChannel || projected.mergeTarget !== undefined) {
    store.patchChannel(viewerPubkey, channelId, {
      ...(projected.archiveChannel ? { archived: true } : {}),
      ...(projected.mergeTarget !== undefined ? { mergeTarget: projected.mergeTarget } : {}),
    });
  }
  applyCornerStatusSignals(viewerPubkey, channelId, projected.messages);
  return {
    entry: getCachedChannel(viewerPubkey, channelId)!,
    mergeTarget: projected.mergeTarget,
    previewUrl: projected.previewUrl,
    archiveChannel: projected.archiveChannel,
  };
}

/**
 * One page of history strictly at-or-before `before`, for on-demand "load
 * older" pagination. Callers hold the result in local component state; this
 * never writes to the persisted cache, which stays bounded to the recent tail.
 */
export async function loadOlderMessages(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
  before: number,
  limit: number,
): Promise<ChatDisplayMessage[]> {
  const events = await transport.sessionEventsBackfill(channelId, { beforeSeq: before, limit });
  return projectEvents(events, viewerPubkey, false).messages;
}

export function revalidateCachedMessages(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
): Promise<MessageSyncResult> {
  const key = `${viewerPubkey}:${channelId}`;
  const existing = inFlightRevalidations.get(key);
  if (existing) return existing;
  const revalidation = performMessageRevalidation(transport, viewerPubkey, channelId).finally(
    () => {
      if (inFlightRevalidations.get(key) === revalidation) inFlightRevalidations.delete(key);
    },
  );
  inFlightRevalidations.set(key, revalidation);
  return revalidation;
}

/**
 * Project a batch of live events into the same persisted cache used by backfill
 * and navigation, in one store write. `upsertMessages` rebuilds and re-sorts the
 * full message array on every call, so during a burst of per-token agent
 * activity events (one raw event per streamed token), calling it once per event
 * is O(events * n log n) on the JS thread and can visibly stall the UI. Batching
 * callers should queue events (e.g. across one requestAnimationFrame) and pass
 * them here together instead of calling this once per event.
 */
export function cacheLiveSessionEvents(
  viewerPubkey: string,
  channelId: string,
  events: SessionEvent[],
): ReturnType<typeof projectChatEvent>[] {
  const projections = events.map((event) => projectChatEvent(event, viewerPubkey, true));
  const cached = getCachedChannel(viewerPubkey, channelId);
  const summary = messageSummaryPatch(latestRoomMessageSummary(events), cached);
  const messages: ChatDisplayMessage[] = [];
  const patchOnly: { event: SessionEvent; projected: ReturnType<typeof projectChatEvent> }[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < events.length; i++) {
    const projected = projections[i];
    const eventCursor = sessionEventCursor(events[i]);
    if (eventCursor !== undefined) cursor = Math.max(cursor ?? 0, eventCursor);
    if (projected.message) {
      messages.push(projected.message);
    } else if (
      eventCursor ||
      projected.archiveChannel ||
      projected.mergeTarget ||
      projected.clearMergeTarget
    ) {
      patchOnly.push({ event: events[i], projected });
    }
  }
  if (messages.length) {
    useBuzzLocalCache.getState().upsertMessages(viewerPubkey, channelId, messages, cursor, {
      ...summary,
      ...(cursor ? { latestEventAt: cursor } : {}),
    });
    applyCornerStatusSignals(viewerPubkey, channelId, messages);
  }
  // Rare (archive/merge-target/cursor-only signals): applied per event, in
  // order, same as before batching — this path never touches the message
  // array so it stays cheap even called once per event.
  for (const { event, projected } of patchOnly) {
    const eventCursor = sessionEventCursor(event);
    const cached = getCachedChannel(viewerPubkey, channelId);
    useBuzzLocalCache.getState().patchChannel(viewerPubkey, channelId, {
      ...(eventCursor
        ? {
            cursor: Math.max(cached?.cursor ?? 0, eventCursor),
            latestEventAt: Math.max(cached?.latestEventAt ?? 0, eventCursor),
          }
        : {}),
      ...summary,
      ...(projected.archiveChannel ? { archived: true } : {}),
      ...(projected.mergeTarget ? { mergeTarget: projected.mergeTarget } : {}),
      ...(projected.clearMergeTarget ? { mergeTarget: null } : {}),
    });
    // Derived Room updates are quiet. Only landed work is allowed to move the
    // Room in the index, and doing so never changes latestMessageAt (the unread
    // authority) or invents preview copy.
    if (eventCursor && isLandedRoomEvent(event)) {
      useBuzzLocalCache.getState().bumpChannelRecency(viewerPubkey, channelId, eventCursor);
    }
  }
  return projections;
}

/**
 * A live corner signal contains only id/status, so it cannot safely fabricate
 * the full sidebar card (name, opener, creation time). When that id was absent
 * from the Room list's earlier lifecycle snapshot, re-read the authoritative
 * lifecycle and replace the Room's array as one store update. Concurrent
 * signals for the same Room share one read.
 */
export function refreshRoomListCornersForUnknownSignals(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  roomId: string,
  projections: ReturnType<typeof projectChatEvent>[],
): Promise<void> | undefined {
  const signaledIds = projections.flatMap((projection) =>
    projection.message?.corner ? [projection.message.corner.subchannelId] : [],
  );
  if (signaledIds.length === 0) return undefined;

  const hasUnknownCorner = Object.values(useBuzzLocalCache.getState().channelLists)
    .filter((entry) => entry.viewerPubkey === viewerPubkey)
    .flatMap((entry) => entry.channels)
    .filter((channel) => channel.id === roomId)
    .some((channel) =>
      signaledIds.some((id) => !channel.corners?.some((corner) => corner.id === id)),
    );
  if (!hasUnknownCorner) return undefined;

  const key = `${viewerPubkey}:${roomId}`;
  const existing = inFlightCornerRevalidations.get(key);
  if (existing) {
    // The in-flight read may have started before this newer signal existed.
    // Re-check after it settles so a burst opening two corners cannot lose the
    // second id behind the first Room-level deduplication slot.
    return existing.then(
      () =>
        refreshRoomListCornersForUnknownSignals(transport, viewerPubkey, roomId, projections) ??
        Promise.resolve(),
    );
  }
  const revalidation = transport
    .listSubchannelLifecycle(roomId)
    .then((corners) => {
      useBuzzLocalCache.getState().replaceRoomCorners(viewerPubkey, roomId, corners);
    })
    .catch(() => {
      // The normal focus/heartbeat refresh remains the backstop. A transient
      // lifecycle read must not surface as an unhandled UI promise rejection.
    })
    .finally(() => {
      if (inFlightCornerRevalidations.get(key) === revalidation) {
        inFlightCornerRevalidations.delete(key);
      }
    });
  inFlightCornerRevalidations.set(key, revalidation);
  return revalidation;
}

/** Project one live event into the same persisted cache used by backfill and navigation. */
export function cacheLiveSessionEvent(
  viewerPubkey: string,
  channelId: string,
  event: SessionEvent,
): ReturnType<typeof projectChatEvent> {
  return cacheLiveSessionEvents(viewerPubkey, channelId, [event])[0];
}
