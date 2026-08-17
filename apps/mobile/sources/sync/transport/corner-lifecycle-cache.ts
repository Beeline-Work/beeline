/**
 * Short-TTL cache for `listSubchannelLifecycle`/`listSubchannelLifecycleForRooms`
 * results, keyed by parent Room id. Split out of `buzz-rig-transport.ts` so
 * `local-cache-sync.ts` (and any other caller that only needs to invalidate
 * an entry) can import it without pulling in the full Buzz transport module
 * and its React Native-touching dependency chain.
 */
import type { CornerSummary } from '@/buzz/corners';

const CORNER_LIFECYCLE_CACHE_TTL_MS = 5_000;
const cornerLifecycleCache = new Map<
  string,
  { expiresAt: number; result: Promise<CornerSummary[]> }
>();

export function getCachedCornerLifecycle(parentChannelId: string): Promise<CornerSummary[]> | undefined {
  const entry = cornerLifecycleCache.get(parentChannelId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cornerLifecycleCache.delete(parentChannelId);
    return undefined;
  }
  return entry.result;
}

export function setCachedCornerLifecycle(
  parentChannelId: string,
  result: Promise<CornerSummary[]>,
): void {
  cornerLifecycleCache.set(parentChannelId, {
    expiresAt: Date.now() + CORNER_LIFECYCLE_CACHE_TTL_MS,
    result,
  });
}

/** Invalidate one parent Room's cached corner lifecycle snapshot. */
export function invalidateCornerLifecycleCache(parentChannelId: string): void {
  cornerLifecycleCache.delete(parentChannelId);
}

/** Drop every cached entry, e.g. when the underlying client's identity changes. */
export function clearCornerLifecycleCache(): void {
  cornerLifecycleCache.clear();
}
