import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { RouterCommandIdentity, RouterCommandReceipt } from '@beeline/api-contract/router-command';
import { parseRouterCommandIdentity } from '@beeline/api-contract/router-command';
import { CommandRefusalError } from './command-refusal.js';
import { lockCornerLifecycle } from './corner-lifecycle.js';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { InvalidCommandArguments, type RouterCommandLedger } from './router-command-ledger.js';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { workflowRunLockKey } from './workflow-runs.js';

const OPERATIONS = ['decideAgentGrant', 'decideWritePermission', 'answerChoice', 'skipChoice'] as const;
export type TrayDecisionOperation = typeof OPERATIONS[number];
export function isTrayDecisionCommand(operation: string): operation is TrayDecisionOperation {
  return (OPERATIONS as readonly string[]).includes(operation);
}
const FIELDS = {
  decideAgentGrant: { grantId: true, decision: true },
  decideWritePermission: { roomId: true, permissionId: true, requestId: true, agentId: true, repository: true, decision: true },
  answerChoice: { choiceId: true, optionId: true, note: true },
  skipChoice: { choiceId: true },
} as const satisfies { [K in TrayDecisionOperation]: Record<keyof PhoneOperationMap[K]['input'], true> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateInput(operation: TrayDecisionOperation, input: Record<string, unknown>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    throw new InvalidCommandArguments();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const fields = Object.keys(FIELDS[operation]);
  const required = fields.filter(key => operation !== 'answerChoice' || key !== 'note');
  if (Object.keys(descriptors).some(key => !fields.includes(key)) || required.some(key => !descriptors[key]) ||
      operation === 'answerChoice' && descriptors.note && (!('value' in descriptors.note) || !descriptors.note.enumerable ||
        descriptors.note.value !== undefined && typeof descriptors.note.value !== 'string') ||
      required.some(key => !descriptors[key] || !descriptors[key].enumerable || !('value' in descriptors[key]) || typeof descriptors[key].value !== 'string' ||
        !descriptors[key].value.length || descriptors[key].value.length > 1024)) throw new InvalidCommandArguments();
  const values = Object.fromEntries(required.map(key => [key, descriptors[key]!.value])) as Record<string, string>;
  if (operation === 'decideAgentGrant' && (!UUID.test(values.grantId!) || !['always', 'once', 'deny'].includes(values.decision!)) ||
      (operation === 'skipChoice' || operation === 'answerChoice') && !UUID.test(values.choiceId!) ||
      operation === 'decideWritePermission' && (!UUID.test(values.roomId!) || !/^[0-9a-f]{64}$/.test(values.agentId!) ||
        !['allow', 'deny'].includes(values.decision!))) throw new InvalidCommandArguments();
}

interface Scope {
  room_id: string;
  workspace_id: string;
  parent_id: string | null;
  message_id: string | null;
  run_id: string | null;
}
const scopeChanged = () => new CommandRefusalError('Tray decision source changed; open the current item', 409);
const busy = () => new CommandRefusalError('Tray decision is busy; no decision was applied', 409);
async function scope(database: SqlDatabase, operation: TrayDecisionOperation, input: Record<string, unknown>): Promise<Scope> {
  const source = operation === 'decideAgentGrant'
    ? `SELECT g.room_id,r.workspace_id,r.parent_id,NULL::text message_id,NULL::text run_id
       FROM agent_grants g JOIN rooms r ON r.id=g.room_id
       WHERE g.id::text=$1 AND g.workspace_id=r.workspace_id`
    : (operation === 'skipChoice' || operation === 'answerChoice')
      ? `SELECT c.room_id,r.workspace_id,r.parent_id,c.message_id,m.card->>'runId' run_id
         FROM room_choices c JOIN rooms r ON r.id=c.room_id JOIN messages m ON m.id=c.message_id
         WHERE c.id::text=$1 AND c.workspace_id=r.workspace_id`
      : `SELECT r.id room_id,r.workspace_id,r.parent_id,NULL::text message_id,NULL::text run_id FROM rooms r WHERE r.id=$1`;
  const id = operation === 'decideAgentGrant' ? input.grantId : (operation === 'skipChoice' || operation === 'answerChoice') ? input.choiceId : input.roomId;
  const result = (await database.query<Scope>(source, [id])).rows[0];
  if (!result) throw new CommandRefusalError('Tray decision not found', 404);
  return result;
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.room_id === b.room_id && a.workspace_id === b.workspace_id && a.parent_id === b.parent_id &&
    a.message_id === b.message_id && a.run_id === b.run_id;
}

/** Discovery takes no row locks. Refuse a moved source rather than acquiring
 * another lifecycle lock after authority. NOWAIT/try-lock avoids waiting on
 * legacy source/run holders that may next request the authority fence. */
async function lockDecision(database: SqlDatabase, operation: TrayDecisionOperation,
  input: Record<string, unknown>, viewer: string): Promise<Scope> {
  const planned = await scope(database, operation, input);
  if (planned.parent_id) await lockCornerLifecycle(database, planned.room_id);
  // These are actual authority-changing writes. Taking the exclusive fence
  // upfront also avoids two shared holders upgrading in source BEFORE triggers.
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
  if (!sameScope(planned, await scope(database, operation, input))) throw scopeChanged();
  if (planned.run_id) {
    // Stored gate run IDs are canonical, not a caller-supplied prefix lookup.
    if (!/^[0-9a-f]{64}$/.test(planned.run_id)) throw scopeChanged();
    const locked = (await database.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) locked', [workflowRunLockKey(planned.run_id)],
    )).rows[0]?.locked;
    if (!locked) throw busy();
  }
  const room = (await database.query<{ archived_at: Date | null }>(
    'SELECT archived_at FROM rooms WHERE id=$1 FOR SHARE NOWAIT', [planned.room_id],
  )).rows[0];
  if (!room || room.archived_at) throw new CommandRefusalError('Room is unavailable for a decision', 403);
  await database.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE NOWAIT', [planned.workspace_id]);
  const human = await database.query(`SELECT id FROM identities WHERE id=$1 AND kind='human' FOR SHARE NOWAIT`, [viewer]);
  if (!human.rowCount) throw new CommandRefusalError('Human decision authority required', 403);
  // Preserve each operation's legacy decider policy below. These locks hold
  // its current stored Workspace / parent-Room memberships through commit.
  await database.query(`SELECT id FROM memberships WHERE identity_id=$1 AND workspace_id=$2
    AND (room_id IS NULL OR room_id=$3) ORDER BY id FOR SHARE NOWAIT`,
  [viewer, planned.workspace_id, planned.parent_id ?? planned.room_id]);
  if (operation === 'decideAgentGrant') {
    const grant = (await database.query<{ agent_id: string; app_id: string | null }>(
      'SELECT agent_id,app_id FROM agent_grants WHERE id::text=$1 FOR UPDATE NOWAIT', [input.grantId],
    )).rows[0];
    if (!grant) throw scopeChanged();
    await database.query('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE NOWAIT', [grant.agent_id]);
    if (grant.app_id) await database.query('SELECT id FROM workspace_apps WHERE id=$1 FOR SHARE NOWAIT', [grant.app_id]);
    await database.query(`SELECT message.id FROM messages message JOIN rooms room ON room.id=message.room_id
      WHERE room.workspace_id=$2 AND message.card_type='grant-request' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(message.card->'grants') entry WHERE entry->>'grantId'=$1)
      ORDER BY message.id FOR UPDATE OF message NOWAIT`, [input.grantId, planned.workspace_id]);
  } else if (operation === 'decideWritePermission') {
    await database.query(`SELECT permission_id FROM permission_authority WHERE permission_id=$1 AND room_id=$2
      FOR UPDATE NOWAIT`, [input.permissionId, planned.room_id]);
    await database.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='permission' AND card->>'permissionId'=$2
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE NOWAIT`, [planned.room_id, input.permissionId]);
    await database.query('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE NOWAIT', [input.agentId]);
  } else {
    const choice = (await database.query<{ current: boolean }>(`SELECT closes_at IS NULL OR closes_at>clock_timestamp() current
      FROM room_choices WHERE id::text=$1 AND status='open' AND ($2::boolean OR mode='question') FOR UPDATE NOWAIT`, [input.choiceId, operation === 'answerChoice'])).rows[0];
    if (!choice?.current) throw new CommandRefusalError('Choice is no longer open for a decision', 409);
    // The source lock is the action-versus-expiry linearization. A worker
    // cannot settle this same choice while the admitted skip is in flight.
    await database.query('SELECT id FROM messages WHERE id=$1 FOR UPDATE NOWAIT', [planned.message_id]);
    if (planned.run_id) await database.query(`SELECT id FROM messages WHERE room_id=$1 AND card->>'runId'=$2
      ORDER BY id FOR UPDATE NOWAIT`, [planned.room_id, planned.run_id]);
  }
  if (!sameScope(planned, await scope(database, operation, input))) throw scopeChanged();
  return planned;
}

/** One DB-only decision + outcome receipt. Callbacks are compatibility hints,
 * never the durable truth: flush only after the actual outer COMMIT. A crash
 * before flushing is recovered by committed sources, never by replay hooks. */
export async function dispatchTrayDecisionCommand(ledger: RouterCommandLedger, phone: PhoneService, live: LiveHub,
  operation: TrayDecisionOperation, input: Record<string, unknown>, viewerId: string,
  identity: RouterCommandIdentity): Promise<RouterCommandReceipt<null>> {
  if (!isTrayDecisionCommand(operation)) throw new CommandRefusalError('Unsupported Tray decision command', 400);
  validateInput(operation, input);
  identity = parseRouterCommandIdentity(identity);
  const notifications: (() => void)[] = [];
  let receipt: RouterCommandReceipt<null>;
  try {
    receipt = await ledger.atomic({ principal: viewerId, operation, commandId: identity.id }, input, async transaction => {
      const current = await lockDecision(transaction, operation, input, viewerId);
      await phone.withCommandTransaction(transaction, () => phone.applyTrayDecisionCommand(operation,
        input as PhoneOperationMap[TrayDecisionOperation]['input'], viewerId, notification => { notifications.push(notification); }));
      notifications.push(() => live.publish({ type: 'invalidate', roomId: current.room_id, reason: 'phone-write' }));
      return null;
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw busy();
    throw error;
  }
  for (const notification of notifications) notification();
  return receipt;
}
