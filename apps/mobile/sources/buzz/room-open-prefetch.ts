import type { RoomView } from '@beeline/buzz-client';

type Inflight = {
  roomId: string;
  promise: Promise<RoomView | null>;
};

let inflight: Inflight | null = null;
let pixelSeed: { roomId: string; text: string } | null = null;

/** Deck already shows the newest line; paint it on the first Room frame. */
export function seedRoomOpenPixel(roomId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  pixelSeed = { roomId, text: trimmed.slice(0, 280) };
}

export function roomOpenPixelSeed(roomId: string): string | null {
  return pixelSeed?.roomId === roomId ? pixelSeed.text : null;
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
