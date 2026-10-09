import { useMemo, useRef } from 'react';
import { observeRoomResource, useObservedResource } from './use-observed-resource';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

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

/**
 * The one read of a Room's workflow runs, shared by every screen that shows
 * them. It reads again only when a workflow line or card lands, on a change
 * no delta describes, or after the socket reconnects; prose never moves a run.
 */
function useRoomWorkflowList(roomId: string | undefined) {
  return useObservedResource(roomId ? `room-workflows:${roomId}` : undefined, {
    load: async () =>
      (await monolithPhoneOperation('listRoomWorkflowRuns', { roomId: roomId! })).workflows,
    subscribe: roomId ? observeRoomResource(roomId) : undefined,
  });
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
    // Every other live saved-workflow run in the Room, any workflow,
    // beside the one named above — newest activity first.
    return {
      run: named,
      otherLiveRuns: liveRoomRuns(roomId, observed.data).filter(
        (candidate) => candidate.runId !== named?.runId,
      ),
    };
  }, [observed.data, roomId]);
  const notice = useRef<{ roomId?: string; successVersion: number; error: string | null }>({ roomId, successVersion: 0, error: null });
  if (notice.current.roomId !== roomId || notice.current.successVersion !== observed.successVersion) {
    notice.current = { roomId, successVersion: observed.successVersion, error: null };
  }
  if (observed.error && !notice.current.error) notice.current.error = observed.error;
  return {
    workflow: run,
    otherLiveRuns,
    error: notice.current.error,
    retry: observed.retry,
  };
}
