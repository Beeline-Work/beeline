import { useEffect, useState } from 'react';
import type { ChatDisplayMessage } from './room-view-presentation';
import { scrubDate, type TranscriptScrollMetrics } from './transcript-scrubber';

/** How long the bar stays after the list stops, long enough to grab it. */
export const SCRUBBER_LINGER_MS = 2_000;

export type TranscriptScrubberSnapshot = {
  metrics: TranscriptScrollMetrics | null;
  /** The day of the oldest message on screen, for the drag bubble. */
  date: string | null;
  /** The list is scrolling or just stopped. */
  visible: boolean;
};

/** The fields of a native scroll event the bar reads. */
type ScrollEventShape = {
  contentOffset: { y: number };
  contentSize: { height: number };
  layoutMeasurement: { height: number };
};

export type TranscriptScrubberStore = ReturnType<typeof createTranscriptScrubberStore>;

/**
 * State for `TranscriptScrubber`, kept outside React state so a scroll frame
 * re-renders only the bar, not the Room screen that feeds it.
 */
export function createTranscriptScrubberStore() {
  let snapshot: TranscriptScrubberSnapshot = { metrics: null, date: null, visible: false };
  let linger: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: Partial<TranscriptScrubberSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };
  const reveal = () => {
    if (!snapshot.visible) update({ visible: true });
    if (linger) clearTimeout(linger);
    linger = setTimeout(() => update({ visible: false }), SCRUBBER_LINGER_MS);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Shows the bar and restarts its fade. */
    reveal,
    observeScroll(event: ScrollEventShape) {
      update({
        metrics: {
          offset: event.contentOffset.y,
          contentHeight: event.contentSize.height,
          viewportHeight: event.layoutMeasurement.height,
        },
      });
      reveal();
    },
    observeVisibleRows(rows: readonly ChatDisplayMessage[]) {
      const date = scrubDate(rows);
      if (date !== snapshot.date) update({ date });
    },
    dispose() {
      if (linger) clearTimeout(linger);
      linger = null;
    },
  };
}

export function useTranscriptScrubber(): TranscriptScrubberStore {
  const [store] = useState(createTranscriptScrubberStore);
  useEffect(() => store.dispose, [store]);
  return store;
}
