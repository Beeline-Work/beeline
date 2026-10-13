import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';

type Guard<T> = (value: unknown) => value is T;

export function useSurfaceSnapshot<T>(address: SurfaceCacheAddress | null, guard: Guard<T>): T | null {
  const subscribe = useCallback((listener: () => void) =>
    address ? mobileSurfaceCache.subscribe(address, listener) : () => undefined, [address]);
  const snapshot = useCallback(() => address ? mobileSurfaceCache.peek(address, guard) : null,
    [address, guard]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** A route observes the registry entry itself; only loading and errors belong to the route. */
export function useSharedSurface<T>(
  endpoint: string,
  params: SurfaceCacheAddress['params'] | undefined,
  guard: Guard<T>,
  request: () => Promise<T>,
  enabled = true,
  refreshOnOpen = false,
) {
  const [resolved, setResolved] = useState<{ key: string; address: SurfaceCacheAddress } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reset = useSyncExternalStore(subscribeClientReset, clientResetGeneration);
  const paramsKey = JSON.stringify(params ?? {});
  const addressKey = JSON.stringify([endpoint, paramsKey, reset, enabled]);
  const address = resolved?.key === addressKey ? resolved.address : null;

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (!enabled) { setLoading(false); return () => { cancelled = true; }; }
    setLoading(true);
    void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(([identity, relay]) => {
      if (cancelled || !identity) return;
      setResolved({ key: addressKey, address: surfaceAddress(relay, identity.publicKey, endpoint, JSON.parse(paramsKey)) });
    }).catch((cause) => { if (!cancelled) { setError(String(cause)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [endpoint, paramsKey, reset, enabled, addressKey]);

  const value = useSurfaceSnapshot(address, guard);

  const refresh = useCallback(async () => {
    if (!address) return null;
    try {
      const next = await mobileSurfaceCache.fetch(address, guard, request);
      setError(null);
      return next;
    } catch (cause) {
      setError(String(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [address, guard, request]);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void mobileSurfaceCache.read(address, guard).then((cached) => {
      if (cancelled) return;
      if (cached) setLoading(false);
      else if (!refreshOnOpen) void refresh();
    }).catch(() => { if (!cancelled && !refreshOnOpen) void refresh(); });
    return () => { cancelled = true; };
  }, [address, guard, refresh, refreshOnOpen]);

  return { value, address, loading, error, setError, refresh };
}

/** Paint the cached answer immediately, then read on every open and live change. */
export function useFreshWorkbenchSurface<T>(
  endpoint: string,
  params: SurfaceCacheAddress['params'] | undefined,
  guard: Guard<T>,
  request: () => Promise<T>,
  enabled = true,
) {
  const resource = useSharedSurface(endpoint, params, guard, request, enabled, true);
  const { address, refresh } = resource;
  useFocusEffect(useCallback(() => {
    if (address) void refresh();
  }, [address, refresh]));
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void sharedLiveConnection().register([], (event) => {
      if (cancelled || !('monolithLive' in event)) return;
      const live = event.monolithLive;
      if ((live.type === 'resource-change' &&
          ['workbench', 'install', 'agent'].includes(live.resource)) ||
          (live.type === 'invalidate' && live.roomId === '' && live.reason === 'reconnect'))
        void refresh();
    }).then((unregister) => { if (cancelled) unregister(); else stop = unregister; }, () => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [address, refresh]);
  return resource;
}
