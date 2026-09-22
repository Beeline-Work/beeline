import type { ChatDisplayMessage } from './room-view-presentation';

export type NewMessageQueue = {
  /** The exact message id the divider represents; relay reports may be nested in a host row. */
  boundaryId: string | null;
  /** Arrivals queued while the reader stayed in history during this visit. */
  count: number;
  /** Who those arrivals are from, distinct and oldest first, for the catch-up strip. */
  authorNames: readonly string[];
};

export const EMPTY_NEW_MESSAGE_QUEUE: NewMessageQueue = {
  boundaryId: null,
  count: 0,
  authorNames: [],
};

/** Folding may place a relayed message inside its host card. The divider belongs to the host row. */
export function messageContainsBoundary(
  message: Pick<ChatDisplayMessage, 'id' | 'foldedIds' | 'relayReports'>,
  boundaryId: string | null | undefined,
): boolean {
  if (!boundaryId) return false;
  return (
    message.id === boundaryId ||
    Boolean(message.foldedIds?.includes(boundaryId)) ||
    Boolean(message.relayReports?.some((report) => report.id === boundaryId))
  );
}

/** Every durable id represented by one virtualized row, in transcript order. */
export function messageBoundaryIds(
  message: Pick<ChatDisplayMessage, 'id' | 'foldedIds' | 'relayReports'>,
): string[] {
  return [
    message.id,
    ...(message.foldedIds ?? []),
    ...(message.relayReports?.map((report) => report.id) ?? []),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

export function boundaryRowIndex(
  messages: readonly Pick<ChatDisplayMessage, 'id' | 'foldedIds' | 'relayReports'>[],
  boundaryId: string | null | undefined,
): number {
  return messages.findIndex((message) => messageContainsBoundary(message, boundaryId));
}

/** One fixed-width label; double digits never widen or reflow the badge. */
export function compactNewMessageCount(count: number): string {
  return count > 9 ? '9+' : String(Math.max(1, count));
}

/**
 * Queue only incoming rows that arrived while the reader was away from the
 * tail. The first one owns the boundary; later arrivals increase the compact
 * count without moving it, and name themselves for the catch-up strip.
 */
export function queueIncomingMessages(
  current: NewMessageQueue,
  {
    messages,
    arrivingIds,
    isPinnedToTail,
  }: {
    messages: readonly ChatDisplayMessage[];
    arrivingIds: ReadonlySet<string>;
    isPinnedToTail: boolean;
  },
): NewMessageQueue {
  if (isPinnedToTail || arrivingIds.size === 0) return current;
  const incoming = messages.flatMap((message) =>
    message.isUser
      ? []
      : messageBoundaryIds(message)
          .filter((id) => arrivingIds.has(id))
          .map((id) => ({ id, authorName: message.authorIdentity?.name ?? null })),
  );
  if (incoming.length === 0) return current;
  // A zero count means the previous batch was visited. Its divider may stay
  // in the ledger, but the next batch starts a new earliest-new boundary and
  // a fresh roll of names: the strip summarises what is still unread.
  const carried = current.count > 0 ? current : EMPTY_NEW_MESSAGE_QUEUE;
  const authorNames = [
    ...carried.authorNames,
    ...incoming.flatMap((arrival) => (arrival.authorName ? [arrival.authorName] : [])),
  ];
  return {
    boundaryId: current.count > 0 ? current.boundaryId : incoming[0]!.id,
    count: carried.count + incoming.length,
    authorNames: authorNames.filter((name, index) => authorNames.indexOf(name) === index),
  };
}

/** Hide the strip after its landing while retaining that batch's jump target. */
export function acknowledgeNewMessageQueue(current: NewMessageQueue): NewMessageQueue {
  return current.count > 0 ? { ...current, count: 0, authorNames: [] } : current;
}

/**
 * The strip's one line: how far behind the reader is, and who they are behind
 * on. Uncompacted — the strip runs the width of the transcript and a reader
 * deciding whether to catch up now is owed the real number.
 */
export function catchUpSummaryText(queue: NewMessageQueue): string {
  const run = `${queue.count} new ${queue.count === 1 ? 'message' : 'messages'}`;
  const [first, second, ...rest] = queue.authorNames;
  if (!first) return run;
  if (!second) return `${run} from ${first}`;
  if (rest.length === 0) return `${run} from ${first} and ${second}`;
  return `${run} from ${first}, ${second} and ${rest.length} other${rest.length === 1 ? '' : 's'}`;
}

/**
 * Viewport visibility of the newest row decides every one of the three rules
 * below — never tail distance. A reader parked a finger's width above the
 * tail is still looking straight at the newest message, and Slack shows them
 * nothing there.
 *
 * `messages` is in transcript order, so the newest row is its last entry on
 * both lists: the phone reverses that array for its inverted FlatList, but
 * the durable id is the same either way.
 */
export function newestTranscriptRowId(
  messages: readonly Pick<ChatDisplayMessage, 'id'>[],
): string | null {
  return messages.at(-1)?.id ?? null;
}

/**
 * The disc is a way back to newest, so it shows whenever the newest row is
 * off screen — with or without a queue behind it. The pill it replaces only
 * ever appeared for unread mail, which left a reader who had scrolled up to
 * re-read something with no way back down but their own thumb.
 *
 * `hasObservedVisibility` is the list's first viewability pass. Before it
 * runs nothing is known about the viewport, and a disc drawn on that silence
 * would flash over every Room at open.
 */
export function newestJumpDiscVisible({
  newestMessageId,
  newestMessageVisible,
  hasObservedVisibility,
}: {
  newestMessageId: string | null;
  newestMessageVisible: boolean;
  hasObservedVisibility: boolean;
}): boolean {
  return hasObservedVisibility && newestMessageId !== null && !newestMessageVisible;
}

/**
 * The badge counts what the reader has not seen, so seeing the newest row
 * clears it — reaching newest under their own finger settles the count
 * exactly as a tap on the disc would, and the disc itself stays for as long
 * as newest is off screen.
 */
export function newMessageBadgeCount(
  queue: NewMessageQueue,
  newestMessageVisible: boolean,
): number {
  return newestMessageVisible ? 0 : queue.count;
}

/** The catch-up strip stands for the unread run itself, so an empty queue retires it. */
export function catchUpStripVisible(
  queue: NewMessageQueue,
  newestMessageVisible: boolean,
): boolean {
  return queue.count > 0 && queue.boundaryId !== null && !newestMessageVisible;
}
