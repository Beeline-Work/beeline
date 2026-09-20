import type { RoomView } from '@beeline/buzz-client';
import { markRoomOpen } from '@/buzz/room-open-trace';

let inflightRoomId: string | null = null;

/** Deck tap: prefetch + navigate. Never evaluate chrome here — a pending
 *  `import()` occupies the JS thread on the tap itself. */
export function dispatchRoomOpenTap(
  roomId: string,
  next: {
    prefetch?: (roomId: string) => void;
    navigate: (roomId: string) => void;
  },
): void {
  markRoomOpen('nav-dispatch', roomId);
  next.prefetch?.(roomId);
  next.navigate(roomId);
}

/**
 * Warm the Room cache at deck press so the opening screen has something to
 * paint. This snapshot is taken before the live socket exists, so it can
 * never be the open's covering read — that one waits for listen-ready.
 */
export function beginRoomOpenPrefetch(
  roomId: string,
  fetchRoom: () => Promise<RoomView>,
  writeCache: (view: RoomView) => Promise<void>,
): void {
  if (inflightRoomId === roomId) return;
  inflightRoomId = roomId;
  void fetchRoom()
    .then((view) => writeCache(view))
    .catch(() => undefined)
    .finally(() => {
      if (inflightRoomId === roomId) inflightRoomId = null;
    });
}
