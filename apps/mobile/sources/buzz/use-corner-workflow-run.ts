import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
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

/**
 * Reads the corner's live workflow run on focus and whenever `refreshKey`
 * (the newest transcript message) changes. A failed read hides the line; it
 * never blocks the corner.
 */
export function useCornerWorkflowRun(
  cornerId: string | undefined,
  refreshKey: string | undefined,
): WorkflowRunSummaryView | undefined {
  const [run, setRun] = useState<WorkflowRunSummaryView | undefined>(undefined);
  const load = useCallback(() => {
    if (!cornerId) {
      setRun(undefined);
      return () => undefined;
    }
    let cancelled = false;
    monolithPhoneOperation('listRoomWorkflowRuns', { roomId: cornerId })
      .then((listed) => {
        if (!cancelled) setRun(pickCornerWorkflowRun(cornerId, listed.workflows));
      })
      .catch(() => {
        if (!cancelled) setRun(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [cornerId]);
  useFocusEffect(load);
  useEffect(() => load(), [load, refreshKey]);
  return run;
}
