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
  return {
    roomId,
    before: oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
  };
}

export function advanceRoomHistoryCursor(
  roomId: string,
  page: Pick<RoomHistoryView, 'nextBefore'>,
): RoomHistoryCursorState {
  return { roomId, before: page.nextBefore ?? null };
}
