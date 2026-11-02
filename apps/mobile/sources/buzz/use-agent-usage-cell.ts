import { useCallback, useSyncExternalStore } from 'react';
import { subscribeUsageCell, usageCellSnapshot } from './agent-usage-cell';
/** Canonical usage is independent from the profile/catalog domain. This hook
 * cannot request data or merge a usage event into an AgentDetailView.
 */
export function useAgentUsageCell(agentId: string | null | undefined) {
  const snapshot = useCallback(() => usageCellSnapshot(agentId), [agentId]);
  return useSyncExternalStore(subscribeUsageCell, snapshot, snapshot);
}
