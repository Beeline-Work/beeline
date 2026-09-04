import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';

export const TURN_RECEIPT_HEARTBEAT_MS = 30_000;

type WorkingReceipt = Omit<
  DaemonOperationMap['postAgentTurnReceipt']['input'],
  'status' | 'heartbeat'
>;

/**
 * Keeps one accepted turn fresh while its task runs. Writes are serialized and
 * drained before returning so a delayed heartbeat cannot follow the terminal
 * receipt posted by the caller.
 */
export async function withTurnReceiptHeartbeat<T>(
  api: Pick<DaemonApiClient, 'execute'>,
  receipt: WorkingReceipt,
  task: () => Promise<T>,
  onHeartbeatError: (error: unknown) => void,
): Promise<T> {
  await api.execute('postAgentTurnReceipt', { ...receipt, status: 'working' });
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
      .catch(onHeartbeatError);
  }, TURN_RECEIPT_HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(timer);
    await tail;
  }
}
