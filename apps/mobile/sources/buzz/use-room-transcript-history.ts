import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addRoomPage, type RoomHistoryView, type RoomViewMessage } from '@beeline/buzz-client';

import {
  advanceRoomHistoryCursor,
  retainRoomHistoryCursor,
  type RoomHistoryCursorState,
} from '@/buzz/room-history-pagination';

export type TranscriptHistoryStatus = 'idle' | 'loading' | 'error' | 'complete';

type HistoryClient = {
  historyAround?(roomId: string, messageId: string): Promise<RoomHistoryView>;
  historyAfter?(roomId: string, messageId: string): Promise<RoomHistoryView>;
  history(
    roomId: string,
    before?: { readonly createdAt: number; readonly id: string },
  ): Promise<RoomHistoryView>;
};

export function useRoomTranscriptHistory({
  roomId,
  tailMessages,
  roomClient,
  enabled,
  initialVisibleCount,
}: {
  roomId: string;
  tailMessages: readonly RoomViewMessage[] | undefined;
  roomClient: HistoryClient | null;
  enabled: boolean;
  initialVisibleCount: number;
}) {
  const [olderPages, setOlderPages] = useState<readonly (readonly RoomViewMessage[])[]>([]);
  const [aroundPage, setAroundPage] = useState<readonly RoomViewMessage[]>([]);
  const [aroundStatus, setAroundStatus] = useState<'idle' | 'loading' | 'error' | 'missing'>('idle');
  const [aroundJoined, setAroundJoined] = useState(false);
  const [aroundForwardStatus, setAroundForwardStatus] = useState<TranscriptHistoryStatus>('idle');
  const [aroundBackwardStatus, setAroundBackwardStatus] = useState<TranscriptHistoryStatus>('idle');
  const aroundRequestRef = useRef(0);
  const aroundPageRef = useRef<readonly RoomViewMessage[]>([]);
  const aroundForwardIdRef = useRef<string | null>(null);
  const aroundBackwardCursorRef = useRef<{ createdAt: number; id: string } | null>(null);
  const aroundJoinedRef = useRef(false);
  const aroundForwardLoadingRef = useRef(false);
  const aroundBackwardLoadingRef = useRef(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(initialVisibleCount);
  const [status, setStatus] = useState<TranscriptHistoryStatus>('idle');
  const cursorRef = useRef<RoomHistoryCursorState | null>(null);
  const loadingRef = useRef(false);
  const visibleCountRef = useRef(initialVisibleCount);
  const statusRef = useRef<TranscriptHistoryStatus>('idle');
  const requestVersionRef = useRef(0);
  const previousRoomIdRef = useRef(roomId);
  const completedTailIdRef = useRef<string | null>(null);

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

  const updateStatus = useCallback((next: TranscriptHistoryStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const reset = useCallback(() => {
    requestVersionRef.current += 1;
    aroundRequestRef.current += 1;
    aroundPageRef.current = [];
    aroundForwardIdRef.current = null;
    aroundBackwardCursorRef.current = null;
    aroundJoinedRef.current = false;
    aroundForwardLoadingRef.current = false;
    aroundBackwardLoadingRef.current = false;
    setAroundPage([]);
    setAroundJoined(false);
    setAroundStatus('idle');
    setAroundForwardStatus('idle');
    setAroundBackwardStatus('idle');
    cursorRef.current = null;
    completedTailIdRef.current = null;
    loadingRef.current = false;
    visibleCountRef.current = initialVisibleCount;
    setOlderPages([]);
    setVisibleMessageCount(initialVisibleCount);
    updateStatus('idle');
  }, [initialVisibleCount, updateStatus]);

  useEffect(() => {
    if (previousRoomIdRef.current === roomId) return;
    previousRoomIdRef.current = roomId;
    reset();
  }, [roomId, reset]);

  useEffect(() => {
    visibleCountRef.current = Math.max(visibleCountRef.current, initialVisibleCount);
    setVisibleMessageCount((count) => Math.max(count, initialVisibleCount));
  }, [initialVisibleCount]);

  const requestOlder = useCallback(
    (residentRowCount: number, retry: boolean) => {
      if (
        loadingRef.current ||
        statusRef.current === 'complete' ||
        (statusRef.current === 'error' && !retry)
      )
        return;
      if (visibleCountRef.current < residentRowCount) {
        const next = Math.min(residentRowCount, visibleCountRef.current + 30);
        visibleCountRef.current = next;
        setVisibleMessageCount(next);
        return;
      }

      const cursor = cursorRef.current;
      if (!roomClient || !enabled) return;

      const requestedRoomId = roomId;
      const requestVersion = ++requestVersionRef.current;
      loadingRef.current = true;
      updateStatus('loading');
      void roomClient
        .history(requestedRoomId, cursor?.before ?? undefined)
        .then((page) => {
          if (
            requestVersionRef.current !== requestVersion ||
            previousRoomIdRef.current !== requestedRoomId
          )
            return;
          cursorRef.current = advanceRoomHistoryCursor(requestedRoomId, page);
          if (page.messages.length > 0) {
            const tailIds = new Set(tailMessages?.map((message) => message.id) ?? []);
            const fresh = page.messages.filter((message) => !tailIds.has(message.id));
            setOlderPages((current) => addRoomPage({ pages: current }, fresh).pages);
            visibleCountRef.current += fresh.length;
            setVisibleMessageCount(visibleCountRef.current);
          }
          if (page.nextBefore) {
            completedTailIdRef.current = null;
            updateStatus('idle');
          } else {
            completedTailIdRef.current = tailMessages?.[0]?.id ?? null;
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
    [enabled, roomClient, roomId, tailMessages, updateStatus],
  );

  const joinAround = useCallback((rows: readonly RoomViewMessage[], backward: TranscriptHistoryStatus) => {
    aroundJoinedRef.current = true;
    setAroundJoined(true);
    const all = [...rows, ...olderPages.flat(), ...(tailMessages ?? [])];
    const prior = olderPages.flat().at(0);
    const anchored = rows[0];
    const oldest = prior && anchored &&
      (prior.createdAtMs ?? prior.createdAt * 1_000) < (anchored.createdAtMs ?? anchored.createdAt * 1_000)
      ? { createdAt: prior.createdAt, id: prior.id } : aroundBackwardCursorRef.current;
    cursorRef.current = { roomId, before: oldest };
    requestVersionRef.current += 1;
    loadingRef.current = false;
    completedTailIdRef.current = backward === 'complete' ? tailMessages?.[0]?.id ?? null : null;
    updateStatus(backward === 'complete' ? 'complete' : 'idle');
    visibleCountRef.current = Math.max(visibleCountRef.current, all.length);
    setVisibleMessageCount(visibleCountRef.current);
  }, [olderPages, roomId, tailMessages, updateStatus]);

  const requestNewerAround = useCallback((retry: boolean) => {
    if (!roomClient?.historyAfter || !enabled || !aroundPageRef.current.length ||
        aroundJoinedRef.current || aroundForwardLoadingRef.current ||
        (aroundForwardStatus === 'error' && !retry)) return;
    const newestId = aroundForwardIdRef.current;
    if (!newestId) return;
    const request = aroundRequestRef.current;
    aroundForwardLoadingRef.current = true;
    setAroundForwardStatus('loading');
    void roomClient.historyAfter(roomId, newestId).then((page) => {
      if (request !== aroundRequestRef.current || roomId !== previousRoomIdRef.current) return;
      const knownIds = new Set([...olderPages.flat(), ...(tailMessages ?? [])].map((row) => row.id));
      const overlaps = page.messages.some((row) => knownIds.has(row.id));
      const seen = new Set(aroundPageRef.current.map((row) => row.id));
      const merged = [...aroundPageRef.current, ...page.messages.filter((row) => !seen.has(row.id))];
      aroundForwardIdRef.current = page.messages.at(-1)?.id ?? newestId;
      aroundPageRef.current = merged;
      setAroundPage(merged);
      visibleCountRef.current = Math.max(visibleCountRef.current, merged.length);
      setVisibleMessageCount(visibleCountRef.current);
      if (overlaps || page.messages.length < 30) {
        setAroundForwardStatus('complete');
        joinAround(merged, aroundBackwardStatus);
      } else {
        setAroundForwardStatus('idle');
      }
    }).catch(() => {
      if (request === aroundRequestRef.current) setAroundForwardStatus('error');
    }).finally(() => {
      if (request === aroundRequestRef.current) aroundForwardLoadingRef.current = false;
    });
  }, [aroundBackwardStatus, aroundForwardStatus, enabled, joinAround, olderPages, roomClient, roomId, tailMessages]);

  const loadNewerAround = useCallback(() => requestNewerAround(false), [requestNewerAround]);
  const retryNewerAround = useCallback(() => requestNewerAround(true), [requestNewerAround]);

  const loadOlderAround = useCallback((retry: boolean) => {
    if (!roomClient || !enabled || !aroundPageRef.current.length ||
        aroundBackwardLoadingRef.current || aroundBackwardStatus === 'complete' ||
        (aroundBackwardStatus === 'error' && !retry)) return;
    const oldest = aroundBackwardCursorRef.current;
    if (!oldest) return;
    const request = aroundRequestRef.current;
    aroundBackwardLoadingRef.current = true;
    setAroundBackwardStatus('loading');
    void roomClient.history(roomId, { createdAt: oldest.createdAt, id: oldest.id }).then((page) => {
      if (request !== aroundRequestRef.current || roomId !== previousRoomIdRef.current) return;
      const seen = new Set(aroundPageRef.current.map((row) => row.id));
      const merged = [...page.messages.filter((row) => !seen.has(row.id)), ...aroundPageRef.current];
      const first = page.messages[0];
      if (first) aroundBackwardCursorRef.current = { createdAt: first.createdAt, id: first.id };
      aroundPageRef.current = merged;
      setAroundPage(merged);
      visibleCountRef.current = Math.max(visibleCountRef.current, merged.length);
      setVisibleMessageCount(visibleCountRef.current);
      setAroundBackwardStatus(page.nextBefore ? 'idle' : 'complete');
      if (aroundJoinedRef.current) {
        cursorRef.current = { roomId, before: aroundBackwardCursorRef.current };
        completedTailIdRef.current = page.nextBefore ? null : tailMessages?.[0]?.id ?? null;
        updateStatus(page.nextBefore ? 'idle' : 'complete');
      }
    }).catch(() => {
      if (request === aroundRequestRef.current) setAroundBackwardStatus('error');
    }).finally(() => {
      if (request === aroundRequestRef.current) aroundBackwardLoadingRef.current = false;
    });
  }, [aroundBackwardStatus, enabled, roomClient, roomId, tailMessages, updateStatus]);

  const loadOlder = useCallback(
    (residentRowCount: number) => {
      if (aroundPageRef.current.length && !aroundJoinedRef.current) loadOlderAround(false);
      else requestOlder(residentRowCount, false);
    },
    [loadOlderAround, requestOlder],
  );
  const retry = useCallback(
    (residentRowCount: number) => {
      if (aroundPageRef.current.length && !aroundJoinedRef.current) loadOlderAround(true);
      else requestOlder(residentRowCount, true);
    },
    [loadOlderAround, requestOlder],
  );
  const leaveAround = useCallback(() => {
    aroundRequestRef.current += 1;
    aroundPageRef.current = [];
    aroundForwardIdRef.current = null;
    aroundBackwardCursorRef.current = null;
    aroundJoinedRef.current = false;
    aroundForwardLoadingRef.current = false;
    aroundBackwardLoadingRef.current = false;
    setAroundPage([]);
    setAroundJoined(false);
    setAroundStatus('idle');
    setAroundForwardStatus('idle');
    setAroundBackwardStatus('idle');
    const oldest = olderPages.flat()[0] ?? tailMessages?.[0];
    cursorRef.current = oldest ? { roomId, before: { createdAt: oldest.createdAt, id: oldest.id } } : null;
    completedTailIdRef.current = null;
    requestVersionRef.current += 1;
    loadingRef.current = false;
    updateStatus('idle');
    visibleCountRef.current = initialVisibleCount;
    setVisibleMessageCount(initialVisibleCount);
  }, [initialVisibleCount, olderPages, roomId, tailMessages, updateStatus]);
  const abandonAround = useCallback(() => {
    if (aroundPageRef.current.length) return;
    aroundRequestRef.current += 1;
    setAroundStatus('idle');
  }, []);
  const loadAround = useCallback((messageId: string) => {
    if (!roomClient?.historyAround || !enabled) return;
    const request = ++aroundRequestRef.current;
    const requestedRoomId = roomId;
    aroundPageRef.current = [];
    aroundForwardIdRef.current = null;
    aroundBackwardCursorRef.current = null;
    aroundJoinedRef.current = false;
    setAroundPage([]);
    setAroundJoined(false);
    setAroundForwardStatus('idle');
    setAroundBackwardStatus('idle');
    setAroundStatus('loading');
    void roomClient.historyAround(roomId, messageId).then((page) => {
      if (request !== aroundRequestRef.current || requestedRoomId !== previousRoomIdRef.current) return;
      if (!page.messages.some((message) => message.id === messageId)) {
        setAroundStatus('missing');
        return;
      }
      aroundPageRef.current = page.messages;
      aroundForwardIdRef.current = page.messages.at(-1)?.id ?? null;
      const first = page.messages[0];
      aroundBackwardCursorRef.current = first ? { createdAt: first.createdAt, id: first.id } : null;
      setAroundPage(page.messages);
      visibleCountRef.current = Math.max(visibleCountRef.current, page.messages.length);
      setVisibleMessageCount(visibleCountRef.current);
      const knownIds = new Set([...olderPages.flat(), ...(tailMessages ?? [])].map((row) => row.id));
      if (page.messages.some((row) => knownIds.has(row.id))) joinAround(page.messages, 'idle');
      setAroundStatus('idle');
    }).catch(() => {
      if (request === aroundRequestRef.current && requestedRoomId === previousRoomIdRef.current)
        setAroundStatus('error');
    });
  }, [enabled, joinAround, olderPages, roomClient, roomId, tailMessages]);

  const revealThrough = useCallback((count: number) => {
    visibleCountRef.current = Math.max(visibleCountRef.current, count);
    setVisibleMessageCount(visibleCountRef.current);
  }, []);

  const anchoredSegmentActive = aroundPage.length > 0 && !aroundJoined;
  const segmentRows = useMemo(
    () => anchoredSegmentActive
      ? aroundPage
      : addRoomPage({ pages: [...olderPages, aroundPage] }, []).pages[0] ?? [],
    [anchoredSegmentActive, aroundPage, olderPages],
  );

  return {
    olderPages,
    aroundPage,
    aroundStatus,
    aroundJoined,
    anchoredSegmentActive,
    segmentRows,
    aroundForwardStatus,
    loadAround,
    loadNewerAround,
    retryNewerAround,
    abandonAround,
    leaveAround,
    visibleMessageCount,
    status: previousRoomIdRef.current === roomId
      ? aroundPage.length && !aroundJoined ? aroundBackwardStatus : statusRef.current
      : 'idle',
    loadOlder,
    retry,
    revealThrough,
    reset,
  };
}
