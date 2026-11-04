import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { RouterSnapshotInput, RouterValues } from '@beeline/api-contract/router-protocol';
import { acquireRouterLane, retryRouterLane } from './router-owner';
import { useRouterFamily } from './router-family';

const empty = Object.freeze({ state: 'ABSENT' as const, value: null, error: null, cut: null });
const noop = () => {};
const detached = () => noop;

type DisplayResourceFamily = 'room-workflows' | 'owner-workbench' | 'owner-wallet' | 'agent-profile';

/** The existing navigation owner spends the route-bound opportunity. Effects
 * attach consumers only; no invalidation, elapsed time or response opens it. */
export function useRoutedResource<F extends DisplayResourceFamily>(family: F, input: (RouterSnapshotInput & { family: F }) | undefined, focused: boolean,
  validate?:(value:unknown)=>boolean) {
  if (!['room-workflows', 'owner-workbench', 'owner-wallet', 'agent-profile'].includes(family) || input && input.family !== family)
    throw new Error('Display resource must match its declared family');
  const mode = useRouterFamily(family), visible = useRef(focused); visible.current = focused;
  const key = input ? JSON.stringify(input) : '';
  const request = useMemo(() => input, [key]);
  const listener=useMemo(()=>()=>{},[]);
  const [held, setHeld] = useState<{ key: string; handle: ReturnType<typeof acquireRouterLane> }>();
  useEffect(() => {
    if (mode !== 'router' || !focused || !request) { setHeld(undefined); return; }
    const handle = acquireRouterLane(request, () => visible.current && AppState.currentState === 'active', listener,validate);
    setHeld({ key, handle }); return handle.release;
  }, [mode, focused, request, key,listener,validate]);
  const current = mode === 'router' && focused && held?.key === key ? held.handle : undefined;
  const view = useSyncExternalStore(current?.subscribe ?? detached, () => current?.current() ?? empty, () => empty);
  return { mode, value: mode === 'router' ? view.value as RouterValues[F] | null : null,
    loading: mode === 'pending' || mode === 'router' && (view.state === 'ABSENT' || view.state === 'OPENING'),
    error: mode === 'router' ? view.error : null,
    retry: () => { if (mode === 'router' && focused && request) retryRouterLane(request); } };
}
