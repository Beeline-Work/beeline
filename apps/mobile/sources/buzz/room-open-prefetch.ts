import { markRoomOpen } from '@/buzz/room-open-trace';

/** Navigate once; destination focus owns the Room snapshot. */
export function dispatchRoomOpenTap(
  roomId: string,
  next: {
    navigate: (roomId: string) => void;
  },
): void {
  markRoomOpen('nav-dispatch', roomId);
  next.navigate(roomId);
}
