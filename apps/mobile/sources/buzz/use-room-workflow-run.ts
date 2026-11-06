import { useMemo } from 'react';
import { AppState } from 'react-native';
import { useSurfaceFocus } from './use-surface-focus';
import { isSystemOrCardMessage, useObservedResource } from './use-observed-resource';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { subscribeRoomCornerFacts } from '@/buzz/room-corner-store';

const reportedFailures = new Set<string>();

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

/** Use a typed workflow projection when the socket has one, and one shared
 * covering read when a relevant system/card change has no projection. A
 * handoff inside a corner reaches the parent only as a change to that
 * corner's row in the Room's corner record, so that change reads too. */
function observeWorkflowRuns(roomId: string) {
  return async (invalidate: () => void, refresh: () => void,
    replace: (runs: readonly WorkflowRunSummaryView[]) => void, recover: () => void) => {
    const stopLive = await sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
      if (AppState.currentState !== 'active' || !('monolithLive' in event)) return;
      const live = event.monolithLive;
      if (!('roomId' in live) || live.roomId !== roomId) return;
      if (live.type === 'message-delta' && live.workflowRuns) {
        replace(live.workflowRuns);
      } else if (live.type === 'message-delta' && isSystemOrCardMessage(live.message)) {
        invalidate();
      } else if (live.type === 'invalidate' && !live.deliveryId) {
        invalidate();
      }
    });
    // Subscribed only once the lane holds, so a failed register leaves no listener.
    const stopCorners = subscribeRoomCornerFacts(roomId, invalidate);
    return () => {
      stopCorners();
      stopLive();
    };
  };
}

/** The one read of a Room's workflow runs, shared by every screen that shows them. */
function useRoomWorkflowList(roomId: string | undefined) {
  const focused = useSurfaceFocus();
  const observed = useObservedResource<readonly WorkflowRunSummaryView[]>(
    (focused) && roomId ? `room-workflows:${roomId}` : undefined,
    {
      load: async () =>
        (await monolithPhoneOperation('listRoomWorkflowRuns', { roomId: roomId! })).workflows,
      onError: (cause) => {
        if (!reportedFailures.has(roomId!)) {
          reportedFailures.add(roomId!);
          console.warn('Workflow status load failed', { roomId, cause });
        }
      },
      subscribe: roomId ? observeWorkflowRuns(roomId) : undefined,
    },
  );
  return (observed);
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
