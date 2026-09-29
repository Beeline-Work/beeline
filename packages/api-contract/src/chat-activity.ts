import type { ChatListItem } from './phone-types.js';

/**
 * When a Room last had activity, the one key the Room list is ordered by. A
 * viewer's own corner going to waiting is activity in its Room, so the server's
 * order and the phone's live re-sort both read it here.
 */
export function chatActivityAt(
  item: Pick<ChatListItem, 'room' | 'latestMessage' | 'openCorners'>,
): number {
  let at = item.latestMessage?.createdAt ?? item.room.updatedAt ?? 0;
  for (const corner of item.openCorners ?? []) {
    if (corner.waitingSince !== undefined && corner.waitingSince > at) at = corner.waitingSince;
  }
  return at;
}
