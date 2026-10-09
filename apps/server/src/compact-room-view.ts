import type { RoomHistoryView, RoomView, RoomViewMessage } from '@beeline/api-contract/phone';

/** A phone that rebuilds derivable fields asks for Room reads without them. */
export const COMPACT_VIEW_HEADER = 'x-beeline-view';

export function wantsCompactView(header: string | string[] | undefined): boolean {
  return header === 'compact';
}

/**
 * One message without what its reader derives (`readScopedMessage`,
 * packages/api-contract/src/phone-guards.ts): the whole-second `createdAt`
 * beside `createdAtMs`, and a top-level message's own reference
 * `{channelId: room, eventId: id, rootId: id}`. A reply's reference names
 * another root, so it stays.
 */
function compactMessage(message: RoomViewMessage, roomId: string): RoomViewMessage {
  const { createdAt, reference, ...rest } = message;
  const derivableTime =
    typeof message.createdAtMs === 'number' && createdAt === Math.floor(message.createdAtMs / 1000);
  const derivableReference =
    message.presentation === 'message' &&
    reference?.channelId === roomId &&
    reference.eventId === message.id &&
    reference.rootId === message.id;
  return {
    ...rest,
    ...(derivableTime ? {} : { createdAt }),
    ...(reference && !derivableReference ? { reference } : {}),
  } as RoomViewMessage;
}

/**
 * A Room read for a phone that rebuilds derivable fields. Compression
 * already folds repeats, but these fields are a sixth of a compressed Room
 * read, and `watchFilters` is a relay-era list the phone no longer reads.
 */
export function compactRoomView(view: RoomView): Omit<RoomView, 'watchFilters'> {
  const roomId = view.room.id;
  const { watchFilters: _unread, ...rest } = view;
  return {
    ...rest,
    messages: view.messages.map((message) => compactMessage(message, roomId)),
    ...(view.toolRows
      ? { toolRows: view.toolRows.map((message) => compactMessage(message, roomId)) }
      : {}),
  };
}

export function compactRoomHistoryView(view: RoomHistoryView): RoomHistoryView {
  return {
    ...view,
    messages: view.messages.map((message) => compactMessage(message, view.roomId)),
  };
}
