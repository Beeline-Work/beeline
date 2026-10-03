import { useCallback, useEffect, useRef, useState } from 'react';
import { addRoomPage, type RoomHistoryView, type RoomViewMessage } from '@beeline/buzz-client';

import {
  advanceRoomHistoryCursor,
  retainRoomHistoryCursor,
  type RoomHistoryCursorState,
} from '@/buzz/room-history-pagination';

export type TranscriptHistoryStatus = 'idle' | 'loading' | 'error' | 'complete';

type HistoryClient = {
  historyAround?(roomId: string, messageId: string): Promise<RoomHistoryView>;
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
  const aroundRequestRef = useRef(0);
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
    setAroundPage([]);
    setAroundStatus('idle');
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

  const loadOlder = useCallback(
    (residentRowCount: number) => requestOlder(residentRowCount, false),
    [requestOlder],
  );
  const retry = useCallback(
    (residentRowCount: number) => requestOlder(residentRowCount, true),
    [requestOlder],
  );
  const loadAround = useCallback((messageId: string) => {
    if (!roomClient?.historyAround || !enabled) return;
    const request = ++aroundRequestRef.current;
    const requestedRoomId = roomId;
    setAroundStatus('loading');
    void roomClient.historyAround(roomId, messageId).then((page) => {
      if (request !== aroundRequestRef.current || requestedRoomId !== previousRoomIdRef.current) return;
      if (!page.messages.some((message) => message.id === messageId)) {
        setAroundStatus('missing');
        return;
      }
      setAroundPage(page.messages);
      setAroundStatus('idle');
    }).catch(() => {
      if (request === aroundRequestRef.current && requestedRoomId === previousRoomIdRef.current)
        setAroundStatus('error');
    });
  }, [enabled, roomClient, roomId]);

  const revealThrough = useCallback((count: number) => {
    visibleCountRef.current = Math.max(visibleCountRef.current, count);
    setVisibleMessageCount(visibleCountRef.current);
  }, []);

  return {
    olderPages,
    aroundPage,
    aroundStatus,
    loadAround,
    visibleMessageCount,
    status: previousRoomIdRef.current === roomId ? statusRef.current : 'idle',
    loadOlder,
    retry,
    revealThrough,
    reset,
  };
}
