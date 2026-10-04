import type { CommandRow } from './agent-command.js';
import { CORNER_LIFECYCLE_CONTRACT } from './corner-lifecycle.js';
import { cornerImplementerSql } from './corner-worker.js';
import type { SqlDatabase } from './database.js';

/** Pin authorized turns to visits within the statement that claims them. */
export function workflowOutputBindingCtes(commandRelation: string, runIdSql = 'NULL::text'): string {
  const cornerRoles = JSON.stringify(Object.fromEntries(
    Object.entries(CORNER_LIFECYCLE_CONTRACT.handoffs).map(([name, state]) => [name, 'role' in state ? state.role : null]),
  ));
  return `workflow_output_scope AS (
    SELECT command.id command_id,command.room_id,command.action,command.parent_command_id,
      command.agent_id,command.source_message_id,parent.id parent_room_id,
      ${cornerImplementerSql('fact', 'room')} implementer_agent_id,
      parent.reviewer_agent_id,parent.reviewer_fallback_ids,
      COALESCE(${runIdSql},source.card->>'runId',choice_message.card->>'runId',
        CASE WHEN room.parent_id IS NOT NULL THEN room.id::text END) run_id
    FROM ${commandRelation} command
    JOIN rooms room ON room.id=command.room_id
    LEFT JOIN corner_facts fact ON fact.corner_id=room.id
    LEFT JOIN rooms parent ON parent.id=room.parent_id
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
      JOIN agent_commands parent ON parent.id=scope.parent_command_id AND parent.agent_id=scope.agent_id
      WHERE scope.action='resume' AND message.room_id=scope.room_id
        AND message.card_type IN ('workflow-handoff','corner-workflow-handoff')
        AND message.card->'outputCommandIds' ? scope.parent_command_id
      ORDER BY message.created_at DESC,message.id DESC LIMIT 1
    ) parent_visit ON true
    LEFT JOIN LATERAL (
      SELECT message.id,message.card_type,
        CASE '${cornerRoles}'::jsonb->>(message.card->>'toState')
          WHEN 'implementer' THEN scope.agent_id=scope.implementer_agent_id
          WHEN 'reviewer' THEN scope.reviewer_agent_id IS NOT NULL
            AND scope.agent_id=ANY(array_prepend(scope.reviewer_agent_id,
              COALESCE(scope.reviewer_fallback_ids,ARRAY[]::text[])))
            AND EXISTS (SELECT 1 FROM memberships member
              WHERE member.room_id=scope.parent_room_id AND member.identity_id=scope.agent_id
                AND member.removed_at IS NULL)
          ELSE false END holder_matches
      FROM messages message
      WHERE parent_visit.id IS NULL AND message.room_id=scope.room_id
        AND message.card->>'runId'=scope.run_id
        AND message.card_type IN ('workflow-handoff','corner-workflow-handoff')
        AND message.card->>'toState' IS NOT NULL
        AND NOT COALESCE((message.card->>'reassigned')::boolean,false)
      ORDER BY (message.id=scope.source_message_id) DESC,
        (message.card->>'seq')::int DESC NULLS LAST,message.created_at DESC,message.id DESC
      LIMIT 1
    ) latest ON true
    WHERE parent_visit.id IS NOT NULL OR latest.card_type='workflow-handoff'
      OR latest.id=scope.source_message_id OR latest.holder_matches
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
