import { markRoomOpen } from '@/buzz/room-open-trace';

/** Deck tap: navigate. Never evaluate chrome here — a pending `import()`
 *  occupies the JS thread on the tap itself. The Room's one read belongs to
 *  the chat session, which waits for its live socket first. */
export function dispatchRoomOpenTap(
  roomId: string,
  next: {
    navigate: (roomId: string) => void;
  },
): void {
  markRoomOpen('nav-dispatch', roomId);
  next.navigate(roomId);
}
