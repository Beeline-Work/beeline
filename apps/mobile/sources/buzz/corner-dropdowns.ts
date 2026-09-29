import React from 'react';
import type { ChatListItem } from '@beeline/buzz-client';

/** One of the viewer's own corners in this Room is waiting on a person. */
export function roomHasMineWaiting(item: ChatListItem): boolean {
  return (item.openCorners ?? []).some((corner) => corner.mine && corner.state === 'waiting');
}

export function mineWaitingRooms(chats: readonly ChatListItem[]): ReadonlySet<string> {
  return new Set(chats.filter(roomHasMineWaiting).map((item) => item.room.id));
}

/**
 * Open a Room's corner dropdown when one of the viewer's corners there starts
 * waiting, and close it once none is. Rooms whose waiting did not change keep
 * whatever the viewer toggled.
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
  React.useEffect(() => {
    if (!chats) return;
    const previous = wasWaiting.current;
    const waiting = mineWaitingRooms(chats);
    wasWaiting.current = waiting;
    setExpanded((current) => nextExpandedRooms(current, previous, waiting, chats));
  }, [chats]);
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
