import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { useObservedResource } from './use-observed-resource';

export async function readRepositoryOnboardingEligibility(): Promise<boolean> {
  return (await monolithPhoneOperation('getAuthCapabilities', {})).repositoryOnboarding === true;
}

/** A failed read stays unknown until an actual recovery reads the server answer. */
export function useRepositoryOnboarding(): boolean | null {
  const resource = useObservedResource('repository-onboarding', {
    load: readRepositoryOnboardingEligibility,
    subscribe: async (_invalidate, refresh) => sharedLiveConnection().register([], event => {
      if ('monolithLive' in event && event.monolithLive.type === 'invalidate' &&
          event.monolithLive.reason === 'reconnect') refresh();
    }),
  });
  return resource.data ?? null;
}
