import type { RoomView } from '@beeline/buzz-client';
import { markRoomOpen } from '@/buzz/room-open-trace';

type Inflight = {
  roomId: string;
  promise: Promise<RoomView | null>;
};

let inflight: Inflight | null = null;

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

/** Start the Room GET at deck press so navigation and fetch overlap. */
export function beginRoomOpenPrefetch(
  roomId: string,
  fetchRoom: () => Promise<RoomView>,
  writeCache: (view: RoomView) => Promise<void>,
): void {
  if (inflight?.roomId === roomId) return;
  inflight = {
    roomId,
    promise: fetchRoom()
      .then(async (view) => {
        await writeCache(view);
        return view;
      })
      .catch(() => null),
  };
}

export function takeRoomOpenPrefetch(roomId: string): Promise<RoomView | null> | null {
  if (inflight?.roomId !== roomId) return null;
  const current = inflight;
  inflight = null;
  return current.promise;
}
