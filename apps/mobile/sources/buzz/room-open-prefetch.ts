import { prefetchRoomOpen } from '@/push/push-room-prefetch';
import { markRoomOpen } from '@/buzz/room-open-trace';

/** Start a missing-row read at the tap without waiting for it to navigate. */
export function dispatchRoomOpenTap(
  roomId: string,
  next: {
    navigate: (roomId: string) => void;
  },
): void {
  markRoomOpen('nav-dispatch', roomId);
  prefetchRoomOpen(roomId);
  next.navigate(roomId);
}
