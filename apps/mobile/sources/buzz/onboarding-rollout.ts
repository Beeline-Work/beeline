import { useEffect, useState } from 'react';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Read rollout eligibility without coupling GitHub-only sign-in to provider discovery. */
export async function readRepositoryOnboardingEligibility(): Promise<boolean> {
  try {
    return (await monolithPhoneOperation('getAuthCapabilities', {}))?.repositoryOnboarding === true;
  } catch {
    return false;
  }
}

/** Fail closed: only a server response for the signed-in viewer enables new UI. */
export function useRepositoryOnboarding(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void readRepositoryOnboardingEligibility().then(result => {
      if (alive) setEnabled(result);
    }).catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);
  return enabled;
}
