import { useEffect, useState } from 'react';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Fail closed: only a server response for the signed-in viewer enables new UI. */
export function useRepositoryOnboarding(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => monolithPhoneOperation('getAuthCapabilities', {})).then(result => {
      if (alive) setEnabled(result?.repositoryOnboarding === true);
    }).catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);
  return enabled;
}
