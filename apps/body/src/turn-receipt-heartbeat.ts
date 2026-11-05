import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';

type WorkingReceipt = Omit<
  DaemonOperationMap['postAgentTurnReceipt']['input'],
  'status' | 'heartbeat'
>;

/** Runs under the existing connection owner when present. Real owner loss
 * interrupts the task; no per-turn freshness writes or heartbeat timer remain. */
export async function withTurnReceiptHeartbeat<T>(
  api: Pick<DaemonApiClient, 'execute'> & Partial<Pick<DaemonApiClient, 'runWithTurnOwnership'>>,
  receipt: WorkingReceipt,
  task: () => Promise<T>,
  _onHeartbeatError: (error: unknown) => void,
  onAuthorityLost?: () => void,
): Promise<T> {
  const owned = api.runWithTurnOwnership?.(receipt, task, onAuthorityLost);
  if (owned !== undefined) return owned;
  return task();
}
