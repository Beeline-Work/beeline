import type { MergeTarget } from '@beeline/buzz-client';
import { latestRoomMessage } from '@/buzz/room-list-summary';
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

/** Revalidate only events at/after the persisted cursor; stable ids absorb the inclusive edge. */
async function performMessageRevalidation(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
): Promise<MessageSyncResult> {
  const cached = getCachedChannel(viewerPubkey, channelId);
  const warm =
    cached?.messages !== undefined && cached.cursor !== undefined && cached.backfilled === true;
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
  const fetchedLatestMessage = latestRoomMessage(events) ?? undefined;
  const latestMessage =
    cached?.latestMessage && (cached.latestEventAt ?? 0) >= eventCursor
      ? cached.latestMessage
      : fetchedLatestMessage;
  const latestEventAt = Math.max(cached?.latestEventAt ?? 0, eventCursor) || undefined;
  const store = useBuzzLocalCache.getState();
  if (warm) {
    store.upsertMessages(viewerPubkey, channelId, projected.messages, cursor, {
      ...(latestMessage ? { latestMessage } : {}),
      ...(latestEventAt ? { latestEventAt } : {}),
    });
  } else {
    store.replaceMessages(
      viewerPubkey,
      channelId,
      upsertChatMessages(projected.messages, cached?.messages ?? []),
      cursor,
      {
        ...(latestMessage ? { latestMessage } : {}),
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
  return {
    entry: getCachedChannel(viewerPubkey, channelId)!,
    mergeTarget: projected.mergeTarget,
    archiveChannel: projected.archiveChannel,
  };
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

/** Project one live event into the same persisted cache used by backfill and navigation. */
export function cacheLiveSessionEvent(
  viewerPubkey: string,
  channelId: string,
  event: SessionEvent,
): ReturnType<typeof projectChatEvent> {
  const projected = projectChatEvent(event, viewerPubkey, true);
  const cursor = sessionEventCursor(event);
  const latestMessage = latestRoomMessage([event]) ?? undefined;
  if (projected.message) {
    useBuzzLocalCache
      .getState()
      .upsertMessages(viewerPubkey, channelId, [projected.message], cursor, {
        ...(latestMessage ? { latestMessage } : {}),
        ...(cursor ? { latestEventAt: cursor } : {}),
      });
  } else if (cursor || projected.archiveChannel || projected.mergeTarget || projected.clearMergeTarget) {
    const cached = getCachedChannel(viewerPubkey, channelId);
    useBuzzLocalCache.getState().patchChannel(viewerPubkey, channelId, {
      ...(cursor
        ? {
            cursor: Math.max(cached?.cursor ?? 0, cursor),
            latestEventAt: Math.max(cached?.latestEventAt ?? 0, cursor),
          }
        : {}),
      ...(latestMessage ? { latestMessage } : {}),
      ...(projected.archiveChannel ? { archived: true } : {}),
      ...(projected.mergeTarget ? { mergeTarget: projected.mergeTarget } : {}),
      ...(projected.clearMergeTarget ? { mergeTarget: null } : {}),
    });
  }
  return projected;
}
