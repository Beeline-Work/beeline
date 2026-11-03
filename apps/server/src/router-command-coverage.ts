import type { RouterCommandCoverage, RouterCommandReceipt } from '@beeline/api-contract/router-command';
import type { RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { readRouterAuthority, readRouterCut, RouterProjectionUnavailable } from './router-projections.js';

/** Run on the effect/receipt transaction. A cut describes this convenience
 * result only; neither reception nor replay covers unrelated projection facts. */
export async function captureCommandCoverage(database: SqlDatabase, input: Record<string, unknown>,
  viewer: string): Promise<RouterCommandCoverage> {
  const roomId = typeof input.roomId === 'string' ? input.roomId : undefined;
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId
    : roomId ? (await database.query<{ workspace_id: string }>('SELECT workspace_id FROM rooms WHERE id=$1', [roomId])).rows[0]?.workspace_id : undefined;
  if (!workspaceId) throw new RouterProjectionUnavailable('authority');
  const scope = { workspaceId, ...(roomId ? { roomId } : {}) };
  const address: RouterSnapshotInput = roomId ? { family: 'room-head', workspaceId, roomId } : { family: 'room-list', workspaceId };
  const authority = await readRouterAuthority(database, address, viewer);
  return { scope, authority, cut: await readRouterCut(database, workspaceId) };
}
function isReceipt(value: unknown): value is RouterCommandReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<RouterCommandReceipt>;
  return receipt.v === 1 && typeof receipt.commandId === 'string' && typeof receipt.operation === 'string' &&
    ['committed','pending','unknown','result-expired'].includes(String(receipt.state));
}
/** The authenticated principal may learn its durable command outcome after
 * losing Room access. Only a currently authorized, matching certificate may
 * release the saved convenience data. Revocation/regrant never relabels that
 * old DTO at a new cut and never falsely calls a committed effect refused. */
export async function fenceCommandReceiptEnqueue(database: SqlDatabase, viewer: string, value: unknown,
  enqueue: (safeReceipt: unknown) => undefined): Promise<void> {
  if (!isReceipt(value)) { enqueue(value); return; }
  const outcome: RouterCommandReceipt = { v: 1, operation: value.operation, commandId: value.commandId, state: value.state };
  if (!value.coverage || value.state !== 'committed') { enqueue(outcome); return; }
  await database.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
    const scope = value.coverage!.scope;
    const input: RouterSnapshotInput = scope.roomId
      ? { family: 'room-head', workspaceId: scope.workspaceId, roomId: scope.roomId }
      : { family: 'room-list', workspaceId: scope.workspaceId };
    let current;
    try { current = await readRouterAuthority(tx, input, viewer); }
    catch (error) {
      if (!(error instanceof RouterProjectionUnavailable) || error.reason !== 'authority') throw error;
    }
    enqueue(current?.digest === value.coverage!.authority.digest ? value : outcome);
  });
}
