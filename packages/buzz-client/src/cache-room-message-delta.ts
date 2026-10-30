import { isRoomView } from './surface-guards.js';
import type { SurfaceCacheAddress } from './surface-cache.js';
import type { RoomLiveDelta } from '@beeline/api-contract/phone';
import type { SurfaceRegistry } from './surface-registry.js';
import { reconcileRoomMessageDelta } from './room-view-reconcile.js';

/** Apply only a complete committed row to an existing authorized Room response. */
export function cacheRoomMessageDelta(
  cache: Pick<SurfaceRegistry, 'peek' | 'publish' | 'read'>,
  address: SurfaceCacheAddress,
  live: Extract<RoomLiveDelta, { type: 'message-delta' }>,
): void {
  const message = live.version === undefined ? live.message : { ...live.message, version: live.version };
  const apply = () => {
    const room = cache.peek(address, isRoomView);
    if (!room) return false;
    // The list already received this committed row. The next Room visit
    // must paint it from the same scoped response before its covering read.
    cache.publish(address, reconcileRoomMessageDelta(room, message), isRoomView);
    return true;
  };
  if (!apply()) {
    // The response may have left the bounded hot cache but still be on
    // the phone. The registry coalesces concurrent local restores.
    void cache.read(address, isRoomView).then((room) => {
      if (room) apply();
    }).catch(() => undefined);
  }
}
