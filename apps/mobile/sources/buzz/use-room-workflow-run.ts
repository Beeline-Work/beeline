import { useMemo } from 'react';
import { useSurfaceFocus } from './use-surface-focus';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { useRoutedResource } from './router-resource';

const NO_RUNS: readonly WorkflowRunSummaryView[] = [];

/** The Room's live saved-workflow runs, newest activity first. The server lists only actual saved workflows. */
export function liveRoomRuns(
  roomId: string,
  runs: readonly WorkflowRunSummaryView[],
): WorkflowRunSummaryView[] {
  return runs
    .filter((run) => run.roomId === roomId && run.status === 'live')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The run a Room's workflow line names: the live run with the most recent activity. */
export function pickRoomWorkflowRun(
  roomId: string,
  runs: readonly WorkflowRunSummaryView[],
): WorkflowRunSummaryView | undefined {
  return liveRoomRuns(roomId, runs)[0];
}

/** Workflow status observes the Room's canonical router projection. */
function useRoomWorkflowList(roomId: string | undefined) {
  const focused = useSurfaceFocus();
  const routed = useRoutedResource('room-workflows', roomId ? { family: 'room-workflows', roomId } : undefined, focused);
  return { data: routed.value?.workflows, loading: routed.loading, error: routed.error, retry: routed.retry };
}

/** Every saved-workflow run in a Room and its corners, for a list that names each corner's live run. */
export function useRoomWorkflowRuns(roomId: string | undefined): readonly WorkflowRunSummaryView[] {
  return useRoomWorkflowList(roomId).data ?? NO_RUNS;
}

/** Reads workflow changes independently of the visible transcript. */
export function useRoomWorkflowRun(roomId: string | undefined) {
  const observed = useRoomWorkflowList(roomId);
  const { run, otherLiveRuns } = useMemo(() => {
    if (!roomId || !observed.data) return { run: undefined, otherLiveRuns: NO_RUNS };
    const named = pickRoomWorkflowRun(roomId, observed.data);
    return {
      run: named,
      otherLiveRuns: liveRoomRuns(roomId, observed.data).filter(
        (candidate) => candidate.runId !== named?.runId,
      ),
    };
  }, [observed.data, roomId]);
  return {
    workflow: run,
    otherLiveRuns,
    error: observed.error,
    retry: observed.retry,
  };
}
