import { useEffect, useState } from 'react';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { watchActiveCommunityId } from '@/buzz/community-storage';

/** Current Workspace for the signed-in viewer; `undefined` until the first value is known. */
export function useActiveCommunityId(): string | null | undefined {
  const [communityId, setCommunityId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void loadBuzzIdentity()
      .catch(() => null)
      .then((identity) => {
        if (cancelled) return;
        if (!identity) return setCommunityId(null);
        stop = watchActiveCommunityId(identity.publicKey, setCommunityId);
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return communityId;
}
