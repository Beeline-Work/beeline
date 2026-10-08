import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addRoomPage,
  RoomViewHttpError,
  type RoomHistoryView,
  type RoomViewMessage,
} from '@beeline/buzz-client';

import { anchorCornerMarkers } from '@/buzz/corner-markers';
import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';
import {
  advanceRoomHistoryCursor,
  displacedTailRows,
  retainRoomHistoryCursor,
  type RoomHistoryCursor,
  type RoomHistoryCursorState,
} from '@/buzz/room-history-pagination';
import { boundaryRowIndex, messageBoundaryIds } from '@/buzz/room-new-message-boundary';
import { foldSettledActivityRuns, type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { anchorRelayReports } from '@/buzz/system-lines';
import { rendersTranscriptRow } from '@/buzz/transcript-presentation';

/**
 * The one module that loads a Room's message history. Components read one
 * window of rows from `useRoomMessageStore` and move it with `loadLatest`,
 * `loadOlder`, `loadNewer` and `jumpTo`; none of them calls the history
 * endpoints. `room-message-store.boundary.test.ts` enforces that.
 *
 * The window is either attached (older pages, then the live tail the session
 * owns) or detached (a contiguous run of rows around a jump target that does
 * not reach the tail yet). `loadNewer` walks a detached window forward and
 * attaches it once it meets the tail.
 */

export type TranscriptHistoryStatus = 'idle' | 'loading' | 'error' | 'complete';

/**
 * `ready`: the target is in the window. `missing`: the server has no row the
 * viewer may read under that id. `error`: the read failed; `jumpTo` again.
 */
export type RoomJumpStatus = 'loading' | 'ready' | 'missing' | 'error';
export type RoomJump = { readonly messageId: string; readonly status: RoomJumpStatus };

/**
 * Rows a jump keeps newer than its target. They must fill the screen below
 * the target: the inverted phone list cannot scroll past its newest row, so
 * with fewer the target stops mid-screen instead of at the top. The list
 * draws them within its first few batches, and more newer rows load as the
 * reader scrolls toward the newest end.
 */
export const JUMP_NEWER_ROWS = 20;

const PAGE_SIZE = 30;

export type RoomHistoryClient = {
  history(roomId: string, before?: RoomHistoryCursor): Promise<RoomHistoryView>;
  historyAfter?(roomId: string, messageId: string): Promise<RoomHistoryView>;
  historyAround?(roomId: string, messageId: string): Promise<RoomHistoryView>;
};

type DetachedWindow = {
  readonly rows: readonly RoomViewMessage[];
  /** Rows already read that are newer than `rows`, shown by `loadNewer` first. */
  readonly buffered: readonly RoomViewMessage[];
  /** Fetch after this id once `buffered` is empty; null when `buffered` reaches the tail. */
  readonly newerAfter: string | null;
  readonly olderBefore: RoomHistoryCursor | null;
};

const cursorOf = (row: RoomViewMessage | undefined): RoomHistoryCursor | null =>
  row ? { createdAt: row.createdAt, id: row.id } : null;

/** The server holds no row under that id that the viewer may read. */
function missingJump(error: unknown): boolean {
  return error instanceof RoomViewHttpError && (error.status === 404 || error.status === 400);
}

export function useRoomMessageStore({
  roomId,
  tailMessages,
  roomClient,
  enabled,
  initialVisibleCount,
}: {
  roomId: string;
  tailMessages: readonly RoomViewMessage[] | undefined;
  roomClient: RoomHistoryClient | null;
  enabled: boolean;
  initialVisibleCount: number;
}) {
  const [olderPages, setOlderPages] = useState<readonly (readonly RoomViewMessage[])[]>([]);
  const olderPagesRef = useRef(olderPages);
  const [detached, setDetachedState] = useState<DetachedWindow | null>(null);
  const detachedRef = useRef<DetachedWindow | null>(null);
  const [jump, setJumpState] = useState<RoomJump | null>(null);
  const jumpRef = useRef<RoomJump | null>(null);
  const [newerStatus, setNewerStatusState] = useState<TranscriptHistoryStatus>('idle');
  const newerStatusRef = useRef<TranscriptHistoryStatus>('idle');
  const [windowOlderStatus, setWindowOlderStatusState] = useState<TranscriptHistoryStatus>('idle');
  const windowOlderStatusRef = useRef<TranscriptHistoryStatus>('idle');
  // One generation for every request that writes the window. A jump, a
  // return to the latest rows, a reset or a Room change advances it, so a
  // late response from the old window never lands in the new one.
  const windowRequestRef = useRef(0);
  const [visibleMessageCount, setVisibleMessageCount] = useState(initialVisibleCount);
  const [status, setStatus] = useState<TranscriptHistoryStatus>('idle');
  const cursorRef = useRef<RoomHistoryCursorState | null>(null);
  const loadingRef = useRef(false);
  // A screen-fill page added no rows. Fill stops until the window changes or
  // a page adds rows, so a short Room cannot loop on an empty page.
  const fillStalledRef = useRef(false);
  const visibleCountRef = useRef(initialVisibleCount);
  const statusRef = useRef<TranscriptHistoryStatus>('idle');
  const requestVersionRef = useRef(0);
  const previousRoomIdRef = useRef(roomId);
  const completedTailIdRef = useRef<string | null>(null);
  const previousTailRef = useRef<{ roomId: string; rows: readonly RoomViewMessage[] } | null>(null);
  const tailRef = useRef(tailMessages);
  tailRef.current = tailMessages;
  const clientRef = useRef(roomClient);
  clientRef.current = roomClient;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const initialVisibleCountRef = useRef(initialVisibleCount);
  initialVisibleCountRef.current = initialVisibleCount;

  const setOlder = useCallback(
    (
      next:
        | readonly (readonly RoomViewMessage[])[]
        | ((
            current: readonly (readonly RoomViewMessage[])[],
          ) => readonly (readonly RoomViewMessage[])[]),
    ) => {
      olderPagesRef.current = typeof next === 'function' ? next(olderPagesRef.current) : next;
      setOlderPages(olderPagesRef.current);
    },
    [],
  );
  const setDetached = useCallback((next: DetachedWindow | null) => {
    detachedRef.current = next;
    setDetachedState(next);
  }, []);
  const setJump = useCallback((next: RoomJump | null) => {
    jumpRef.current = next;
    setJumpState(next);
  }, []);
  const setNewerStatus = useCallback((next: TranscriptHistoryStatus) => {
    newerStatusRef.current = next;
    setNewerStatusState(next);
  }, []);
  const setWindowOlderStatus = useCallback((next: TranscriptHistoryStatus) => {
    windowOlderStatusRef.current = next;
    setWindowOlderStatusState(next);
  }, []);
  const updateStatus = useCallback((next: TranscriptHistoryStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  const reveal = useCallback((count: number) => {
    visibleCountRef.current = Math.max(visibleCountRef.current, count);
    setVisibleMessageCount(visibleCountRef.current);
  }, []);

  const previousTail = previousTailRef.current;
  if (tailMessages) previousTailRef.current = { roomId, rows: tailMessages };
  if (tailMessages && previousTail?.roomId === roomId && previousTail.rows !== tailMessages) {
    // The phone paints a cached tail, then a fresh one (and live reads keep
    // replacing it). The rows a replaced tail held must stay reachable.
    const displaced = displacedTailRows(previousTail.rows, tailMessages);
    if (displaced === null) {
      // Nothing joins the two tails: page from the fresh tail, not the old one.
      requestVersionRef.current += 1;
      loadingRef.current = false;
      cursorRef.current = null;
      completedTailIdRef.current = null;
      statusRef.current = 'idle';
      setOlder([]);
    } else if (displaced.length) {
      setOlder((current) => addRoomPage({ pages: current }, displaced).pages);
      visibleCountRef.current += displaced.length;
      setVisibleMessageCount(visibleCountRef.current);
    }
  }
  cursorRef.current = retainRoomHistoryCursor(cursorRef.current, roomId, tailMessages);
  if (
    statusRef.current === 'complete' &&
    completedTailIdRef.current !== (tailMessages?.[0]?.id ?? null)
  ) {
    cursorRef.current = retainRoomHistoryCursor(null, roomId, tailMessages);
    statusRef.current = 'idle';
  }
  useEffect(() => {
    if (status === 'complete' && statusRef.current === 'idle') setStatus('idle');
  }, [status, tailMessages]);

  /** Drop the detached window and page older history from the attached rows. */
  const attachToTail = useCallback(
    (
      older: readonly RoomViewMessage[],
      olderBefore: RoomHistoryCursor | null,
      complete: boolean,
    ) => {
      const tail = tailRef.current ?? [];
      const tailIds = new Set(tail.map((row) => row.id));
      const rows = older.filter((row) => !tailIds.has(row.id));
      setOlder(rows.length ? [rows] : []);
      setDetached(null);
      setNewerStatus('idle');
      setWindowOlderStatus('idle');
      cursorRef.current = { roomId: previousRoomIdRef.current, before: olderBefore };
      requestVersionRef.current += 1;
      loadingRef.current = false;
      fillStalledRef.current = false;
      completedTailIdRef.current = complete ? (tail[0]?.id ?? null) : null;
      updateStatus(complete ? 'complete' : 'idle');
      reveal(rows.length + tail.length);
    },
    [reveal, setDetached, setNewerStatus, setOlder, setWindowOlderStatus, updateStatus],
  );

  /**
   * Show `all` (chronological, contiguous) with the target at `index` and at
   * most `JUMP_NEWER_ROWS` newer rows. A target already that close to the
   * newest attached row needs no detached window at all.
   */
  const openWindowAt = useCallback(
    (
      all: readonly RoomViewMessage[],
      index: number,
      newerAfter: string | null,
      olderBefore: RoomHistoryCursor | null,
      olderStatus: TranscriptHistoryStatus,
    ) => {
      const cut = index + 1 + JUMP_NEWER_ROWS;
      if (newerAfter === null && cut >= all.length) {
        attachToTail(all, olderBefore, olderStatus === 'complete');
        return;
      }
      setDetached({
        rows: all.slice(0, cut),
        buffered: all.slice(cut),
        newerAfter,
        olderBefore,
      });
      setNewerStatus('idle');
      setWindowOlderStatus(olderStatus);
      reveal(cut);
    },
    [attachToTail, reveal, setDetached, setNewerStatus, setWindowOlderStatus],
  );

  /** Drop a detached window so the transcript shows the newest rows again. */
  const showLatest = useCallback(() => {
    if (!detachedRef.current) return;
    setDetached(null);
    setNewerStatus('idle');
    setWindowOlderStatus('idle');
    const tail = tailRef.current;
    const oldest =
      (addRoomPage({ pages: olderPagesRef.current }, []).pages[0] ?? [])[0] ?? tail?.[0];
    cursorRef.current = { roomId: previousRoomIdRef.current, before: cursorOf(oldest) };
    completedTailIdRef.current = null;
    requestVersionRef.current += 1;
    loadingRef.current = false;
    fillStalledRef.current = false;
    updateStatus('idle');
    visibleCountRef.current = initialVisibleCountRef.current;
    setVisibleMessageCount(initialVisibleCountRef.current);
  }, [setDetached, setNewerStatus, setWindowOlderStatus, updateStatus]);

  const jumpTo = useCallback(
    (messageId: string) => {
      const request = ++windowRequestRef.current;
      const requestedRoomId = previousRoomIdRef.current;
      setJump({ messageId, status: 'loading' });
      const tail = tailRef.current ?? [];
      const current = detachedRef.current;
      // A target the phone already holds needs no read.
      if (current) {
        const rows = [...current.rows, ...current.buffered];
        const index = rows.findIndex((row) => row.id === messageId);
        if (index >= 0) {
          openWindowAt(
            rows,
            index,
            current.newerAfter,
            current.olderBefore,
            windowOlderStatusRef.current,
          );
          setJump({ messageId, status: 'ready' });
          return;
        }
      } else {
        const older = addRoomPage({ pages: olderPagesRef.current }, []).pages[0] ?? [];
        const tailIds = new Set(tail.map((row) => row.id));
        const resident = [...older.filter((row) => !tailIds.has(row.id)), ...tail];
        const index = resident.findIndex((row) => row.id === messageId);
        if (index >= 0) {
          openWindowAt(
            resident,
            index,
            null,
            cursorRef.current?.before ?? cursorOf(resident[0]),
            statusRef.current,
          );
          setJump({ messageId, status: 'ready' });
          return;
        }
      }
      const client = clientRef.current;
      if (!client?.historyAround || !enabledRef.current) {
        setJump({ messageId, status: 'error' });
        return;
      }
      void client
        .historyAround(requestedRoomId, messageId)
        .then((page) => {
          if (request !== windowRequestRef.current || requestedRoomId !== previousRoomIdRef.current)
            return;
          const index = page.messages.findIndex((row) => row.id === messageId);
          if (index < 0) {
            showLatest();
            setJump({ messageId, status: 'missing' });
            return;
          }
          const tailNow = tailRef.current ?? [];
          const tailIds = new Set(tailNow.map((row) => row.id));
          const reachesTail = page.messages.some((row) => tailIds.has(row.id));
          const all = reachesTail
            ? [...page.messages.filter((row) => !tailIds.has(row.id)), ...tailNow]
            : page.messages;
          const at = all.findIndex((row) => row.id === messageId);
          openWindowAt(
            all,
            at,
            reachesTail ? null : (page.messages.at(-1)?.id ?? null),
            cursorOf(page.messages[0]),
            'idle',
          );
          setJump({ messageId, status: 'ready' });
        })
        .catch((error: unknown) => {
          if (request !== windowRequestRef.current || requestedRoomId !== previousRoomIdRef.current)
            return;
          if (!missingJump(error)) {
            setJump({ messageId, status: 'error' });
            return;
          }
          showLatest();
          setJump({ messageId, status: 'missing' });
        });
    },
    [openWindowAt, setJump, showLatest],
  );

  const clear = useCallback(() => {
    requestVersionRef.current += 1;
    windowRequestRef.current += 1;
    setDetached(null);
    setNewerStatus('idle');
    setWindowOlderStatus('idle');
    cursorRef.current = null;
    completedTailIdRef.current = null;
    loadingRef.current = false;
    fillStalledRef.current = false;
    visibleCountRef.current = initialVisibleCountRef.current;
    setOlder([]);
    setVisibleMessageCount(initialVisibleCountRef.current);
    updateStatus('idle');
  }, [setDetached, setNewerStatus, setOlder, setWindowOlderStatus, updateStatus]);

  /**
   * The session re-reads the Room: drop loaded history. A jump that has not
   * failed for good runs again, so a reset never strands its target.
   */
  const reset = useCallback(() => {
    const pending = jumpRef.current;
    clear();
    if (pending && pending.status !== 'missing') jumpTo(pending.messageId);
  }, [clear, jumpTo]);

  useEffect(() => {
    if (previousRoomIdRef.current === roomId) return;
    previousRoomIdRef.current = roomId;
    clear();
    setJump(null);
  }, [roomId, clear, setJump]);

  useEffect(() => {
    visibleCountRef.current = Math.max(visibleCountRef.current, initialVisibleCount);
    setVisibleMessageCount((count) => Math.max(count, initialVisibleCount));
  }, [initialVisibleCount]);

  const requestOlderAttached = useCallback(
    (residentRowCount: number, retry: boolean, fill = false) => {
      if (
        loadingRef.current ||
        statusRef.current === 'complete' ||
        (statusRef.current === 'error' && !retry)
      )
        return;
      if (visibleCountRef.current < residentRowCount) {
        const next = Math.min(residentRowCount, visibleCountRef.current + PAGE_SIZE);
        visibleCountRef.current = next;
        setVisibleMessageCount(next);
        return;
      }

      if (fill && fillStalledRef.current) return;
      const cursor = cursorRef.current;
      const client = clientRef.current;
      if (!client || !enabledRef.current) return;

      const requestedRoomId = previousRoomIdRef.current;
      const requestVersion = ++requestVersionRef.current;
      loadingRef.current = true;
      updateStatus('loading');
      void client
        .history(requestedRoomId, cursor?.before ?? undefined)
        .then((page) => {
          if (
            requestVersionRef.current !== requestVersion ||
            previousRoomIdRef.current !== requestedRoomId
          )
            return;
          const tail = tailRef.current;
          cursorRef.current = advanceRoomHistoryCursor(requestedRoomId, page);
          const tailIds = new Set(tail?.map((message) => message.id) ?? []);
          const fresh = page.messages.filter((message) => !tailIds.has(message.id));
          fillStalledRef.current = fresh.length === 0;
          if (fresh.length > 0) {
            setOlder((current) => addRoomPage({ pages: current }, fresh).pages);
            visibleCountRef.current += fresh.length;
            setVisibleMessageCount(visibleCountRef.current);
          }
          if (page.nextBefore) {
            completedTailIdRef.current = null;
            updateStatus('idle');
          } else {
            completedTailIdRef.current = tail?.[0]?.id ?? null;
            updateStatus('complete');
          }
        })
        .catch(() => {
          if (
            requestVersionRef.current === requestVersion &&
            previousRoomIdRef.current === requestedRoomId
          )
            updateStatus('error');
        })
        .finally(() => {
          if (requestVersionRef.current === requestVersion) loadingRef.current = false;
        });
    },
    [setOlder, updateStatus],
  );

  const requestOlderDetached = useCallback(
    (retry: boolean) => {
      const current = detachedRef.current;
      const client = clientRef.current;
      if (
        !current ||
        !client ||
        !enabledRef.current ||
        windowOlderStatusRef.current === 'loading' ||
        windowOlderStatusRef.current === 'complete' ||
        (windowOlderStatusRef.current === 'error' && !retry)
      )
        return;
      const before = current.olderBefore;
      if (!before) {
        setWindowOlderStatus('complete');
        return;
      }
      const request = windowRequestRef.current;
      const requestedRoomId = previousRoomIdRef.current;
      setWindowOlderStatus('loading');
      void client
        .history(requestedRoomId, before)
        .then((page) => {
          const latest = detachedRef.current;
          if (request !== windowRequestRef.current || !latest) return;
          const seen = new Set(latest.rows.map((row) => row.id));
          const rows = [...page.messages.filter((row) => !seen.has(row.id)), ...latest.rows];
          setDetached({
            ...latest,
            rows,
            olderBefore: cursorOf(page.messages[0]) ?? latest.olderBefore,
          });
          reveal(rows.length);
          setWindowOlderStatus(page.nextBefore ? 'idle' : 'complete');
        })
        .catch(() => {
          if (request === windowRequestRef.current) setWindowOlderStatus('error');
        });
    },
    [reveal, setDetached, setWindowOlderStatus],
  );

  const requestNewer = useCallback(
    (retry: boolean) => {
      const current = detachedRef.current;
      if (
        !current ||
        newerStatusRef.current === 'loading' ||
        (newerStatusRef.current === 'error' && !retry)
      )
        return;
      if (current.buffered.length) {
        const rows = [...current.rows, ...current.buffered.slice(0, PAGE_SIZE)];
        const buffered = current.buffered.slice(PAGE_SIZE);
        if (!buffered.length && current.newerAfter === null) {
          attachToTail(rows, current.olderBefore, windowOlderStatusRef.current === 'complete');
          return;
        }
        setDetached({ ...current, rows, buffered });
        reveal(rows.length);
        return;
      }
      if (current.newerAfter === null) {
        attachToTail(
          current.rows,
          current.olderBefore,
          windowOlderStatusRef.current === 'complete',
        );
        return;
      }
      const client = clientRef.current;
      if (!client?.historyAfter || !enabledRef.current) return;
      const request = windowRequestRef.current;
      const requestedRoomId = previousRoomIdRef.current;
      const after = current.newerAfter;
      setNewerStatus('loading');
      void client
        .historyAfter(requestedRoomId, after)
        .then((page) => {
          const latest = detachedRef.current;
          if (request !== windowRequestRef.current || !latest) return;
          const tailIds = new Set((tailRef.current ?? []).map((row) => row.id));
          const seen = new Set(latest.rows.map((row) => row.id));
          const fresh = page.messages.filter((row) => !seen.has(row.id));
          const rows = [...latest.rows, ...fresh];
          if (
            page.messages.some((row) => tailIds.has(row.id)) ||
            page.messages.length < PAGE_SIZE
          ) {
            attachToTail(rows, latest.olderBefore, windowOlderStatusRef.current === 'complete');
            return;
          }
          setDetached({ ...latest, rows, newerAfter: page.messages.at(-1)?.id ?? after });
          reveal(rows.length);
          setNewerStatus('idle');
        })
        .catch(() => {
          if (request === windowRequestRef.current) setNewerStatus('error');
        });
    },
    [attachToTail, reveal, setDetached, setNewerStatus],
  );

  const loadOlder = useCallback(
    (residentRowCount: number) => {
      if (detachedRef.current) requestOlderDetached(false);
      else requestOlderAttached(residentRowCount, false);
    },
    [requestOlderAttached, requestOlderDetached],
  );
  const retryOlder = useCallback(
    (residentRowCount: number) => {
      if (detachedRef.current) requestOlderDetached(true);
      else requestOlderAttached(residentRowCount, true);
    },
    [requestOlderAttached, requestOlderDetached],
  );
  /**
   * One step of filling a screen that the rows do not cover: newer rows for a
   * detached window, older history otherwise. It stops at the start of
   * history, on a failed page and after a page that adds no rows.
   */
  const fill = useCallback(
    (residentRowCount: number) => {
      if (detachedRef.current) requestNewer(false);
      else requestOlderAttached(residentRowCount, false, true);
    },
    [requestNewer, requestOlderAttached],
  );
  const loadNewer = useCallback(() => requestNewer(false), [requestNewer]);
  const retryNewer = useCallback(() => requestNewer(true), [requestNewer]);

  /** Back to the newest rows: the jump ends and the window attaches to the tail. */
  const loadLatest = useCallback(() => {
    windowRequestRef.current += 1;
    setJump(null);
    showLatest();
  }, [setJump, showLatest]);

  /**
   * The jump is over: its target landed, or the reader scrolled first. An
   * unanswered read is dropped so it cannot move the reader later, and a
   * later reset no longer runs it again. A failed or missing jump keeps its
   * record, so its line stays until the reader returns to the newest rows.
   */
  const endJump = useCallback(() => {
    const status = jumpRef.current?.status;
    if (status === 'loading') windowRequestRef.current += 1;
    if (status === 'loading' || status === 'ready') setJump(null);
  }, [setJump]);

  const rows = useMemo(
    () => (detached ? detached.rows : (addRoomPage({ pages: olderPages }, []).pages[0] ?? [])),
    [detached, olderPages],
  );

  const sameRoom = previousRoomIdRef.current === roomId;
  return {
    /** History rows of the window; an attached window continues into the tail. */
    rows,
    attached: !detached,
    jump: sameRoom ? jump : null,
    visibleMessageCount,
    status: sameRoom ? (detached ? windowOlderStatus : statusRef.current) : 'idle',
    newerStatus: detached ? newerStatus : ('complete' as TranscriptHistoryStatus),
    /** The status `fill` reads: the newer side of a detached window, else older history. */
    fillStatus: sameRoom ? (detached ? newerStatus : statusRef.current) : ('idle' as const),
    loadLatest,
    loadOlder,
    retryOlder,
    loadNewer,
    retryNewer,
    fill,
    jumpTo,
    endJump,
    revealThrough: reveal,
    reset,
  };
}

/**
 * The transcript's folds, applied once: corner markers and relay reports move
 * under their anchors, settled activity runs and lifecycle runs collapse into
 * one row. `hostIds` maps every message id to the id of the row that shows
 * it, including ids a fold removed, so a lookup never misses a folded target.
 */
export function foldTranscriptRows(
  messages: readonly ChatDisplayMessage[],
  firstNewMessageId: string | null | undefined,
): { rows: ChatDisplayMessage[]; hostIds: ReadonlyMap<string, string> } {
  const anchored = anchorCornerMarkers(anchorRelayReports([...messages]));
  const boundary = boundaryRowIndex(anchored, firstNewMessageId);
  const rows =
    boundary < 0
      ? foldPrLifecycleRuns(foldSettledActivityRuns(anchored))
      : // Keep stacks separate only while their unread divider is visible.
        [
          ...foldPrLifecycleRuns(foldSettledActivityRuns(anchored.slice(0, boundary))),
          ...foldPrLifecycleRuns(foldSettledActivityRuns(anchored.slice(boundary))),
        ];
  const hostIds = new Map<string, string>();
  for (const row of rows) {
    if (!rendersTranscriptRow(row)) continue;
    for (const id of messageBoundaryIds(row)) hostIds.set(id, row.id);
    hostIds.set(row.id, row.id);
    if (row.relayId) hostIds.set(row.relayId, row.id);
    for (const marker of row.cornerMarkers ?? []) {
      hostIds.set(marker.id, row.id);
      if (marker.relayId) hostIds.set(marker.relayId, row.id);
    }
  }
  // A fold that merges rows without recording their ids (a settled activity
  // run) moves them into an earlier row. Each such id belongs to the nearest
  // shown row before it.
  let previousHost: string | undefined;
  for (const message of messages) {
    const host = hostIds.get(message.id);
    if (host) previousHost = host;
    else if (previousHost) {
      hostIds.set(message.id, previousHost);
      if (message.relayId) hostIds.set(message.relayId, previousHost);
    }
  }
  return { rows, hostIds };
}

/** Index of the row that shows `messageId`, or -1. */
export function hostRowIndex(
  rows: readonly Pick<ChatDisplayMessage, 'id' | 'relayId'>[],
  hostIds: ReadonlyMap<string, string>,
  messageId: string,
): number {
  const hostId = hostIds.get(messageId) ?? messageId;
  return rows.findIndex(
    (row) => row.id === hostId || row.id === messageId || row.relayId === messageId,
  );
}

/**
 * Page older history from `before` until `find` returns a value or history
 * ends. For screens that need one row outside the window, such as the code
 * viewer looking up the message that holds a block.
 */
export async function findInRoomHistory<T>(
  client: Pick<RoomHistoryClient, 'history'>,
  roomId: string,
  before: RoomHistoryCursor | undefined,
  find: (rows: readonly RoomViewMessage[]) => T | null,
): Promise<T | null> {
  let cursor = before;
  for (;;) {
    const page = await client.history(roomId, cursor);
    const found = find(page.messages);
    if (found || !page.nextBefore) return found;
    cursor = page.nextBefore;
  }
}
