import React from 'react';
import type { ChatListItem } from '@beeline/buzz-client';
import { useRoomCornerSummaries, type RoomCornerSummary } from './room-corner-store';

/** One of the corners in this Room owes the viewer something they have not opened it to see. */
export function roomHasMineWaiting(summary: RoomCornerSummary | undefined): boolean {
  return (summary?.openCorners ?? []).some((corner) => corner.attention);
}

export function mineWaitingRooms(
  chats: readonly ChatListItem[],
  summaries: ReadonlyMap<string, RoomCornerSummary>,
): ReadonlySet<string> {
  return new Set(chats
    .filter((item) => roomHasMineWaiting(summaries.get(item.room.id)))
    .map((item) => item.room.id));
}

/**
 * Open a Room's corner dropdown when one of the corners there starts waiting
 * on the viewer, and close it once none is unseen. Rooms whose waiting did
 * not change keep whatever the viewer toggled.
 */
export function nextExpandedRooms(
  expanded: ReadonlySet<string>,
  wasWaiting: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
  chats: readonly ChatListItem[],
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of waiting) {
    if (wasWaiting.has(id) || expanded.has(id)) continue;
    (next ??= new Set(expanded)).add(id);
  }
  for (const id of wasWaiting) {
    if (waiting.has(id) || !chats.some((item) => item.room.id === id)) continue;
    (next ??= new Set(expanded)).delete(id);
  }
  return next ?? expanded;
}

/** Which Rooms' corner dropdowns are open, with the viewer's tap as a toggle. */
export function useCornerDropdowns(chats: readonly ChatListItem[] | undefined) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const wasWaiting = React.useRef<ReadonlySet<string>>(new Set());
  const summaries = useRoomCornerSummaries();
  React.useEffect(() => {
    if (!chats) return;
    const previous = wasWaiting.current;
    const waiting = mineWaitingRooms(chats, summaries);
    wasWaiting.current = waiting;
    setExpanded((current) => nextExpandedRooms(current, previous, waiting, chats));
  }, [chats, summaries]);
  const toggle = React.useCallback((roomId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
  }, []);
  return { expanded, setExpanded, toggle };
}
