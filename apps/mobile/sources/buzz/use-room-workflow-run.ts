import { useMemo, useRef } from 'react';
import { isSystemOrCardMessage, useObservedResource } from './use-observed-resource';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { subscribeRoomCornerFacts } from '@/buzz/room-corner-store';

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
  return async (invalidate: () => void, reconnect: () => void,
    replace: (runs: readonly WorkflowRunSummaryView[]) => void) => {
    let subscribed = false;
    const stopCorners = subscribeRoomCornerFacts(roomId, invalidate);
    const stopLive = await sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
      if (!('monolithLive' in event)) return;
      const live = event.monolithLive;
      if (!('roomId' in live) || live.roomId !== roomId) return;
      if (live.type === 'subscribed') {
        if (subscribed && !live.resumed) reconnect();
        subscribed = true;
      } else if (live.type === 'message-delta' && live.workflowRuns) {
        replace(live.workflowRuns);
      } else if (live.type === 'message-delta' && isSystemOrCardMessage(live.message)) {
        invalidate();
      } else if (live.type === 'invalidate' && !live.deliveryId) {
        invalidate();
      }
    });
    return () => {
      stopCorners();
      stopLive();
    };
  };
}

/** The one read of a Room's workflow runs, shared by every screen that shows them. */
function useRoomWorkflowList(roomId: string | undefined) {
  return useObservedResource<readonly WorkflowRunSummaryView[]>(
    roomId ? `room-workflows:${roomId}` : undefined,
    {
      load: async () =>
        (await monolithPhoneOperation('listRoomWorkflowRuns', { roomId: roomId! })).workflows,
      subscribe: roomId ? observeWorkflowRuns(roomId) : undefined,
    },
  );
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
