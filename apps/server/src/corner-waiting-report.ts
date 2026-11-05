import { cornerImplementerSql } from './corner-worker.js';
import { tagsKnownIdentitySql } from './message-mentions.js';

/** The report's originating corner, including a human report in its return Room. */
export function humanReportCornerSql(message: string): string {
  return `COALESCE(${message}.card->>'sourceRoomId',(
    SELECT COALESCE(source.private_payload->>'originCornerId',source.room_id::text)
    FROM agent_commands source WHERE source.id=${message}.request_id AND source.agent_id=${message}.author_id
  ),${message}.room_id::text)`;
}

/** Keep forwarded reports on their origin index, with a separate legacy fallback. */
export function cornerHumanReportsSql(cornerId: string, workerId: string): string {
  return `SELECT message.* FROM messages message
    WHERE message.author_id=${workerId} AND message.card->>'reportToId' IS NOT NULL
      AND message.card->>'sourceRoomId'=(${cornerId})::text
    UNION ALL
    SELECT message.* FROM messages message
    WHERE message.room_id=${cornerId} AND message.author_id=${workerId}
      AND message.card->>'reportToId' IS NOT NULL AND message.card->>'sourceRoomId' IS NULL
      AND ${humanReportCornerSql('message')}=(${cornerId})::text
    UNION ALL
    SELECT message.* FROM agent_commands source
    JOIN messages message ON message.request_id=source.id AND message.author_id=source.agent_id
    WHERE source.agent_id=${workerId}
      AND (CASE WHEN source.private_payload->>'originCornerId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (source.private_payload->>'originCornerId')::uuid ELSE source.room_id END)=${cornerId}
      AND message.room_id<>${cornerId} AND message.card->>'reportToId' IS NOT NULL
      AND message.card->>'sourceRoomId' IS NULL
      AND ${humanReportCornerSql('message')}=(${cornerId})::text`;
}

/**
 * The newest explicit worker wait, unless it has been answered. The log owns
 * both the return address and the answered marker; no waiting projection is stored.
 * An explicit private report has its existing agent-command card; automatic final
 * prose has no such card and cannot start a wait even when it says "blocked:".
 * One row per recipient: the recorded commander and tagged human corner members.
 * `message_id` is the display target; `card_id` also retains cross-Room report cards
 * so clearing marks both the private command and its visible record answered.
 */
export function cornerWaitingReportSql(corner: string): string {
  return `SELECT ${corner}.id corner_id,latest.report_id,latest.message_id,latest.card_id,
    latest.return_room_id,latest.created_at,latest.commander_id,person.id person_id
  FROM corner_facts waiting_fact
  CROSS JOIN LATERAL (
    SELECT reports.* FROM (
      (SELECT command.id report_id,
        CASE WHEN command.room_id=${corner}.id THEN visible.id END message_id,
        visible.id card_id,command.room_id return_room_id,command.created_at,
        command.agent_id commander_id,command.private_payload->>'text' text,
        command.private_payload->>'waitingAnswered' answered,command.id sort_id
      FROM agent_commands command
      JOIN messages visible ON visible.id=encode(sha256(convert_to('agent-command-card:'||command.id,'UTF8')),'hex')
        AND visible.card_type='agent-command' AND visible.card->>'kind'='report'
      WHERE command.private_payload->>'kind'='report'
        AND command.private_payload->>'text' ~ '^(needs-decision|blocked):'
        AND command.private_payload->>'fromRoomId'=${corner}.id::text
        AND command.private_payload->>'authorId'=${cornerImplementerSql('waiting_fact', corner)}
      ORDER BY command.created_at DESC,command.id DESC LIMIT 1)
      UNION ALL
      (SELECT NULL::text,message.id,encode(sha256(convert_to('agent-command-card:'||message.id,'UTF8')),'hex'),message.room_id,message.created_at,
        message.card->>'reportToId',message.text,message.card->>'waitingAnswered',message.id
      FROM (${cornerHumanReportsSql(`${corner}.id`, cornerImplementerSql('waiting_fact', corner))}) message
      WHERE message.card->>'reportToId' IS NOT NULL
        AND message.text ~ '^(needs-decision|blocked):'
        AND message.presentation='message' AND message.system_event IS NULL AND message.deleted_at IS NULL
        AND message.author_id=${cornerImplementerSql('waiting_fact', corner)}
        AND ${humanReportCornerSql('message')}=${corner}.id::text
      ORDER BY message.created_at DESC,message.id DESC LIMIT 1)
    ) reports ORDER BY reports.created_at DESC,reports.sort_id DESC LIMIT 1
  ) latest
  CROSS JOIN LATERAL (SELECT latest.text,'message'::text presentation,${corner}.id room_id,
    ${cornerImplementerSql('waiting_fact', corner)} author_id) item
  JOIN identities person ON person.id=latest.commander_id OR (person.kind='human' AND EXISTS (
    SELECT 1 FROM room_access member WHERE member.room_id=${corner}.id
      AND member.identity_id=person.id AND member.removed_at IS NULL
  ) AND ${tagsKnownIdentitySql('item', 'person.id', 'person.handle', 'person.kind')})
  WHERE waiting_fact.corner_id=${corner}.id
    AND latest.text ~ '^(needs-decision|blocked):'
    AND latest.answered IS DISTINCT FROM 'true'`;
}

/**
 * The same wait as a database function, for gates on the claim path. Postgres
 * does not inline a plpgsql body, so the claim query plans one call instead of
 * the whole derivation. The migration rebuilds it from this builder.
 */
export function cornerWaitingFunctionSql(): string {
  return `CREATE OR REPLACE FUNCTION corner_has_explicit_wait(waiting_corner_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $corner_wait$
BEGIN
  RETURN EXISTS (SELECT 1 FROM rooms waiting_corner
    CROSS JOIN LATERAL (${cornerWaitingReportSql('waiting_corner')}) waiting
    WHERE waiting_corner.id=waiting_corner_id);
END $corner_wait$;`;
}
