import type { RoomView } from '@beeline/api-contract/phone';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { readPushedMonolithRoom } from '@/sync/transport/room-view-client';
import { markRoomOpen } from '@/buzz/room-open-trace';

type PendingRoom = {
  responseId: string;
  roomId: string;
  startedAt: number;
  view: Promise<RoomView>;
};

let pending: PendingRoom | null = null;
const MAX_PREFETCH_AGE_MS = 20_000;

/** Start the push's single Room read while initial landing is still resolving. */
export function prefetchPushRoom(responseId: string, roomId: string): void {
  if (!getBuzzRuntimeConfig().monolithEnabled) return;
  if (pending?.responseId === responseId && pending.roomId === roomId) return;
  markRoomOpen('prefetch-start');
  const view = readPushedMonolithRoom(roomId);
  void view.then(() => markRoomOpen('prefetch-end'), () => markRoomOpen('prefetch-error'));
  // The route may never mount (for example, if the tap is superseded). Its
  // read must not produce an unhandled rejection in that case.
  void view.catch(() => undefined);
  pending = { responseId, roomId, startedAt: Date.now(), view };
}

/** A response id binds this read to one push, rather than any later Room visit. */
export function takePrefetchedPushRoom(responseId: string, roomId: string): Promise<RoomView> | null {
  const current = pending;
  if (!current || current.responseId !== responseId || current.roomId !== roomId) return null;
  pending = null;
  return Date.now() - current.startedAt <= MAX_PREFETCH_AGE_MS ? current.view : null;
}
