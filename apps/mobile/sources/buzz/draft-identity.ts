import { useEffect, useState } from 'react';
import { loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';

/** Public addressing only. Explicit identity owners bypass this fallback. */
export function useDraftIdentity(explicit: string | null | undefined) {
  const [identity, setIdentity] = useState<string | null>(null);
  useEffect(() => {
    if (explicit !== undefined) return;
    let alive = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      setIdentity(null);
      void loadBuzzViewerPubkey()
        .then((value) => {
          if (alive && generation === current) setIdentity(value);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = monolithSession.subscribeIdentityChange(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [explicit]);
  return explicit === undefined ? identity : explicit;
}
