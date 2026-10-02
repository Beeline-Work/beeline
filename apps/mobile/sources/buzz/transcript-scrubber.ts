import { ledgerDayCaption } from './message-dates';
import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * The phone transcript's scroll bar is a fast-scroll thumb over the rows the
 * phone has loaded. Positions run from 0 at the newest message (offset 0 of
 * the inverted list) to 1 at the oldest loaded one.
 */
export type TranscriptScrollMetrics = {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
};

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function scrollRange(metrics: TranscriptScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight);
}

/** The thumb's position, or null when the loaded rows fit on screen. */
export function scrollBarPosition(metrics: TranscriptScrollMetrics): number | null {
  const range = scrollRange(metrics);
  return range > 0 ? clampUnit(metrics.offset / range) : null;
}

/** The list offset for a thumb dragged to `position`. */
export function scrubOffset(metrics: TranscriptScrollMetrics, position: number): number {
  return clampUnit(position) * scrollRange(metrics);
}

/** What the drag bubble names: the day of the oldest message on screen. */
export function scrubDate(rows: readonly ChatDisplayMessage[]): string | null {
  let oldest: number | undefined;
  for (const row of rows) {
    if (row.timestamp > 0 && (oldest === undefined || row.timestamp < oldest))
      oldest = row.timestamp;
  }
  return ledgerDayCaption(oldest);
}
