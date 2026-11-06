import { useSyncExternalStore } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';

export function useArtifactRecoveryGeneration(): number {
  const connection = sharedLiveConnection();
  return useSyncExternalStore(listener => connection.subscribeConnected(listener),
    () => connection.commandState().generation, () => 0);
}
