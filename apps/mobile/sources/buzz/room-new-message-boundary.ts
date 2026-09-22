import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * One speaker behind an arrival. Identity, not a display name: two people can
 * share a name, and counting them as one understates how many the reader is
 * behind on. The name is carried for the label and the handle disambiguates
 * it when a Room genuinely holds two of them.
 */
export type CatchUpAuthor = {
  pubkey: string;
  name: string;
  handle?: string;
};

export type NewMessageQueue = {
  /** The exact message id the divider represents; relay reports may be nested in a host row. */
  boundaryId: string | null;
  /** Arrivals queued while the reader stayed in history during this visit. */
  count: number;
  /** Who those arrivals are from, distinct by identity and oldest first. */
  authors: readonly CatchUpAuthor[];
};

export const EMPTY_NEW_MESSAGE_QUEUE: NewMessageQueue = {
  boundaryId: null,
  count: 0,
  authors: [],
};

/** Distinct by pubkey, first mention winning, so a shared name still counts twice. */
export function distinctCatchUpAuthors(
  authors: readonly CatchUpAuthor[],
): readonly CatchUpAuthor[] {
  return authors.filter(
    (author, index) => authors.findIndex((other) => other.pubkey === author.pubkey) === index,
  );
}

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
          .map((id) => ({ id, author: catchUpAuthorOf(message) })),
  );
  if (incoming.length === 0) return current;
  // A zero count means the previous batch was visited. Its divider may stay
  // in the ledger, but the next batch starts a new earliest-new boundary and
  // a fresh roll of speakers: the strip stands for what is still unread.
  const carried = current.count > 0 ? current : EMPTY_NEW_MESSAGE_QUEUE;
  return {
    boundaryId: current.count > 0 ? current.boundaryId : incoming[0]!.id,
    count: carried.count + incoming.length,
    authors: distinctCatchUpAuthors([
      ...carried.authors,
      ...incoming.flatMap((arrival) => (arrival.author ? [arrival.author] : [])),
    ]),
  };
}

/** The speaker a row is attributed to, or null for a row with no resolved identity. */
export function catchUpAuthorOf(
  message: Pick<ChatDisplayMessage, 'authorIdentity'>,
): CatchUpAuthor | null {
  const identity = message.authorIdentity;
  if (!identity) return null;
  return {
    pubkey: identity.pubkey,
    name: identity.name,
    ...(identity.handle ? { handle: identity.handle } : {}),
  };
}

/** Hide the strip after its landing while retaining that batch's jump target. */
export function acknowledgeNewMessageQueue(current: NewMessageQueue): NewMessageQueue {
  return current.count > 0 ? { ...current, count: 0, authors: [] } : current;
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
