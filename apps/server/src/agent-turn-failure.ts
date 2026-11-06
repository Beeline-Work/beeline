import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { reportToCommander } from './commander.js';
import { systemLine } from './system-line.js';

/** Called only after the terminal owner accepted an explicit failed result.
 * A lost connection never creates a notice or a second assignment.
 */
export async function recordAgentTurnFailure(db: SqlDatabase, command: CommandRow, reason: string | null): Promise<boolean> {
  if (command.private_payload?.kind === 'order' || command.review_context) {
    const room = (await db.query<{name:string}>('SELECT name FROM rooms WHERE id=$1',[command.room_id])).rows[0];
    const report = await reportToCommander(db, command.room_id, command.agent_id,
      `failed: ${room?.name ?? 'Room'} (${command.room_id}): ${reason || 'I could not finish this request.'}`, command, `failure:${command.id}`, {automatic:true});
    if (report.delivered !== false) return true;
  }
  const agent = (await db.query<{ name: string }>('SELECT name FROM identities WHERE id=$1', [command.agent_id])).rows[0];
  await systemLine(db, {
    roomId: command.room_id,
    subject: { kind: 'agent', id: command.agent_id, name: agent?.name ?? 'Agent' },
    verb: 'could not finish this request',
    ...(reason ? {consequence:reason} : {}),
    cardType: 'turn-failed', card: { requestId: command.turn_request_id, agentId: command.agent_id, state: 'failed' },
    afterMessageId: command.source_message_id ?? undefined,
  });
  return false;
}
