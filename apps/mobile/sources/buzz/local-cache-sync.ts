import {
  mergeWorkspaceSnapshots,
  reduceWorkspaceEvents,
  reduceWorkspaceSnapshot,
  selectCorners,
  selectRoomRow,
  type MergeTarget,
  type WorkspaceSnapshot,
} from '@beeline/buzz-client';
import { sortCorners, type CornerSummary } from '@/buzz/corners';
import { roomPreviewText } from '@/buzz/room-list-summary';
import {
  getCachedChannel,
  useBuzzLocalCache,
  type ChannelCacheEntry,
  type RoomSummaryPatch,
} from '@/buzz/local-cache';
import type { BuzzRigTransport } from '@/sync/transport';
import type { SessionEvent } from '@/sync/transport';
import {
  projectReadEvent,
  sessionEventCursor,
  transcriptMessages,
  type ChatDisplayMessage,
  type ChatEventProjection,
} from '@/sync/transport/buzz-event-projection';

export type MessageSyncResult = {
  entry: ChannelCacheEntry;
  mergeTarget?: MergeTarget | null;
  previewUrl?: string | null;
  archiveChannel: boolean;
};

const COLD_BACKFILL_LIMIT = 200;
export const LIVE_EVENT_FRAME_BUDGET_MS = 5;
export const LIVE_EVENT_CHUNK_SIZE = 16;
export const LIVE_EVENT_FRAME_MAX_EVENTS = 64;
const inFlightRevalidations = new Map<string, Promise<MessageSyncResult>>();
const pendingColdLiveEvents = new Map<string, SessionEvent[]>();

export { sessionEventCursor };

export type LiveEventFrameResult = {
  processed: number;
  remaining: number;
  elapsedMs: number;
};

/**
 * Consume a burst in small cache batches until either the JS-frame time budget
 * or the hard event cap is reached. At least one small chunk makes progress;
 * the caller schedules another animation frame while `remaining` is non-zero.
 */
export function drainLiveEventFrame<T>(
  queue: T[],
  consume: (batch: T[]) => void,
  options: {
    now?: () => number;
    budgetMs?: number;
    chunkSize?: number;
    maxEvents?: number;
  } = {},
): LiveEventFrameResult {
  const now = options.now ?? (() => performance.now());
  const budgetMs = Math.max(0, options.budgetMs ?? LIVE_EVENT_FRAME_BUDGET_MS);
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? LIVE_EVENT_CHUNK_SIZE));
  const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? LIVE_EVENT_FRAME_MAX_EVENTS));
  const startedAt = now();
  let processed = 0;
  while (queue.length > 0 && processed < maxEvents) {
    const size = Math.min(chunkSize, maxEvents - processed, queue.length);
    consume(queue.splice(0, size));
    processed += size;
    if (now() - startedAt >= budgetMs) break;
  }
  return { processed, remaining: queue.length, elapsedMs: now() - startedAt };
}

function summaryPatch(snapshot: WorkspaceSnapshot, channelId: string): RoomSummaryPatch {
  const selection = selectRoomRow(snapshot, channelId);
  const preview = selection.preview;
  if (!preview) return {};
  const text = roomPreviewText(preview.body);
  if (!text) return {};
  return {
    latestMessage: text,
    latestMessageAt: preview.timestamp,
    latestMessageId: preview.id,
    latestMessageAuthor: preview.authorPubkey,
    latestEventAt: snapshot.rooms[channelId]?.coverage.newest,
  };
}

function foldEffects(
  events: readonly SessionEvent[],
  viewerPubkey: string,
  isNew: boolean,
): {
  projections: ChatEventProjection[];
  mergeTarget: MergeTarget | null | undefined;
  previewUrl: string | null | undefined;
  archiveChannel: boolean;
} {
  const projections = events.map((event) =>
    event.type === 'read-model' ? projectReadEvent(event.event, viewerPubkey, isNew) : {},
  );
  let mergeTarget: MergeTarget | null | undefined;
  let previewUrl: string | null | undefined;
  let archiveChannel = false;
  for (const projected of projections) {
    if (projected.mergeTarget) {
      mergeTarget = projected.mergeTarget;
      previewUrl = projected.previewUrl ?? null;
    }
    if (projected.clearMergeTarget) {
      mergeTarget = null;
      previewUrl = null;
    }
    if (projected.archiveChannel) archiveChannel = true;
  }
  return { projections, mergeTarget, previewUrl, archiveChannel };
}

