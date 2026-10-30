import { isRoomView, isChatListView } from '@beeline/buzz-client';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import type { RoomView } from '@beeline/api-contract/phone';
import { loadBuzzViewerPubkey, peekBuzzViewerContext } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { readPushedMonolithRoom } from '@/sync/transport/room-view-client';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { abandonRoomDraw, ensureRoomDraw, openingRoomResponseReady,
  requireOpeningRoomResponse, roomDrawGeneration } from '@/buzz/room-draw-barrier';
import { reconcileRoomView } from '@/buzz/room-view-presentation';

type PendingRoom = {
  responseId: string;
  roomId: string;
  /** The server and account the read was sent for. */
  origin: string;
  viewer: Promise<string | null>;
  generation: number;
  startedAt: number;
  view: Promise<RoomView>;
  releaseRead: () => void;
};

let pending: PendingRoom | null = null;
const MAX_PREFETCH_AGE_MS = 20_000;

// A read started for the previous account or server must not open for the next one.
subscribeClientReset(() => {
  pending = null;
});

/** Start the push's single Room read while initial landing is still resolving. */
export function prefetchPushRoom(responseId: string, roomId: string, messageId?: string): void {
  const config = getBuzzRuntimeConfig();
  if (pending?.responseId === responseId && pending.roomId === roomId) return;
  ensureRoomDraw();
  const drawVisit = roomDrawGeneration();
  markRoomOpen('prefetch-start');
  markRoomOpen('prefetch-target', messageId ?? 'unspecified');
  const generation = clientResetGeneration();
  const warmViewer = peekBuzzViewerContext();
  const hotViewer = warmViewer?.relayUrl === config.monolithUrl ? warmViewer.viewerPubkey : null;
  const viewer = hotViewer ? Promise.resolve(hotViewer) : loadBuzzViewerPubkey().catch(() => null);
  let releaseRead!: () => void;
  const afterPaint = new Promise<void>((resolve) => { releaseRead = resolve; });
  const read = () => {
    if (generation !== clientResetGeneration() || config.monolithUrl !== getBuzzRuntimeConfig().monolithUrl)
      throw new Error('The Room open belongs to another account or server.');
    markRoomOpen('prefetch-network-start');
    return readPushedMonolithRoom(roomId);
  };
  const openCached = async (pubkey: string | null, cached: RoomView | null): Promise<RoomView> => {
    const address = pubkey ? surfaceAddress(config.monolithUrl, pubkey, `/room/${roomId}`) : null;
    const list = pubkey && cached?.room.workspaceId ? mobileSurfaceCache.peek(surfaceAddress(
      config.monolithUrl, pubkey, '/workspace/:id/chats', { workspaceId: cached.room.workspaceId },
    ), isChatListView) : null;
    const newestId = messageId ?? list?.chats.find((chat) => chat.room.id === roomId)?.latestMessage?.id;
    // A received row paints from the scoped response first. A missing row
    // starts its read now, rather than waiting for navigation or a handshake.
    const received = Boolean(cached && (!newestId || cached.messages.some((message) => message.id === newestId)));
    markRoomOpen('prefetch-cache', `${received ? 'received' : 'missing'}:${cached?.messages.at(-1)?.id ?? 'empty'}`);
    if (received) return afterPaint.then(read);
    requireOpeningRoomResponse(drawVisit);
    if (!address) return read();
    // An opening read can finish before the Room's asynchronous session setup.
    // Publish its authorized response now so that setup sees the fresh rows.
    const stamp = currentSurfaceStamp();
    const view = await read();
    if (generation !== clientResetGeneration() ||
        config.monolithUrl !== getBuzzRuntimeConfig().monolithUrl ||
        pubkey !== await loadBuzzViewerPubkey())
      throw new Error('The opening Room was read for another account or server.');
    const response = mobileSurfaceCache.publish(address,
      reconcileRoomView(mobileSurfaceCache.peek(address, isRoomView), view), isRoomView, stamp);
    void mobileSurfaceCache.persist(address, response, isRoomView).catch(() => undefined);
    return response;
  };
  const hotAddress = hotViewer ? surfaceAddress(config.monolithUrl, hotViewer, `/room/${roomId}`) : null;
  const hotCache = hotAddress ? mobileSurfaceCache.peek(hotAddress, isRoomView) : null;
  // A warm authorized cache can decide whether to fetch on the tap's stack,
  // before navigation renders. Cold storage retains its asynchronous path.
  const view = hotViewer && hotCache
    ? openCached(hotViewer, hotCache)
    : viewer.then(async (pubkey) => {
      const address = pubkey ? surfaceAddress(config.monolithUrl, pubkey, `/room/${roomId}`) : null;
      const cached = address ? await mobileSurfaceCache.read(address, isRoomView).catch(() => null) : null;
      return openCached(pubkey, cached);
    });
  void view.then(() => markRoomOpen('prefetch-end'), () => markRoomOpen('prefetch-error'));
  void view.then(view => openingRoomResponseReady(view.messages.at(-1)?.id, drawVisit),
    () => abandonRoomDraw(drawVisit));
  // The route may never mount (for example, if the tap is superseded). Its
  // read must not produce an unhandled rejection in that case.
  void view.catch(() => undefined);
  pending = { responseId, roomId, origin: config.monolithUrl, viewer, generation, startedAt: Date.now(), view, releaseRead };
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
  current.releaseRead();
  return Promise.all([current.view, current.viewer, loadBuzzViewerPubkey()]).then(([view, started, viewer]) => {
    if (started !== viewer || current.generation !== clientResetGeneration())
      throw new Error('The pushed Room was read for another account.');
    return view;
  });
}

/** Room-list taps share the scoped opening read without changing navigation. */
export function prefetchRoomOpen(roomId: string): void {
  prefetchPushRoom(`room-open:${roomId}`, roomId);
}
