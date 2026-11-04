import type { PostTurnReceiptInput } from '@beeline/api-contract/daemon';
import { OwnedModelFiles } from './owned-model-files.js';

const owners = new WeakMap<object, OwnedModelFiles>();
export class OwnedModelOutcomeUnknown extends Error {
  constructor(readonly modelRequestId?: string) { super('Owned model outcome UNKNOWN; dependent work ended without resubmission.'); }
}
/** Private activation seam only. Never copy the owner into command/context DTOs,
 * trace/fingerprint/logs or environment; a generation cannot be rebound. */
export function bindOwnedModelTurn(context: object, owner: OwnedModelFiles): void {
  const previous = owners.get(context);
  if (previous && previous !== owner) throw new Error('Owned model turn binding cannot change');
  owners.set(context, owner);
}
/** Only after the originating child/task drains. Revocation preserves its
 * UNKNOWN journal; a different explicit command gets a distinct owner later. */
export function releaseOwnedModelTurn(context: object): void {
  const owner = owners.get(context); if (!owner) return;
  owner.revoke(); owners.delete(context);
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
