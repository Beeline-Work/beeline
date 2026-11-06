import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { endAgentTurn } from './agent-turn-end.js';
import { invocationCommandSql } from './turn-ownership.js';
import { recordAgentTurnFailure } from './agent-turn-failure.js';

/** Cost admission belongs to each model request, never an elapsed-time sweep. */
export async function refuseExpiredFreeAgentTurn(db: SqlDatabase, commandId: string,
  generation: string | null, maxTurnMs: number): Promise<boolean> {
  return db.transaction(async db => {
    const expired = await db.query(`SELECT 1 FROM agent_commands command LEFT JOIN agent_turns turn
      ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
      WHERE command.id=$1 AND command.generation_id IS NOT DISTINCT FROM $2
        AND EXISTS(SELECT 1 FROM agent_commands invocation_command
          WHERE ${invocationCommandSql('command','invocation_command')})
        AND COALESCE(turn.started_at,command.claimed_at)<=clock_timestamp()-make_interval(secs=>$3::double precision/1000)`,
      [commandId,generation,maxTurnMs]);
    if (!expired.rowCount) return false;
    await endFreeAgentModelTurn(db,commandId,generation,'The free-agent turn reached its time limit.');
    return true;
  });
}

export async function endFreeAgentModelTurn(db: SqlDatabase, commandId: string,
  generation: string | null, reason: string): Promise<void> {
  await db.transaction(async db => {
    const commands = (await db.query<CommandRow>(`SELECT invocation_command.*
      FROM agent_commands anchor JOIN agent_commands invocation_command
        ON ${invocationCommandSql('anchor','invocation_command')}
      WHERE anchor.id=$1 AND anchor.generation_id IS NOT DISTINCT FROM $2
      ORDER BY invocation_command.created_at,invocation_command.id FOR UPDATE OF invocation_command`, [commandId,generation])).rows;
    for (const command of commands)
      if (await endAgentTurn(db,command,'failed',reason)) await recordAgentTurnFailure(db,command,reason);
  });
}
