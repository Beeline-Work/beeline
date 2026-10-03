import { useEffect, useRef } from 'react';
import { observeRoomResource, useObservedResource } from './use-observed-resource';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * The run a corner's workflow line names: a live run of a saved workflow
 * working in this corner, else the corner's own lifecycle run while it is live.
 */
export function pickCornerWorkflowRun(
  cornerId: string,
  runs: readonly WorkflowRunSummaryView[],
): WorkflowRunSummaryView | undefined {
  const live = runs.filter((run) => run.roomId === cornerId && run.status === 'live');
  return live.find((run) => run.workflowSlug !== 'corner') ?? live[0];
}

/** Reads workflow changes independently of the visible transcript. */
export function useCornerWorkflowRun(
  cornerId: string | undefined,
  onError?: (error: string, retry: () => void) => void,
): WorkflowRunSummaryView | undefined {
  const observed = useObservedResource(cornerId ? `corner-workflow:${cornerId}` : undefined, {
    load: async () =>
      pickCornerWorkflowRun(
        cornerId!,
        (await monolithPhoneOperation('listRoomWorkflowRuns', { roomId: cornerId! })).workflows,
      ),
    subscribe: cornerId ? observeRoomResource(cornerId) : undefined,
  });
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    if (observed.error) errorHandler.current?.(observed.error, observed.retry);
  }, [observed.error, observed.retry]);
  return observed.data;
}
