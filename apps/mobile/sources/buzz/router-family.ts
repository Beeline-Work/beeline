import { useEffect, useSyncExternalStore } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { routerFamilyMode, subscribeRouterOwner } from './router-owner';

/** One existing socket lease while initial protocol negotiation is pending.
 * It sends no read and never advertises a held-key inventory.
 */
let leases = 0;
let stop: (() => void) | undefined;
let opening: Promise<void> | undefined;
function hold(): () => void {
  leases += 1;
  if (!opening && !stop) opening = sharedLiveConnection().register([], () => {}).then(release => {
    opening = undefined;
    if (leases) stop = release; else release();
  }, () => { opening = undefined; });
  return () => { leases -= 1; if (!leases) { stop?.(); stop = undefined; } };
}
export function useRouterFamily(family: Parameters<typeof routerFamilyMode>[0]) {
  const mode = useSyncExternalStore(subscribeRouterOwner, () => routerFamilyMode(family), () => 'pending' as const);
  useEffect(hold, []);
  return mode;
}
export const holdRouterConnection = hold;
