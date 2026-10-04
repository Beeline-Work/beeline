import { useRef } from 'react';
import { observeRoomResource, useObservedResource } from './use-observed-resource';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * The run a Room's workflow line names: a live run of a saved workflow
 * working in this Room. The server lists only actual saved workflows.
 */
export function pickRoomWorkflowRun(
  roomId: string,
  runs: readonly WorkflowRunSummaryView[],
): WorkflowRunSummaryView | undefined {
  const live = runs.filter((run) => run.roomId === roomId && run.status === 'live');
  return live[0];
}

/** Reads workflow changes independently of the visible transcript. */
export function useRoomWorkflowRun(
  roomId: string | undefined,
) {
  const observed = useObservedResource(roomId ? `room-workflow:${roomId}` : undefined, {
    load: async () =>
      pickRoomWorkflowRun(
        roomId!,
        (await monolithPhoneOperation('listRoomWorkflowRuns', { roomId: roomId! })).workflows,
      ),
    subscribe: roomId ? observeRoomResource(roomId) : undefined,
  });
  const notice = useRef<{ roomId?: string; successVersion: number; error: string | null }>({ roomId, successVersion: 0, error: null });
  if (notice.current.roomId !== roomId || notice.current.successVersion !== observed.successVersion) {
    notice.current = { roomId, successVersion: observed.successVersion, error: null };
  }
  if (observed.error && !notice.current.error) notice.current.error = observed.error;
  return { workflow: observed.data, error: notice.current.error, retry: observed.retry };
}
