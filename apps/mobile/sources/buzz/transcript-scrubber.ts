import type { RoomHistoryOutline } from '@beeline/api-contract/phone';
import { ledgerDayCaption } from './message-dates';
import { ledgerStamp } from './relative-time';

/**
 * Where the transcript sits in its WHOLE history, and the days a reader can
 * scrub to. Positions run from 0 at the newest message to 1 at the oldest and
 * come from the server's outline, so loading an older page — which adds rows
 * above the reader but no history — cannot move them.
 */
export type ScrubberDay = {
  /** The reader's calendar day, `YYYY-MM-DD`, as the server cut it. */
  key: string;
  firstMessageId: string;
  /** Unix seconds of the day's first message. */
  startsAt: number;
  authorName: string;
  authorHandle?: string;
  /** Messages newer than the day's first message. */
  messagesBack: number;
  position: number;
  /** The first day of its month on the rail, which carries the month label. */
  monthStart: boolean;
};

export type ScrubberHistory = {
  total: number;
  days: readonly ScrubberDay[];
  /** Rank from the newest message, by durable id, for every loaded message. */
  rankById: ReadonlyMap<string, number>;
};

function positionOf(rank: number, total: number): number {
  return total > 1 ? Math.min(1, Math.max(0, rank / (total - 1))) : 0;
}

/**
 * `loadedIds` are the durable messages the phone holds, oldest first. Those
 * after the outline's newest message arrived since it was read and extend the
 * total; the outline is not re-read for every arrival.
 */
export function scrubberHistory(
  outline: RoomHistoryOutline | null,
  loadedIds: readonly string[],
): ScrubberHistory {
  const newestIndex = outline?.newest ? loadedIds.lastIndexOf(outline.newest.id) : -1;
  const arrivedSince = newestIndex >= 0 ? loadedIds.length - 1 - newestIndex : 0;
  // Without an outline the loaded messages are all the history there is to show.
  const total = outline ? outline.total + arrivedSince : loadedIds.length;
  const rankById = new Map<string, number>();
  loadedIds.forEach((id, index) => rankById.set(id, loadedIds.length - 1 - index));

  // Counted from the newest end, so each day's place is its distance from
  // the newest message.
  const outlineDays = outline?.days ?? [];
  const newerThan: number[] = new Array(outlineDays.length);
  let newer = arrivedSince;
  for (let index = outlineDays.length - 1; index >= 0; index -= 1) {
    newer += outlineDays[index]!.count;
    newerThan[index] = newer - 1;
  }

  const days = outlineDays.map((day, index): ScrubberDay => {
    const messagesBack = newerThan[index]!;
    return {
      key: day.day,
      firstMessageId: day.first.id,
      startsAt: day.first.createdAt,
      authorName: day.first.authorName,
      ...(day.first.authorHandle ? { authorHandle: day.first.authorHandle } : {}),
      messagesBack,
      position: positionOf(messagesBack, total),
      monthStart: day.day.slice(0, 7) !== outlineDays[index - 1]?.day.slice(0, 7),
    };
  });
  return { total, days, rankById };
}

/** The handle's position for the oldest message on screen, or null when unknown. */
export function scrubberPosition(
  history: ScrubberHistory,
  oldestVisibleIds: readonly string[],
): number | null {
  let rank: number | undefined;
  for (const id of oldestVisibleIds) {
    const candidate = history.rankById.get(id);
    if (candidate !== undefined && (rank === undefined || candidate > rank)) rank = candidate;
  }
  return rank === undefined ? null : positionOf(rank, history.total);
}

/** Dragging snaps to the day marker nearest the finger. */
export function nearestScrubberDay(
  days: readonly ScrubberDay[],
  position: number,
): ScrubberDay | null {
  let nearest: ScrubberDay | null = null;
  for (const day of days) {
    if (!nearest || Math.abs(day.position - position) < Math.abs(nearest.position - position))
      nearest = day;
  }
  return nearest;
}

/** What the drag bubble says about the day under the finger. */
export function scrubberBubble(day: ScrubberDay): { date: string; detail: string } {
  const who = day.authorHandle ? `@${day.authorHandle}` : day.authorName;
  const back =
    day.messagesBack === 0
      ? 'newest message'
      : `${day.messagesBack} message${day.messagesBack === 1 ? '' : 's'} back`;
  return {
    date: ledgerDayCaption(day.startsAt) ?? '',
    detail: `${ledgerStamp(day.startsAt)} · ${who} · ${back}`,
  };
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
