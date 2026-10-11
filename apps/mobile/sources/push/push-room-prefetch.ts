import type { RoomView } from '@beeline/api-contract/phone';
import { loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { readPushedMonolithRoom } from '@/sync/transport/room-view-client';
import { markRoomOpen } from '@/buzz/room-open-trace';

type PendingRoom = {
  responseId: string;
  roomId: string;
  /** The server and account the read was sent for. */
  origin: string;
  viewer: Promise<string | null>;
  generation: number;
  startedAt: number;
  view: Promise<RoomView>;
};

let pending: PendingRoom | null = null;
const MAX_PREFETCH_AGE_MS = 20_000;

// A read started for the previous account or server must not open for the next one.
subscribeClientReset(() => {
  pending = null;
});

/** Start the push's single Room read while initial landing is still resolving. */
export function prefetchPushRoom(responseId: string, roomId: string): void {
  const config = getBuzzRuntimeConfig();
  if (!config.monolithEnabled) return;
  if (pending?.responseId === responseId && pending.roomId === roomId) return;
  markRoomOpen('prefetch-start');
  const generation = clientResetGeneration();
  const viewer = loadBuzzViewerPubkey().catch(() => null);
  const view = readPushedMonolithRoom(roomId);
  void view.then(() => markRoomOpen('prefetch-end'), () => markRoomOpen('prefetch-error'));
  // The route may never mount (for example, if the tap is superseded). Its
  // read must not produce an unhandled rejection in that case.
  void view.catch(() => undefined);
  pending = { responseId, roomId, origin: config.monolithUrl, viewer, generation, startedAt: Date.now(), view };
}

/**
 * A response id binds this read to one push, rather than any later Room visit.
 * The read is refused when the account or server changed after it started.
 */
export function takePrefetchedPushRoom(responseId: string, roomId: string): Promise<RoomView> | null {
  const current = pending;
  if (!current || current.responseId !== responseId || current.roomId !== roomId) return null;
  pending = null;
  if (Date.now() - current.startedAt > MAX_PREFETCH_AGE_MS) return null;
  if (current.generation !== clientResetGeneration() ||
      current.origin !== getBuzzRuntimeConfig().monolithUrl) return null;
  return Promise.all([current.view, current.viewer, loadBuzzViewerPubkey()]).then(([view, started, viewer]) => {
    if (started !== viewer || current.generation !== clientResetGeneration())
      throw new Error('The pushed Room was read for another account.');
    return view;
  });
}
