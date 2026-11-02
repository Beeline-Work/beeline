import { useSyncExternalStore } from 'react';
import { mediaRecoveryRevision, subscribeMediaRecovery } from './media-cache-connection';
/** Only a successful capable socket epoch advances this signal. Blur,
 * foreground, errors and component remounts cannot request a replacement read.
 */
export function useArtifactRecoveryGeneration(): number {
  return useSyncExternalStore(subscribeMediaRecovery, mediaRecoveryRevision, () => 0);
}
