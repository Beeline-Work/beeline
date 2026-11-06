import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
import type { SqlDatabase } from './database.js';

/** Receipts acknowledge the durable command outcome. Screen data is read
 * through its ordinary authenticated handler, never carried in a saved receipt. */
export async function fenceCommandReceiptEnqueue(_database: SqlDatabase, _viewer: string, value: unknown,
  enqueue: (safeReceipt: unknown) => undefined): Promise<void> {
  const receipt = value as Partial<RouterCommandReceipt> | null;
  if (receipt?.v === 1 && typeof receipt.commandId === 'string' && typeof receipt.operation === 'string' &&
      ['committed', 'pending', 'unknown', 'result-expired'].includes(String(receipt.state))) {
    enqueue({ v: 1, operation: receipt.operation, commandId: receipt.commandId, state: receipt.state });
  } else enqueue(value);
}
