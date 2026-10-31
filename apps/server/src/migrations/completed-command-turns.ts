import type { SqlDatabase } from '../database.js';

/** One-time release repair for turns left working by completed commands. */
export async function closeCompletedCommandTurns(database: SqlDatabase): Promise<void> {
  await database.transaction(async (db) => {
    // Claims and heartbeats lock their command. Hold the same rows before
    // checking leases in the update's fresh snapshot.
    await db.query(`SELECT command.id FROM agent_commands command
      JOIN agent_turns turn ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id
        AND turn.request_id=command.turn_request_id
      WHERE turn.status='working' ORDER BY command.id FOR UPDATE OF command`);
    await db.query(`UPDATE agent_turns turn SET status='failed',
      failure_reason='the command completed without a terminal turn receipt',created_at=now()
      WHERE turn.status='working'
        AND EXISTS(SELECT 1 FROM agent_commands command WHERE command.room_id=turn.room_id
          AND command.agent_id=turn.agent_id AND command.turn_request_id=turn.request_id
          AND command.action IN ('input','resume') AND command.state='complete')
        AND NOT EXISTS(SELECT 1 FROM agent_commands active WHERE active.room_id=turn.room_id
          AND active.agent_id=turn.agent_id AND active.turn_request_id=turn.request_id
          AND active.state='claimed' AND active.lease_expires_at>now())`);
  });
}
