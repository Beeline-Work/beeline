import type { PostTurnReceiptInput } from '@beeline/api-contract/daemon';
import { OwnedModelFiles } from './owned-model-files.js';

const owners = new WeakMap<object, OwnedModelFiles>();
export class OwnedModelOutcomeUnknown extends Error {
  constructor(readonly modelRequestId?: string) { super('Owned model outcome UNKNOWN; dependent work ended without resubmission.'); }
}
export function assertOwnedModelTurnSettled(context: object): void {
  const owner = owners.get(context); if (!owner) return;
  let snapshot: ReturnType<OwnedModelFiles['snapshot']>;
  try { snapshot=owner.snapshot(); }
  catch { throw new OwnedModelOutcomeUnknown(); }
  const last=snapshot.requests.at(-1);
  if (snapshot.state === 'unknown') throw new OwnedModelOutcomeUnknown(last);
}
/** Guard BOTH successful ACP completion and exceptions before any login repair,
 * provider re-pin, device/steer/context recovery or dependent publication. */
export async function ownedModelPrompt<T>(context: object, task: () => Promise<T>): Promise<T> {
  assertOwnedModelTurnSettled(context);
  try { return await task(); } finally { assertOwnedModelTurnSettled(context); }
}
/** Existing receipt transport only. No trace/failure classification is supplied;
 * server authenticates exact command/source/attempt and commits owner end. */
export function ownedModelEndReceipt(error: OwnedModelOutcomeUnknown,
  turn: { agentId: string; roomId: string; requestId: string; generationId: string }): PostTurnReceiptInput {
  return { ...turn, status: 'failed', modelOwnerEnd: error.modelRequestId ? { requestId: error.modelRequestId } : { journalUnavailable: true } };
}
