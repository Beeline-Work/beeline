import type { ChatDisplayMessage } from './room-view-presentation';

export type NewMessageQueue = {
  /** The exact message id the divider represents; relay reports may be nested in a host row. */
  boundaryId: string | null;
  /** Arrivals queued while the reader stayed in history during this visit. */
  count: number;
};

export const EMPTY_NEW_MESSAGE_QUEUE: NewMessageQueue = { boundaryId: null, count: 0 };

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

/** One fixed-width label; double digits never widen or reflow the control. */
export function compactNewMessageCount(count: number): string {
  return count > 9 ? '9+' : String(Math.max(1, count));
}

/**
 * Queue only incoming rows that arrived while the reader was away from the
 * tail. The first one owns the boundary; later arrivals increase the compact
 * count without moving it.
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
    message.isUser ? [] : messageBoundaryIds(message).filter((id) => arrivingIds.has(id)),
  );
  if (incoming.length === 0) return current;
  return {
    // A zero count means the previous batch was visited. Its divider may stay
    // in the ledger, but the next batch starts a new earliest-new boundary.
    boundaryId: current.count > 0 ? current.boundaryId : incoming[0]!,
    count: current.count + incoming.length,
  };
}

/** Hide the control after its landing while retaining that batch's divider. */
export function acknowledgeNewMessageQueue(current: NewMessageQueue): NewMessageQueue {
  return current.count > 0 ? { ...current, count: 0 } : current;
}
