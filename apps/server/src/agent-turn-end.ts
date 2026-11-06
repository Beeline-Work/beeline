import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';

/** All command/turn terminal writes live in this database function, including
 * explicit cancellation. Callers select the work they are authorized to end;
 * the generation comparison prevents an old execution ending its successor.
 * Connection loss returns work to pending and never calls this function.
 */
export const AGENT_TURN_END_SCHEMA = `
CREATE OR REPLACE FUNCTION beeline_end_agent_turn(
  command_id text, expected_generation text, outcome text,
  terminal_reason text DEFAULT NULL, result_id text DEFAULT NULL
) RETURNS SETOF agent_commands LANGUAGE plpgsql AS $$
DECLARE ended agent_commands%ROWTYPE;
BEGIN
  IF outcome NOT IN ('complete','failed','cancelled') THEN
    RAISE EXCEPTION 'invalid terminal turn outcome';
  END IF;
  UPDATE agent_commands command SET
    state=CASE WHEN outcome='cancelled' THEN 'cancelled' ELSE 'complete' END,
    completed_at=clock_timestamp(),lease_expires_at=NULL,
    cancellation_reason=CASE WHEN outcome='cancelled' THEN terminal_reason ELSE command.cancellation_reason END,
    result_message_id=COALESCE(result_id,command.result_message_id)
  WHERE command.id=command_id AND command.state IN ('pending','claimed')
    AND command.generation_id IS NOT DISTINCT FROM expected_generation
  RETURNING command.* INTO ended;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE agent_turns turn SET status=outcome,failure_reason=terminal_reason,created_at=clock_timestamp()
  WHERE turn.room_id=ended.room_id AND turn.agent_id=ended.agent_id
    AND turn.request_id=ended.turn_request_id AND turn.status='working'
    AND (turn.generation_id IS NOT DISTINCT FROM expected_generation
      OR turn.generation_id='pending:'||ended.id
      OR (expected_generation IS NULL AND EXISTS(
        SELECT 1 FROM agent_command_generation_owners binding
        WHERE binding.command_id=ended.id AND binding.generation_id=turn.generation_id)));
  DELETE FROM live_outputs WHERE room_id=ended.room_id AND agent_id=ended.agent_id
    AND turn_id=ended.turn_request_id AND kind IN ('draft','thought')
    AND NOT EXISTS(SELECT 1 FROM agent_turns successor WHERE successor.room_id=ended.room_id
      AND successor.agent_id=ended.agent_id AND successor.request_id=ended.turn_request_id AND successor.status='working');
  RETURN NEXT ended;
END; $$;
`;

/** Use within the caller's authority transaction. A terminal replay is a no-op. */
export async function endAgentTurn(db: SqlDatabase, command: Pick<CommandRow, 'id' | 'generation_id'>,
  outcome: 'complete' | 'failed' | 'cancelled', reason?: string | null, resultMessageId?: string): Promise<boolean> {
  const ended = await db.query('SELECT * FROM beeline_end_agent_turn($1,$2,$3,$4,$5)',
    [command.id, command.generation_id, outcome, reason ?? null, resultMessageId ?? null]);
  return ended.rowCount > 0;
}
