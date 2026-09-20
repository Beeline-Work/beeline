import { space, typeRoles } from './groknight';
import { ledgerStamp } from './relative-time';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

/** sectionHead line + space.md above and below — the in-flow caption block. */
export const LEDGER_DAY_CAPTION_LINE_HEIGHT = typeRoles.sectionHead.lineHeight;
export const LEDGER_DAY_CAPTION_MARGIN = space.md;
export const LEDGER_DAY_CAPTION_HEIGHT =
  LEDGER_DAY_CAPTION_LINE_HEIGHT + LEDGER_DAY_CAPTION_MARGIN * 2;

function atDate(seconds: number | undefined): Date | null {
  if (!seconds || seconds <= 0) return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

function localDayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

export function isLedgerDayOpener(
  timestamp: number | undefined,
  previousTimestamp: number | undefined,
): boolean {
  const at = atDate(timestamp);
  if (!at) return false;
  const previous = atDate(previousTimestamp);
  if (!previous) return true;
  return localDayKey(at) !== localDayKey(previous);
}

export function ledgerDate(seconds: number | undefined): string {
  const at = atDate(seconds);
  if (!at) return '';
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** Absolute weekday+date caption, or null when this row is not a day opener. */
export function ledgerDayCaption(
  timestamp: number | undefined,
  previousTimestamp?: number | undefined,
): string | null {
  if (!isLedgerDayOpener(timestamp, previousTimestamp)) return null;
  const at = atDate(timestamp);
  if (!at) return null;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/**
 * Bylines only: the clock, plus the date on a past day's first byline.
 * Today never carries a date. Gutter stamps stay on `ledgerStamp`.
 */
export function transcriptStamp(
  timestamp: number | undefined,
  previousTimestamp?: number | undefined,
  nowMs: number = Date.now(),
): string {
  const clock = ledgerStamp(timestamp);
  if (!clock) return '';
  if (!isLedgerDayOpener(timestamp, previousTimestamp)) return clock;
  const at = atDate(timestamp);
  const now = new Date(nowMs);
  if (!at || localDayKey(at) === localDayKey(now)) return clock;
  return `${ledgerDate(timestamp)} ${clock}`;
}

export type LedgerFlowCell = {
  id: string;
  bodyHeight: number;
  captionHeight: number;
};

export type LedgerFlowSlice = {
  id: string;
  viewportY: number;
  height: number;
  kind: 'caption' | 'body';
};

function overlaps(y: number, height: number, viewY: number, viewH: number): boolean {
  return y < viewY + viewH && y + height > viewY;
}

/**
 * Native inverted transcript geometry: offset 0 is the visual tail (newest).
 * y grows toward older history. A caption is in-flow at the visual-top of its
 * day-opener cell, never a separate list item and never sticky.
 */
export function measureInvertedTranscript(
  cellsNewestFirst: readonly LedgerFlowCell[],
  viewportHeight: number,
  offset: number,
): LedgerFlowSlice[] {
  const visible: LedgerFlowSlice[] = [];
  let y = -offset;
  for (const cell of cellsNewestFirst) {
    const bodyY = y;
    const captionY = y + cell.bodyHeight;
    if (overlaps(bodyY, cell.bodyHeight, 0, viewportHeight)) {
      visible.push({ id: cell.id, viewportY: bodyY, height: cell.bodyHeight, kind: 'body' });
    }
    if (cell.captionHeight > 0 && overlaps(captionY, cell.captionHeight, 0, viewportHeight)) {
      visible.push({
        id: cell.id,
        viewportY: captionY,
        height: cell.captionHeight,
        kind: 'caption',
      });
    }
    y += cell.bodyHeight + cell.captionHeight;
  }
  return visible;
}

export function invertedAnchorOffset(
  cellsNewestFirst: readonly LedgerFlowCell[],
  anchorId: string,
  viewportY: number,
): number {
  let y = 0;
  for (const cell of cellsNewestFirst) {
    if (cell.id === anchorId) return y - viewportY;
    y += cell.bodyHeight + cell.captionHeight;
  }
  throw new Error(`anchor ${anchorId} is not in the transcript`);
}
