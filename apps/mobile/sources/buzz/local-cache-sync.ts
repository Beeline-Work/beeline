import type { MergeTarget } from '@beeline/buzz-client';
import { latestRoomMessageSummary, type RoomMessageSummary } from '@/buzz/room-list-summary';
import { getCachedChannel, useBuzzLocalCache, type ChannelCacheEntry } from '@/buzz/local-cache';
import type { BuzzRigTransport } from '@/sync/transport';
import type { SessionEvent } from '@/sync/transport';
import {
  projectChatEvent,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';

export type MessageSyncResult = {
  entry: ChannelCacheEntry;
  mergeTarget?: MergeTarget | null;
  archiveChannel: boolean;
};

const inFlightRevalidations = new Map<string, Promise<MessageSyncResult>>();

function isNewerRoomMessage(
  candidate: RoomMessageSummary,
  cached?: ChannelCacheEntry,
): boolean {
  const cachedTimestamp = cached?.latestMessageAt;
  if (cachedTimestamp === undefined) return true;
  if (candidate.timestamp !== cachedTimestamp) return candidate.timestamp > cachedTimestamp;
  return candidate.id.localeCompare(cached?.latestMessageId ?? '') > 0;
}

function messageSummaryPatch(
  candidate: RoomMessageSummary | null,
  cached?: ChannelCacheEntry,
): {
  latestMessage?: string;
  latestMessageAt?: number;
  latestMessageId?: string;
} {
  if (!candidate || !isNewerRoomMessage(candidate, cached)) return {};
  return {
    latestMessage: candidate.text,
    latestMessageAt: candidate.timestamp,
    latestMessageId: candidate.id,
  };
}

export function sessionEventCursor(event: SessionEvent): number | undefined {
  if (event.type === 'assistant_delta') return event.seq;
  if (event.type !== 'raw' || !event.payload || typeof event.payload !== 'object') return undefined;
  const payload = event.payload as { createdAt?: unknown; created_at?: unknown };
  if (typeof payload.createdAt === 'number') return payload.createdAt;
  return typeof payload.created_at === 'number' ? payload.created_at : undefined;
}

function projectEvents(events: SessionEvent[], viewerPubkey: string, isNew: boolean) {
  let messages: ChatDisplayMessage[] = [];
  let mergeTarget: MergeTarget | null | undefined;
  let archiveChannel = false;
  for (const event of events) {
    const projected = projectChatEvent(event, viewerPubkey, isNew);
    if (projected.mergeTarget) mergeTarget = projected.mergeTarget;
    if (projected.clearMergeTarget) mergeTarget = null;
    if (projected.archiveChannel) archiveChannel = true;
    if (projected.message) messages = upsertChatMessages(messages, [projected.message]);
  }
  return { messages, mergeTarget, archiveChannel };
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
  for (const message of messages) {
    if (message.corner) {
      useBuzzLocalCache.getState().patchCornerStatus(viewerPubkey, roomId, message.corner);
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
    (cached?.messages?.length ?? 0) > 0 && cached?.cursor !== undefined && cached.backfilled === true;
  const fetchStartedAt = Math.floor(Date.now() / 1000);
  const events = await transport.sessionEventsBackfill(
    channelId,
    warm ? { afterSeq: cached.cursor } : { limit: 50 },
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
  }
  return projections;
}

/** Project one live event into the same persisted cache used by backfill and navigation. */
export function cacheLiveSessionEvent(
  viewerPubkey: string,
  channelId: string,
  event: SessionEvent,
): ReturnType<typeof projectChatEvent> {
  return cacheLiveSessionEvents(viewerPubkey, channelId, [event])[0];
}
