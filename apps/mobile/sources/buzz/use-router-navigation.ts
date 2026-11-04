import { useRootNavigationState } from 'expo-router';
import { useLayoutEffect } from 'react';
import { routerOwnerNavigation } from './router-owner';

/** Committed navigation state, rather than route mount/effect lifetime, owns
 * residency identity. Replaying layout effects joins the same focused key.
 */
export function useRouterNavigationOwner(): void {
  const state = useRootNavigationState();
  useLayoutEffect(() => { if (state) routerOwnerNavigation(state); }, [state]);
}