async function performMessageRevalidation(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
): Promise<MessageSyncResult> {
  const key = `${viewerPubkey}:${channelId}`;
  const cached = getCachedChannel(viewerPubkey, channelId);
  const warm = Boolean(cached?.snapshot?.rooms[channelId]?.coverage.initialBackfillComplete);
  const result = await transport.readModelBackfill(
    channelId,
    warm && cached?.cursor !== undefined
      ? { afterSeq: cached.cursor }
      : { limit: COLD_BACKFILL_LIMIT },
  );
  // A live subscription can authenticate before the cold snapshot commits.
  // Preserve those typed events and fold them into the snapshot atomically;
  // dropping them here makes a healthy responding agent look silent until a
  // later full revalidation happens to replay the event.
  const pendingLive = pendingColdLiveEvents.get(key) ?? [];
  pendingColdLiveEvents.delete(key);
  const committedEvents = [...result.events, ...pendingLive];
  const effects = foldEffects(committedEvents, viewerPubkey, warm);
  const current = getCachedChannel(viewerPubkey, channelId);
  let snapshot = current?.snapshot
    ? mergeWorkspaceSnapshots(current.snapshot, result.snapshot)
    : result.snapshot;
  for (const event of pendingLive) {
    if (event.type === 'read-model') snapshot = reduceWorkspaceSnapshot(snapshot, event.event);
  }
  const eventCursor = committedEvents.reduce(
    (maximum, event) => Math.max(maximum, sessionEventCursor(event) ?? 0),
    0,
  );
  const cursor = Math.max(current?.cursor ?? 0, eventCursor) || undefined;
  useBuzzLocalCache
    .getState()
    .replaceSnapshot(viewerPubkey, channelId, snapshot, cursor, summaryPatch(snapshot, channelId));
  if (effects.archiveChannel || effects.mergeTarget !== undefined) {
    useBuzzLocalCache.getState().patchChannel(viewerPubkey, channelId, {
      ...(effects.archiveChannel ? { archived: true } : {}),
      ...(effects.mergeTarget !== undefined ? { mergeTarget: effects.mergeTarget } : {}),
    });
  }
  return {
    entry: getCachedChannel(viewerPubkey, channelId)!,
    mergeTarget: effects.mergeTarget,
    previewUrl: effects.previewUrl,
    archiveChannel: effects.archiveChannel,
  };
}

export function revalidateCachedMessages(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
  options: { force?: boolean } = {},
): Promise<MessageSyncResult> {
  const key = `${viewerPubkey}:${channelId}`;
  const existing = inFlightRevalidations.get(key);
  // A user-requested Retry must not join the same promise that already left
  // the Room in its terminal error state. The older read may still settle;
  // performMessageRevalidation's pre-commit cache re-read makes that safe.
  if (existing && !options.force) return existing;
  const revalidation = performMessageRevalidation(transport, viewerPubkey, channelId).finally(
    () => {
      if (inFlightRevalidations.get(key) === revalidation) inFlightRevalidations.delete(key);
    },
  );
  inFlightRevalidations.set(key, revalidation);
  return revalidation;
}

export async function loadOlderMessages(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
  before: number,
  limit: number,
): Promise<ChatDisplayMessage[]> {
  const result = await transport.readModelBackfill(channelId, { beforeSeq: before, limit });
  return transcriptMessages(result.snapshot, channelId, viewerPubkey);
}

export function cacheLiveSessionEvents(
  viewerPubkey: string,
  channelId: string,
  events: SessionEvent[],
): ChatEventProjection[] {
  const effects = foldEffects(events, viewerPubkey, true);
  const cached = getCachedChannel(viewerPubkey, channelId);
  let snapshot = cached?.snapshot;
  if (!snapshot) {
    const key = `${viewerPubkey}:${channelId}`;
    const pending = pendingColdLiveEvents.get(key) ?? [];
    const ids = new Set(
      pending.flatMap((event) =>
        event.type === 'read-model' && event.event.type !== 'unknown' ? [event.event.eventId] : [],
      ),
    );
    for (const event of events) {
      const id =
        event.type === 'read-model' && event.event.type !== 'unknown'
          ? event.event.eventId
          : undefined;
      if (!id || !ids.has(id)) pending.push(event);
      if (id) ids.add(id);
    }
    pendingColdLiveEvents.set(key, pending.slice(-500));
  } else {
    snapshot = reduceWorkspaceEvents(
      snapshot,
      events.flatMap((event) => (event.type === 'read-model' ? [event.event] : [])),
    );
    const cursor = events.reduce(
      (maximum, event) => Math.max(maximum, sessionEventCursor(event) ?? 0),
      cached?.cursor ?? 0,
    );
    useBuzzLocalCache
      .getState()
      .replaceSnapshot(
        viewerPubkey,
        channelId,
        snapshot,
        cursor || undefined,
        summaryPatch(snapshot, channelId),
      );
  }
  if (effects.archiveChannel || effects.mergeTarget !== undefined) {
    useBuzzLocalCache.getState().patchChannel(viewerPubkey, channelId, {
      ...(effects.archiveChannel ? { archived: true } : {}),
      ...(effects.mergeTarget !== undefined ? { mergeTarget: effects.mergeTarget } : {}),
    });
  }
  return effects.projections;
}

/** Ephemeral UI mapping over the normalized snapshot; never persisted. */
export function cornerSummariesFromSnapshot(
  roomId: string,
  snapshot: WorkspaceSnapshot,
): CornerSummary[] {
  return sortCorners(
    selectCorners(snapshot, roomId).map((corner) => ({
      id: corner.id,
      name: corner.name ?? `corner-${corner.id.slice(0, 8)}`,
      openerPubkey: corner.creatorPubkey ?? '',
      status:
        corner.kind === 'active'
          ? corner.state === 'working'
            ? 'live'
            : corner.state === 'waiting'
              ? 'needs-attention'
              : null
          : 'failed',
      ...(corner.kind === 'active' ? { machineState: corner.state } : {}),
      stateAt: corner.stateAt,
      createdAt: corner.createdAt,
    })),
  );
}
