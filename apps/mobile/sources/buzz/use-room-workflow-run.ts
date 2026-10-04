import { useRef } from 'react';
import { observeRoomResource, useObservedResource } from './use-observed-resource';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

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

/** Reads workflow changes independently of the visible transcript. */
export function useRoomWorkflowRun(
  roomId: string | undefined,
) {
  const observed = useObservedResource(roomId ? `room-workflow:${roomId}` : undefined, {
    load: async () => {
      const { workflows } = await monolithPhoneOperation('listRoomWorkflowRuns', { roomId: roomId! });
      const run = pickRoomWorkflowRun(roomId!, workflows);
      // Every other live saved-workflow run in the Room, any workflow,
      // beside the one named above — newest activity first.
      const otherLiveRuns = liveRoomRuns(roomId!, workflows).filter((candidate) => candidate.runId !== run?.runId);
      return { run, otherLiveRuns };
    },
    subscribe: roomId ? observeRoomResource(roomId) : undefined,
  });
  const notice = useRef<{ roomId?: string; successVersion: number; error: string | null }>({ roomId, successVersion: 0, error: null });
  if (notice.current.roomId !== roomId || notice.current.successVersion !== observed.successVersion) {
    notice.current = { roomId, successVersion: observed.successVersion, error: null };
  }
  if (observed.error && !notice.current.error) notice.current.error = observed.error;
  return {
    workflow: observed.data?.run,
    otherLiveRuns: observed.data?.otherLiveRuns ?? [],
    error: notice.current.error,
    retry: observed.retry,
  };
}
