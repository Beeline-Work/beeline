import { useEffect, useState } from 'react';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { watchActiveCommunityId } from '@/buzz/community-storage';
import { subscribeClientReset } from '@/sync/client-reset';

/** Current Workspace for the signed-in viewer; `undefined` until the first value is known. */
export function useActiveCommunityId(): string | null | undefined {
  const [communityId, setCommunityId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    let attempt = 0;
    // An identity or relay change follows the new viewer's current Workspace.
    const follow = () => {
      stop?.();
      stop = undefined;
      setCommunityId(undefined);
      const current = ++attempt;
      void loadBuzzIdentity()
        .catch(() => null)
        .then((identity) => {
          if (cancelled || current !== attempt) return;
          if (!identity) return setCommunityId(null);
          stop = watchActiveCommunityId(identity.publicKey, setCommunityId);
        });
    };
    follow();
    const stopReset = subscribeClientReset(follow);
    return () => {
      cancelled = true;
      stopReset();
      stop?.();
    };
  }, []);
  return communityId;
}
