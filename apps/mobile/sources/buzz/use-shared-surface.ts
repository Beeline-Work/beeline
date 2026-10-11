import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
) {
  const [address, setAddress] = useState<SurfaceCacheAddress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reset = useSyncExternalStore(subscribeClientReset, clientResetGeneration);
  const paramsKey = JSON.stringify(params ?? {});

  useEffect(() => {
    let cancelled = false;
    setAddress(null);
    if (!enabled) { setLoading(false); return () => { cancelled = true; }; }
    setLoading(true);
    void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(([identity, relay]) => {
      if (cancelled || !identity) return;
      setAddress(surfaceAddress(relay, identity.publicKey, endpoint, JSON.parse(paramsKey)));
    }).catch((cause) => { if (!cancelled) { setError(String(cause)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [endpoint, paramsKey, reset, enabled]);

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
      else void refresh();
    }).catch(() => { if (!cancelled) void refresh(); });
    return () => { cancelled = true; };
  }, [address, guard, refresh]);

  return { value, address, loading, error, setError, refresh };
}
