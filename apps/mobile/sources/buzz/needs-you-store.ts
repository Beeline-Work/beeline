import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useRouterFamily } from './router-family';
import { acquireRouterLane, routerLaneSnapshot } from './router-owner';

/** The app badge observes the canonical count lane on the main socket. */
export function useNeedsYouCount(workspaceId: string | null | undefined, refreshKey: unknown, visible?: () => boolean) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const mode = useRouterFamily('needs-you-count');
  const subscribeCount = useCallback((listener: () => void) => {
    if (!workspaceId || refreshKey === undefined) return () => {};
    const lane = acquireRouterLane({ family: 'needs-you-count', workspaceId }, () => visibleRef.current?.() ?? true, listener);
    return lane.release;
  }, [workspaceId, refreshKey === undefined]);
  const snapshot = useCallback(() => {
    if (!workspaceId || mode !== 'router') return 0;
    const value = routerLaneSnapshot({ family: 'needs-you-count', workspaceId }).value as { count?: number } | null;
    return value?.count ?? 0;
  }, [mode, workspaceId]);
  const count = useSyncExternalStore(subscribeCount, snapshot, () => 0);
  return count;
}
