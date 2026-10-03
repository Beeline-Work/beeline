import { useCallback, useEffect, useRef } from 'react';
import type { TranscriptHistoryStatus } from './use-room-transcript-history';

/**
 * The phone transcript only pages older history after the reader scrolls
 * (#1469's first-open budget). A resident tail that folds into fewer rows
 * than fill the list never scrolls, so no drag ever arrives and the reader
 * is stuck below an empty screen. This mirrors the desktop underfill rule
 * (`handleDesktopScroll`): while the content is no taller than the list,
 * older history loads without a gesture, one page at a time, until the
 * content fills the list or history reports its start.
 */
export function phoneTranscriptUnderfilled({
  contentHeight,
  listHeight,
  threshold,
}: {
  contentHeight: number;
  listHeight: number;
  threshold: number;
}): boolean {
  if (listHeight <= 0 || contentHeight <= 0) return false;
  return contentHeight <= listHeight + threshold;
}

export function usePhoneUnderfillHistory({
  enabled,
  status,
  historyRevision,
  threshold,
  loadOlder,
}: {
  /** The transcript has resident rows to measure. */
  enabled: boolean;
  status: TranscriptHistoryStatus;
  /** Changes whenever older rows are revealed, so a page that folds away still re-checks. */
  historyRevision: number;
  threshold: number;
  loadOlder: () => void;
}) {
  const listHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const enabledRef = useRef(enabled);
  const statusRef = useRef(status);
  const loadOlderRef = useRef(loadOlder);
  enabledRef.current = enabled;
  statusRef.current = status;
  loadOlderRef.current = loadOlder;

  const check = useCallback(() => {
    if (!enabledRef.current || statusRef.current !== 'idle') return;
    if (
      !phoneTranscriptUnderfilled({
        contentHeight: contentHeightRef.current,
        listHeight: listHeightRef.current,
        threshold,
      })
    )
      return;
    loadOlderRef.current();
  }, [threshold]);

  // A page that lands (status back to idle) or a revealed window that folds
  // into the same rows may not change the content height; re-check anyway.
  useEffect(() => {
    check();
  }, [check, enabled, status, historyRevision]);

  const observeListHeight = useCallback(
    (height: number) => {
      listHeightRef.current = height;
      check();
    },
    [check],
  );
  const observeContentHeight = useCallback(
    (height: number) => {
      contentHeightRef.current = height;
      check();
    },
    [check],
  );
  return { observeListHeight, observeContentHeight };
}
