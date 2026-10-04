import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';

/** Pin authorized turns to visits within the statement that claims them. */
export function workflowOutputBindingCtes(commandRelation: string, runIdSql = 'NULL::text'): string {
  return `workflow_output_scope AS (
    SELECT command.id command_id,command.room_id,command.action,command.parent_command_id,
      COALESCE(${runIdSql},source.card->>'runId',choice_message.card->>'runId',
        CASE WHEN room.parent_id IS NOT NULL THEN room.id::text END) run_id
    FROM ${commandRelation} command
    JOIN rooms room ON room.id=command.room_id
    JOIN messages source ON source.id=command.source_message_id AND source.room_id=command.room_id
    LEFT JOIN room_choices choice ON choice.id::text=source.card->>'choiceId'
      AND choice.room_id=command.room_id
    LEFT JOIN messages choice_message ON choice_message.id=choice.message_id
    WHERE command.action IN ('input','resume')
  ), workflow_output_pins AS (
    SELECT scope.command_id,scope.room_id,COALESCE(parent_visit.id,latest.id) visit_id
    FROM workflow_output_scope scope
    LEFT JOIN LATERAL (
      SELECT message.id FROM messages message
      WHERE scope.action='resume' AND message.room_id=scope.room_id
        AND message.card_type IN ('workflow-handoff','corner-workflow-handoff')
        AND message.card->'outputCommandIds' ? scope.parent_command_id
      ORDER BY message.created_at DESC,message.id DESC LIMIT 1
    ) parent_visit ON true
    LEFT JOIN LATERAL (
      SELECT message.id FROM messages message
      WHERE parent_visit.id IS NULL AND message.room_id=scope.room_id
        AND message.card->>'runId'=scope.run_id
        AND message.card_type IN ('workflow-handoff','corner-workflow-handoff')
        AND message.card->>'toState' IS NOT NULL
        AND NOT COALESCE((message.card->>'reassigned')::boolean,false)
      ORDER BY (message.card->>'seq')::int DESC NULLS LAST,message.created_at DESC,message.id DESC
      LIMIT 1
    ) latest ON true
  ), workflow_output_bound AS (
    UPDATE messages message SET card=jsonb_set(message.card,'{outputCommandIds}',
      COALESCE(message.card->'outputCommandIds','[]'::jsonb)||to_jsonb(pinned.command_id))
    FROM workflow_output_pins pinned WHERE message.id=pinned.visit_id
      AND NOT EXISTS (
        SELECT 1 FROM messages bound WHERE bound.room_id=pinned.room_id
          AND bound.card_type=message.card_type AND bound.card->'outputCommandIds' ? pinned.command_id
      )
    RETURNING message.id
  )`;
}

/** A handoff from an ordinary human turn also pins that turn before moving the run. */
export async function bindWorkflowStepOutput(db: SqlDatabase, command: CommandRow, runId: string): Promise<void> {
  await db.query(
    `WITH worked_command AS (SELECT * FROM agent_commands WHERE id=$1 AND room_id=$2),
     ${workflowOutputBindingCtes('worked_command', '$3::text')} SELECT 1`,
    [command.id, command.room_id, runId],
  );
}
