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
import { beginColdOpenSample } from '@/buzz/cold-open-metrics';
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
/**
 * The ONLY deadline on the first-paint critical path, and it bounds exactly
 * one thing: the single bounded tail read (`readModelTail`). Authority,
 * sibling corner states, projections, membership, and presence hydrate later
 * through independent deferred steps that carry no share of this budget — a
 * slow or failing secondary step can never reach the timeout screen.
 */
export const COLD_TAIL_DEADLINE_MS = 8_000;
export const COLD_TAIL_TIMEOUT_MESSAGE = `Conversation loading timed out after ${COLD_TAIL_DEADLINE_MS / 1_000} seconds.`;
export const LIVE_EVENT_FRAME_BUDGET_MS = 5;
export const LIVE_EVENT_CHUNK_SIZE = 16;
export const LIVE_EVENT_FRAME_MAX_EVENTS = 64;
const inFlightRevalidations = new Map<string, Promise<MessageSyncResult>>();
const pendingColdLiveEvents = new Map<string, SessionEvent[]>();
/** One background full reconciliation per channel; removed when it settles. */
const deferredFullReconciliations = new Map<string, Promise<void>>();

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

/** Commit one settled read-model result into the shared cache. */
async function commitBackfillResult(
  viewerPubkey: string,
  channelId: string,
  result: { snapshot: WorkspaceSnapshot; events: SessionEvent[] },
): Promise<MessageSyncResult> {
  const key = `${viewerPubkey}:${channelId}`;
  // A live subscription can authenticate before the cold snapshot commits.
  // Preserve those typed events and fold them into the snapshot atomically;
  // dropping them here makes a healthy responding agent look silent until a
  // later full revalidation happens to replay the event.
  const pendingLive = pendingColdLiveEvents.get(key) ?? [];
  pendingColdLiveEvents.delete(key);
  const committedEvents = [...result.events, ...pendingLive];
  const cached = getCachedChannel(viewerPubkey, channelId);
  const warm = Boolean(cached?.snapshot?.rooms[channelId]?.coverage.initialBackfillComplete);
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

/** Whether this transport exposes the cold-open fast path. */
function supportsColdTail(transport: BuzzRigTransport): boolean {
  return typeof transport.readModelTail === 'function';
}

/** Race one promise against a deadline that rejects with `message`. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Schedule the deferred half of a cold open: the full reconciliation read
 * (sibling corner states, family-wide authority, directory-backed identities)
 * runs strictly AFTER the tail result has committed and can never delay,
 * blank, or time out the transcript. Its result IS committed — through the
 * same gap-fill-only merge every other revalidation uses — so placeholder
 * fast-path identities are upgraded to directory truth and family facts land
 * in the cache without ever re-entering the first-paint path. A failure lands
 * in the cold-open metrics only.
 */
function scheduleDeferredFullReconciliation(
  transport: BuzzRigTransport & { readModelTail: BuzzRigTransport['readModelTail'] },
  viewerPubkey: string,
  channelId: string,
  sample: ReturnType<typeof beginColdOpenSample>,
): void {
  const key = `${viewerPubkey}:${channelId}`;
  if (deferredFullReconciliations.has(key)) return;
  const run = (async () => {
    const startedAt = Date.now();
    try {
      const result = await transport.readModelBackfill(channelId, {
        limit: COLD_BACKFILL_LIMIT,
      });
      // Off the critical path by construction: the tail already committed and
      // painted; this merge only fills gaps and outranks `-tail:` placeholder
      // identities with directory-backed records (revision-ordered).
      await commitBackfillResult(viewerPubkey, channelId, result);
      sample.deferredSettled(Date.now() - startedAt, undefined);
    } catch (error) {
      sample.deferredSettled(undefined, error);
      console.warn(`Deferred full reconciliation failed for ${channelId}:`, error);
    } finally {
      // Only one deferred run per key can exist (the has() guard above), so
      // removing unconditionally on settle is exact.
      deferredFullReconciliations.delete(key);
    }
  })();
  deferredFullReconciliations.set(key, run);
}

/**
 * Cold open: ONE bounded tail read is the entire first-paint critical path.
 *
 * The transcript paints from this tail result (or the pre-existing cache)
 * the moment it commits; `COLD_TAIL_DEADLINE_MS` bounds exactly this read.
 * Everything else hydrates later through independent, bounded, nonblocking
 * steps — here the deferred full reconciliation, and in `hydrateRoomEntry`
 * the sibling/membership/presence fan-out.
 */
async function performColdTailRevalidation(
  transport: BuzzRigTransport & { readModelTail: BuzzRigTransport['readModelTail'] },
  viewerPubkey: string,
  channelId: string,
): Promise<MessageSyncResult> {
  const sample = beginColdOpenSample(channelId);
  const startedAt = sample.startedAt;
  let timedOut = false;
  try {
    const result = await withDeadline(
      transport.readModelTail(channelId, { limit: COLD_BACKFILL_LIMIT }),
      COLD_TAIL_DEADLINE_MS,
      COLD_TAIL_TIMEOUT_MESSAGE,
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message === COLD_TAIL_TIMEOUT_MESSAGE) {
        timedOut = true;
        sample.tailTimedOut(COLD_TAIL_DEADLINE_MS);
      }
      throw error;
    });
    sample.tailSettled(Date.now() - startedAt, result.events.length);
    const committed = await commitBackfillResult(viewerPubkey, channelId, result);
    scheduleDeferredFullReconciliation(transport, viewerPubkey, channelId, sample);
    return committed;
  } catch (error) {
    if (!timedOut) sample.tailFailed(error);
    throw error;
  }
}

async function performMessageRevalidation(
  transport: BuzzRigTransport,
  viewerPubkey: string,
  channelId: string,
): Promise<MessageSyncResult> {
  const key = `${viewerPubkey}:${channelId}`;
  const cached = getCachedChannel(viewerPubkey, channelId);
  const complete = Boolean(
    cached?.snapshot?.rooms[channelId]?.coverage.initialBackfillComplete,
  );
  // Cold or INCOMPLETE open through a fast-path-capable transport: a cached
  // shell (entry present, snapshot empty or coverage never completed) is not
  // a painted transcript — it takes the same single bounded tail read as no
  // cache at all, instead of the full machinery that reproduced the captain's
  // eight-second timeout. The tail merge is gap-fill-only, so nothing already
  // cached can be erased.
  if (!complete && supportsColdTail(transport)) {
    return performColdTailRevalidation(
      transport as BuzzRigTransport & { readModelTail: BuzzRigTransport['readModelTail'] },
      viewerPubkey,
      channelId,
    );
  }
  const result = await transport.readModelBackfill(
    channelId,
    complete && cached?.cursor !== undefined
      ? { afterSeq: cached.cursor }
      : { limit: COLD_BACKFILL_LIMIT },
  );
  return commitBackfillResult(viewerPubkey, channelId, result);
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
