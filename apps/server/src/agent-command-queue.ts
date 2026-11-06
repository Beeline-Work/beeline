import { createHash } from 'node:crypto';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { commandOrder, reportToCommander } from './commander.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { CornerAccessDatabase } from './corner-access-database.js';

/** The existing recipient membership fences insertion, claims and Stop even
 * when the queue is empty. Take it before command rows or shared member reads. */
export function lockAgentCommandQueue(db:SqlDatabase,roomId:string,agentId:string):Promise<void>;
export function lockAgentCommandQueue(db:SqlDatabase,recipients:readonly {roomId:string;agentId:string}[]):Promise<void>;
export async function lockAgentCommandQueue(db:SqlDatabase,room: string|readonly {roomId:string;agentId:string}[],agentId?:string):Promise<void> {
  const recipients=typeof room==='string'?[{roomId:room,agentId:agentId!}]:room;
  await CornerAccessDatabase.physical(db).query(`SELECT member.identity_id FROM memberships member
    WHERE (member.room_id,member.identity_id) IN (
      SELECT COALESCE(room.parent_id,room.id),recipient."agentId"
      FROM jsonb_to_recordset($1::jsonb) recipient("roomId" uuid,"agentId" text)
      JOIN rooms room ON room.id=recipient."roomId")
    ORDER BY member.room_id,member.identity_id FOR UPDATE OF member`,[JSON.stringify(recipients)]);
}

export const AGENT_COMMAND_DELEGATION_SCHEMA = `
-- Delegation checks its issuing agent at commit without locking a second
-- recipient membership while another agent owns that queue's fence.
CREATE OR REPLACE FUNCTION beeline_commit_delegated_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.private_payload->>'kind' IS DISTINCT FROM 'order' OR NEW.parent_command_id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM agent_commands current_order WHERE current_order.id=NEW.id AND current_order.state IN ('pending','claimed'))
    AND EXISTS(SELECT 1 FROM agent_commands source WHERE source.id=NEW.parent_command_id
      AND source.agent_id=NEW.private_payload->>'authorId')
    AND NOT EXISTS(SELECT 1 FROM rooms room JOIN memberships member
      ON member.room_id=COALESCE(room.parent_id,room.id)
        AND member.identity_id=NEW.private_payload->>'authorId' AND member.removed_at IS NULL
      WHERE room.id=NEW.room_id) THEN
    RAISE EXCEPTION 'access denied: delegated order source membership changed before commit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS beeline_commit_delegated_order ON agent_commands;
CREATE CONSTRAINT TRIGGER beeline_commit_delegated_order AFTER INSERT ON agent_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION beeline_commit_delegated_order();
`;

/** The Stop transaction's timestamp fences orders accepted after the Stop. */
export async function dropQueuedOrdersForStop(db: SqlDatabase, stopped: CommandRow): Promise<number> {
  const order = await commandOrder(db, stopped);
  if (order.private_payload?.kind !== 'order' || order.agent_id !== stopped.agent_id) return 0;
  const dropped = await db.query<CommandRow>(
    `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled','stop',NULL) ended FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='input'
       AND state='pending'
       AND private_payload->>'kind'='order'
       AND private_payload->>'authorId'=$3 AND private_payload->>'fromRoomId'=$4
       AND created_at<=now() AND turn_request_id<>$5) terminal`,
    [stopped.room_id, stopped.agent_id, order.private_payload.authorId,
      order.private_payload.fromRoomId, stopped.turn_request_id],
  );
  if (dropped.rowCount) {
    await reportToCommander(db, stopped.room_id, stopped.agent_id,
      systemMessage("agent-command.failed-queued-dropped-by-a-stop-the-running-turn-was-cancelled", dropped.rowCount, dropped.rowCount === 1 ? systemMessage("agent-command.order-was") : systemMessage("agent-command.orders-were")),
      dropped.rows[0], createHash('sha256').update(`stop-orders:${stopped.id}`).digest('hex'), { automatic: true });
  }
  return dropped.rowCount;
}
