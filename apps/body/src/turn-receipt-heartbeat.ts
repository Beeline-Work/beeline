import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { DaemonApiError, type DaemonApiClient } from './daemon-api-client.js';

export const TURN_RECEIPT_HEARTBEAT_MS = 30_000;

type WorkingReceipt = Omit<
  DaemonOperationMap['postAgentTurnReceipt']['input'],
  'status' | 'heartbeat'
>;

/**
 * The server has permanently refused this turn's authority (`command output
 * authority rejected`, e.g. after declaring the turn stalled, or `command
 * turn cancelled`): no later heartbeat under this generation can ever
 * succeed, so retrying is pure waste and leaves the caller's room/corner lane
 * occupied for as long as the task keeps running.
 */
export function isTurnAuthorityLostError(error: unknown): boolean {
  return (
    error instanceof DaemonApiError &&
    error.status === 403 &&
    (error.code === 'command output authority rejected' ||
      error.code === 'command turn cancelled')
  );
}

/**
 * Keeps one accepted turn fresh while its task runs. Writes are serialized and
 * drained before returning so a delayed heartbeat cannot follow the terminal
 * receipt posted by the caller. A heartbeat the server permanently refuses
 * calls `onAuthorityLost` once so the caller can drop the turn at the harness
 * instead of retrying a rejection every 30 seconds for as long as the task
 * keeps running, which otherwise never frees the lane this turn occupies.
 */
export async function withTurnReceiptHeartbeat<T>(
  api: Pick<DaemonApiClient, 'execute'>,
  receipt: WorkingReceipt,
  task: () => Promise<T>,
  onHeartbeatError: (error: unknown) => void,
  onAuthorityLost?: () => void,
): Promise<T> {
  let tail = Promise.resolve();
  const timer = setInterval(() => {
    tail = tail
      .catch(() => undefined)
      .then(() =>
        api.execute('postAgentTurnReceipt', {
          ...receipt,
          status: 'working',
          heartbeat: true,
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        onHeartbeatError(error);
        if (isTurnAuthorityLostError(error)) onAuthorityLost?.();
      });
  }, TURN_RECEIPT_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(timer);
    await tail;
  }
}
