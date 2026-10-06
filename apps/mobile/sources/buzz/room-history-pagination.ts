import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';

export type RoomHistoryCursor = { readonly createdAt: number; readonly id: string };

export type RoomHistoryCursorState = {
  readonly roomId: string;
  readonly before: RoomHistoryCursor | null;
};

/**
 * Pin pagination to the conversation tail that arrived when this Room opened.
 * Corner tool rows are a separate payload and live refreshes replace the tail;
 * neither may move an in-progress history walk.
 */
export function retainRoomHistoryCursor(
  current: RoomHistoryCursorState | null,
  roomId: string,
  messages: readonly RoomViewMessage[] | undefined,
): RoomHistoryCursorState | null {
  if (current?.roomId === roomId) return current;
  if (!messages) return null;
  const oldest = messages[0];
  // An empty cached response is not a history boundary. A later server read
  // may contain the real tail, so leave the cursor unpinned until then.
  if (!oldest) return null;
  return {
    roomId,
    before: { createdAt: oldest.createdAt, id: oldest.id },
  };
}

/**
 * A fresh tail replaced the one the history walk is pinned to. Rows that slid
 * out of it are still history the walk will never read again, so return them
 * to keep on screen. Return null when the two tails share no row: the rows
 * between them were never read, and the pinned cursor would page past them.
 */
export function displacedTailRows(
  previous: readonly RoomViewMessage[],
  next: readonly RoomViewMessage[],
): readonly RoomViewMessage[] | null {
  const oldest = next[0];
  if (!previous.length || !oldest) return [];
  const nextIds = new Set(next.map((message) => message.id));
  if (!previous.some((message) => nextIds.has(message.id))) return null;
  const at = (message: RoomViewMessage) => message.createdAtMs ?? message.createdAt * 1_000;
  return previous.filter(
    (message) =>
      !nextIds.has(message.id) &&
      (at(message) - at(oldest) || message.id.localeCompare(oldest.id)) < 0,
  );
}

export function advanceRoomHistoryCursor(
  roomId: string,
  page: Pick<RoomHistoryView, 'nextBefore'>,
): RoomHistoryCursorState {
  return { roomId, before: page.nextBefore ?? null };
}
