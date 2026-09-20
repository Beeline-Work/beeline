import type { RoomView } from '@beeline/buzz-client';
import { markRoomOpen } from '@/buzz/room-open-trace';

type Inflight = {
  roomId: string;
  promise: Promise<RoomView | null>;
};

let inflight: Inflight | null = null;
export type RoomOpenPixelSeed = {
  roomId: string;
  text: string;
  agentsOffline: boolean;
};

let pixelSeed: RoomOpenPixelSeed | null = null;

/** Deck already shows the newest line; paint it on the first Room frame. */
export function seedRoomOpenPixel(roomId: string, text: string, agentsOffline = false): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  pixelSeed = { roomId, text: trimmed.slice(0, 280), agentsOffline };
}

export function roomOpenPixelSeed(roomId: string): string | null {
  return pixelSeed?.roomId === roomId ? pixelSeed.text : null;
}

export function roomOpenPixelSnapshot(roomId: string): RoomOpenPixelSeed | null {
  return pixelSeed?.roomId === roomId ? pixelSeed : null;
}

/** Deck tap: seed + navigate. Never start chrome `import()` here — a pending
 *  evaluation occupies the JS thread and steals the tap-to-pixel budget. */
export function dispatchRoomOpenTap(
  roomId: string,
  newestLine: string | undefined,
  next: {
    agentsOffline?: boolean;
    prefetch?: (roomId: string) => void;
    navigate: (roomId: string) => void;
  },
): void {
  markRoomOpen('nav-dispatch', roomId);
  if (newestLine) seedRoomOpenPixel(roomId, newestLine, next.agentsOffline);
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
