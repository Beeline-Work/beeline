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

/** A scrubbed day's landing while native measures its way to the row. */
export type ScrubLanding = {
  messageId: string;
  /** The furthest row native had measured at the last failed attempt. */
  highestMeasured: number;
  /** Failed attempts in a row that measured nothing further. */
  stalls: number;
  failures: number;
};

/** Failed attempts in a row, measuring nothing further, before a landing gives up. */
export const SCRUB_LANDING_STALLS = 8;

/**
 * Whether a scrubbed landing should try again after `scrollToIndex` failed.
 * A list without `getItemLayout` lays out content only as far as its furthest
 * measured row, so a row hundreds back is reached about a batch of rows per
 * attempt. The landing keeps going while attempts measure further, and stops
 * only once they no longer do.
 */
export function continueScrubLanding(landing: ScrubLanding, highestMeasured: number): boolean {
  landing.failures += 1;
  if (highestMeasured > landing.highestMeasured) {
    landing.highestMeasured = highestMeasured;
    landing.stalls = 0;
    return true;
  }
  landing.stalls += 1;
  return landing.stalls <= SCRUB_LANDING_STALLS;
}
