import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';
import {
  CORNER_AGENT_UNREACHABLE_CARD_TYPE,
  CORNER_CHECKS_BLOCKED_CARD_TYPE,
  CORNER_MERGE_YES_CARD_TYPE,
  CORNER_REVIEW_DEADLOCK_CARD_TYPE,
} from './agent-command.js';
import { tagsKnownIdentitySql } from './message-mentions.js';
import { grantDecidedBySql } from './needs-you.js';

/** A tag, a reply, or a deliverable stops keeping its corner waiting this long after it was posted. */
const CORNER_OWED_EXPIRY_HOURS = 24;
const BLOCKING_ITEM = `COALESCE((item.text ~ '^(needs-decision|blocked):[[:space:]]*[^[:space:]]'
  OR (item.card_type='${CHOICE_CARD_TYPE}' AND item.card->>'mode'='question')
  OR item.card_type IN ('grant-request','permission','connector-offer',
    'agent-sign-in','app-sign-in','squire-approval')),false)`;
/** Historical automatic escalations remain readable but never request action. */
const RETIRED_AUTOMATIC_ATTENTION = [
  CORNER_CHECKS_BLOCKED_CARD_TYPE, CORNER_REVIEW_DEADLOCK_CARD_TYPE, CORNER_MERGE_YES_CARD_TYPE,
].map(type => `'${type}'`).join(',');
/** Card types owed until resolved, read whatever their age. */
const NEVER_EXPIRES = [
  CHOICE_CARD_TYPE,
  'grant-request',
  CORNER_AGENT_UNREACHABLE_CARD_TYPE,
]
  .map((type) => `'${type}'`)
  .join(',');

/** `uuid::text` spells a uuid this way, so a card id matching it compares as the original text did. */
const CANONICAL_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The person commissioned corner `finished`, or opened it. */
function commissionedBySql(finished: string, personIdExpr: string): string {
  return `(${finished}.commissioned_by=${personIdExpr} OR EXISTS (
    SELECT 1 FROM rooms opened WHERE opened.id=${finished}.corner_id AND opened.created_by=${personIdExpr}))`;
}

/**
 * Whether message `m` is addressed to one known person: it replies to them,
 * tags them, is an open question card meant for them, or is the final state
 * of a corner they commissioned. The push loop pushes exactly these (plus
 * direct messages); a corner holding one the person has not answered is
 * `waiting` on them. Both read this one rule.
 */
export function addressedToPersonSql(
  m: string,
  personIdExpr: string,
  personHandleExpr: string,
  personKindExpr: string,
  includeCommissioned = true,
): string {
  return `((COALESCE(${m}.card_type,'') NOT IN (${RETIRED_AUTOMATIC_ATTENTION})) AND (
    EXISTS (
      SELECT 1 FROM messages addressed
      WHERE addressed.id = ${m}.reply_to_message_id
        AND addressed.author_id=${personIdExpr}
    )
    OR ${tagsKnownIdentitySql(m, personIdExpr, personHandleExpr, personKindExpr)}
    OR (${m}.text ~ '^(needs-decision|blocked):' AND COALESCE(${m}.card->>'reportToId',(
      SELECT source.author_id FROM agent_commands command JOIN messages source
        ON source.id=command.root_source_message_id AND source.room_id=${m}.room_id
      WHERE command.id=${m}.request_id AND command.agent_id=${m}.author_id
    ))=${personIdExpr})
    -- A failed agent wake reaches the requester, or current Workspace managers.
    OR (${m}.card_type='${CORNER_AGENT_UNREACHABLE_CARD_TYPE}'
      AND COALESCE(${m}.card->>'status','open')='open'
      AND COALESCE(${m}.card->'recipientIds','[]'::jsonb) ? ${personIdExpr})
    -- An open question card reaches one person: the one human it
    -- tags, or the requester when it tags nobody. A question that
    -- tags several people, and every poll, reaches nobody.
    OR (
      ${m}.card_type='${CHOICE_CARD_TYPE}' AND ${m}.card->>'mode'='question'
      AND COALESCE(${m}.card->>'status','open')='open'
      AND CASE jsonb_array_length(COALESCE(${m}.card->'mentionIds','[]'::jsonb))
        WHEN 0 THEN ${m}.card->'requester'->>'pubkey'=${personIdExpr}
        WHEN 1 THEN ${m}.card->'mentionIds'->>0=${personIdExpr}
        ELSE false
      END
    )
    -- A corner's commissioner hears its final state whether or not
    -- an agent tags them: it landed (the parent Room's merge card),
    -- its worker posted a deliverable (files on a reply in a corner
    -- with no pull request). Recovery work goes back to the agent.
    -- Each probe reaches corner_facts by its primary key. One OR across
    -- both keys hid corner_id from the index, and the push loop then
    -- scanned the whole table once per candidate message.
    OR (${includeCommissioned} AND (
      (${m}.card_type='daemon-fact' AND ${m}.card->>'type'='corner-complete' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=CASE WHEN ${m}.card->>'cornerId' ~ '${CANONICAL_UUID}'
            THEN (${m}.card->>'cornerId')::uuid END
          AND ${commissionedBySql('finished', personIdExpr)}
      ))
      OR (${m}.presentation='message' AND EXISTS (
        SELECT 1 FROM corner_facts finished
        WHERE finished.corner_id=${m}.room_id
          AND ${commissionedBySql('finished', personIdExpr)}
          AND ${m}.author_id=finished.owner_agent_id
          -- A corner without a pull request path: its parent Room has no repository.
          AND NOT EXISTS (
            SELECT 1 FROM rooms finished_corner
            JOIN rooms finished_parent ON finished_parent.id=finished_corner.parent_id
            WHERE finished_corner.id=finished.corner_id
              AND (finished_parent.repository_resolution='repository'
                OR finished_parent.repository_key IS NOT NULL))
          AND jsonb_typeof(${m}.attachments)='array'
          AND jsonb_array_length(${m}.attachments)>0
      ))
    ))
  ))`;
}

/**
 * Which human members message `item` (a corner `messages` row) is owed to,
 * as `corner_owed` rows. An item is owed while it is open:
 * - a question card until it is answered or closed, and a grant request
 *   until it is decided; neither expires (`expires_at` NULL);
 * - an unresolved failed agent wake until that person posts in
 *   the corner after it; it never expires;
 * - a tag, reply, deliverable or actionable report until its person replies after
 *   it in the message's Room, or `CORNER_OWED_EXPIRY_HOURS` pass (`expires_at`).
 *
 * `answerable` rows are the ones a later post by their person clears.
 * `bulk` reads many items at once (backfill, a person's refresh): it reads
 * each person's latest post once instead of once per item, and skips items
 * that can no longer be owed.
 */
function cornerOwedRowsSql(where: string, bulk: boolean, corner?: string, parent?: string): string {
  const answered = bulk
    ? `(answered.at IS NULL OR answered.at<=item.created_at)`
    : `NOT EXISTS (
          SELECT 1 FROM messages answer
          WHERE answer.room_id=item.room_id AND answer.author_id=person.id
            AND answer.presentation='message' AND answer.deleted_at IS NULL
            AND answer.created_at>item.created_at
        )`;
  // The computed owed-corner CASE below cannot use messages.room_id's index.
  // Bound a one-corner refresh before evaluating it, including both kinds of
  // cross-Room item. Keep the final rules authoritative about attribution.
  const candidates = parent ? `WITH candidate_items AS MATERIALIZED (
      SELECT item.id FROM rooms child JOIN messages item ON item.room_id=child.id
        WHERE child.parent_id=${parent}
      UNION
      SELECT item.id FROM rooms child JOIN messages item ON item.card->>'sourceRoomId'=child.id::text
        WHERE child.parent_id=${parent}
      UNION
      SELECT item.id FROM rooms child JOIN agent_commands report ON
        (CASE WHEN report.private_payload->>'originCornerId' ~ '${CANONICAL_UUID}'
          THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END)=child.id
        JOIN messages item ON item.request_id=report.id WHERE child.parent_id=${parent}
    ) ` : corner ? `WITH candidate_items AS MATERIALIZED (
      SELECT id FROM messages WHERE room_id=${corner}
      UNION
      SELECT id FROM messages WHERE card->>'sourceRoomId'=${corner}::text
      UNION
      SELECT item.id FROM agent_commands report
      JOIN messages item ON item.request_id=report.id
      WHERE (CASE WHEN report.private_payload->>'originCornerId' ~ '${CANONICAL_UUID}'
        THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END)=${corner}
    ) ` : '';
  return `${candidates}SELECT owed_corner.id,person.id,item.id,item.created_at,
      CASE
        WHEN ${BLOCKING_ITEM} THEN CASE
          WHEN item.card->>'expiresAt' ~ '^[0-9]{1,15}$'
            THEN to_timestamp((item.card->>'expiresAt')::bigint/1000.0) END
        WHEN item.card_type IN ('grant-request','${CORNER_AGENT_UNREACHABLE_CARD_TYPE}') THEN NULL
        WHEN item.card_type='${CHOICE_CARD_TYPE}'
          AND COALESCE(item.card->>'status','open')='open' THEN NULL
        ELSE item.created_at+interval '${CORNER_OWED_EXPIRY_HOURS} hours'
      END,
      COALESCE(item.card_type,'') NOT IN ('grant-request','${CHOICE_CARD_TYPE}',
        'permission','connector-offer','app-sign-in','agent-sign-in','squire-approval'),
      ${BLOCKING_ITEM}
    FROM messages item
    ${corner || parent ? 'JOIN candidate_items candidate ON candidate.id=item.id' : ''}
    LEFT JOIN agent_commands report ON report.id=item.request_id AND report.agent_id=item.author_id
    LEFT JOIN rooms origin ON origin.id=CASE
      WHEN report.private_payload->>'originCornerId' ~ '${CANONICAL_UUID}'
        THEN (report.private_payload->>'originCornerId')::uuid
      ELSE report.room_id END AND origin.parent_id IS NOT NULL
    JOIN rooms owed_corner ON owed_corner.id=CASE
      WHEN item.card->>'sourceRoomId' ~ '${CANONICAL_UUID}'
        THEN (item.card->>'sourceRoomId')::uuid
      WHEN item.presentation='message' AND item.text ~ '^(blocked|needs-decision|failed):[[:space:]]*[^[:space:]]'
        THEN COALESCE(origin.id,item.room_id) ELSE item.room_id END
      AND owed_corner.parent_id IS NOT NULL
    JOIN memberships person_member ON person_member.room_id=owed_corner.parent_id
      AND person_member.removed_at IS NULL
      AND person_member.identity_id IS DISTINCT FROM item.author_id
    JOIN identities person ON person.id=person_member.identity_id AND person.kind='human'
    ${
      bulk
        ? `LEFT JOIN LATERAL (
      SELECT max(answer.created_at) at FROM messages answer
      WHERE answer.room_id=item.room_id AND answer.author_id=person.id
        AND answer.presentation='message' AND answer.deleted_at IS NULL
    ) answered ON true`
        : ''
    }
    WHERE item.deleted_at IS NULL AND (${where})
      AND (item.card->>'reportToId' IS NULL OR item.card->>'waitingAnswered' IS DISTINCT FROM 'true')
      AND (item.room_id=owed_corner.id OR EXISTS (
        SELECT 1 FROM memberships source_member WHERE source_member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=item.room_id)
          AND source_member.identity_id=person.id AND source_member.removed_at IS NULL))
      ${
        bulk
          ? `AND (${BLOCKING_ITEM} OR item.created_at>now()-interval '${CORNER_OWED_EXPIRY_HOURS} hours'
        OR (item.card_type IN (${NEVER_EXPIRES})
          AND (item.card_type<>'${CHOICE_CARD_TYPE}'
            OR COALESCE(item.card->>'status','open')='open')))`
          : ''
      }
      AND CASE
        WHEN item.card_type='permission' THEN EXISTS (
          SELECT 1 FROM permission_authority permission WHERE permission.permission_id=item.card->>'permissionId'
            AND permission.status='pending' AND permission.principal_id=person.id)
        WHEN item.card_type IN ('app-sign-in','agent-sign-in') THEN
          item.card->>'ownerId'=person.id AND item.card->>'status' IN ('starting','pending')
        WHEN item.card_type='connector-offer' THEN
          item.card->>'status'='pending' AND item.card->'addressee'->>'pubkey'=person.id
        WHEN item.card_type='squire-approval' THEN
          item.card->>'status' IS DISTINCT FROM 'expired'
          AND NOT EXISTS (SELECT 1 FROM messages decision WHERE decision.room_id=owed_corner.id
            AND decision.card_type='squire-approval-decision'
            AND decision.card->>'approvalId'=item.card->>'approvalId')
        WHEN item.card_type='grant-request' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(item.card->'grants')='array' THEN item.card->'grants' ELSE '[]'::jsonb END
          ) entry
          JOIN agent_grants pending_grant ON pending_grant.id::text=entry->>'grantId'
            AND pending_grant.status='pending' AND pending_grant.superseded_at IS NULL
          WHERE ${grantDecidedBySql('pending_grant', 'person.id')}
        )
        WHEN item.card_type='${CHOICE_CARD_TYPE}'
          THEN item.card->>'mode'='question' AND COALESCE(item.card->>'status','open')='open'
            AND ${addressedToPersonSql('item', 'person.id', 'person.handle', 'person.kind')}
        ELSE ${addressedToPersonSql('item', 'person.id', 'person.handle', 'person.kind')}
          AND ${answered}
      END`;
}

/** Refresh report-derived attention after edits or membership changes in its return Room. */
function refreshReportedCornersSql(room: string, person: string): string {
  return `PERFORM corner_owed_refresh(origin.id, ${person})
    FROM (SELECT DISTINCT source_origin.id FROM messages question
      JOIN agent_commands report ON report.id=question.request_id AND report.agent_id=question.author_id
      JOIN rooms source_origin ON source_origin.id=CASE
        WHEN report.private_payload->>'originCornerId' ~ '${CANONICAL_UUID}'
          THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END
        AND source_origin.parent_id IS NOT NULL
      WHERE question.room_id=${room} AND question.presentation='message' AND question.deleted_at IS NULL
        AND (question.text ~ '^needs-decision:' OR question.created_at>now()-interval '${CORNER_OWED_EXPIRY_HOURS} hours')
        AND question.text ~ '^(blocked|needs-decision|failed):[[:space:]]*[^[:space:]]'
    ) origin;`;
}

const CORNER_OWED_INSERT = `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable,blocking)`;

/**
 * `corner_owed` holds every open owed item per person, so readers look owed
 * facts up by corner instead of scanning the corner's messages. Triggers
 * keep it current in the writer's own transaction, whichever code path
 * writes: a message insert adds its rows and clears what its author
 * answered, a message edit recomputes that message, and membership, handle,
 * corner-owner and grant-status changes recompute the rows they feed.
 * Expired rows stay; readers skip them by `expires_at`.
 */
export function cornerOwedSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS corner_report_blockers (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  report_id text REFERENCES agent_commands(id) ON DELETE CASCADE,
  return_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(corner_id,person_id)
);
ALTER TABLE corner_report_blockers ALTER COLUMN report_id DROP NOT NULL;
ALTER TABLE corner_report_blockers ADD COLUMN IF NOT EXISTS message_id text REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE corner_report_blockers ADD COLUMN IF NOT EXISTS commander_id text REFERENCES identities(id) ON DELETE CASCADE;
UPDATE corner_report_blockers blocker SET commander_id=report.agent_id FROM agent_commands report
  WHERE report.id=blocker.report_id AND blocker.commander_id IS NULL;
CREATE INDEX IF NOT EXISTS corner_report_blockers_return_room ON corner_report_blockers(return_room_id,person_id);
CREATE INDEX IF NOT EXISTS corner_report_blockers_message ON corner_report_blockers(message_id);
CREATE INDEX IF NOT EXISTS corner_private_reports_origin ON agent_commands
  ((private_payload->>'fromRoomId'),(private_payload->>'authorId'),created_at DESC,id DESC)
  WHERE private_payload->>'kind'='report';
-- Recover unresolved reports already sent before this index existed.
INSERT INTO corner_report_blockers(corner_id,person_id,report_id,return_room_id,created_at,commander_id)
SELECT corner.id,person.id,report.id,report.room_id,report.created_at,report.agent_id
FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
JOIN LATERAL (SELECT command.* FROM agent_commands command
  WHERE command.private_payload->>'kind'='report'
    AND command.private_payload->>'fromRoomId'=corner.id::text
    AND command.private_payload->>'authorId'=COALESCE(fact.worker_agent_id,fact.owner_agent_id)
  ORDER BY command.created_at DESC,command.id DESC LIMIT 1) report ON true
JOIN effective_memberships member ON member.room_id=corner.id AND member.removed_at IS NULL
JOIN identities person ON person.id=member.identity_id
CROSS JOIN LATERAL (SELECT report.private_payload->>'text' text,'message'::text presentation,
  corner.id room_id,COALESCE(fact.worker_agent_id,fact.owner_agent_id) author_id) item
WHERE corner.archived_at IS NULL AND item.text ~ '^(needs-decision|blocked):'
  AND (person.id=report.agent_id OR (person.kind='human' AND ${tagsKnownIdentitySql('item', 'person.id', 'person.handle', 'person.kind')}))
  AND report.private_payload->>'waitingAnswered' IS DISTINCT FROM 'true'
  AND NOT EXISTS(SELECT 1 FROM messages answer WHERE answer.room_id IN (corner.id,report.room_id)
    AND (answer.author_id=report.agent_id OR EXISTS(SELECT 1 FROM identities author
      JOIN effective_memberships member ON member.identity_id=author.id AND member.room_id=corner.id
      WHERE author.id=answer.author_id AND author.kind='human' AND member.removed_at IS NULL))
    AND answer.presentation='message' AND answer.system_event IS NULL AND answer.deleted_at IS NULL
    AND answer.created_at>report.created_at)
  AND NOT EXISTS(SELECT 1 FROM agent_commands answer WHERE answer.room_id=corner.id
    AND answer.private_payload->>'kind'='order' AND answer.private_payload->>'authorId'=report.agent_id
    AND answer.created_at>report.created_at)
ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION clear_corner_report_blockers() RETURNS trigger LANGUAGE plpgsql AS $report$
BEGIN
  IF TG_TABLE_NAME='messages' THEN
    IF NOT EXISTS(SELECT 1 FROM corner_report_blockers
      WHERE corner_id=NEW.room_id OR return_room_id=NEW.room_id) THEN
      RETURN NULL;
    END IF;
    WITH answered AS (DELETE FROM corner_report_blockers blocker WHERE NEW.presentation='message'
      AND NEW.system_event IS NULL AND NEW.deleted_at IS NULL
      AND (blocker.corner_id=NEW.room_id OR blocker.return_room_id=NEW.room_id)
      AND blocker.created_at<NEW.created_at
      AND (blocker.commander_id=NEW.author_id OR EXISTS(SELECT 1 FROM effective_memberships member JOIN identities author ON author.id=member.identity_id
        WHERE member.room_id=blocker.corner_id AND member.removed_at IS NULL AND author.id=NEW.author_id
          AND author.kind='human'))
      RETURNING blocker.report_id,blocker.message_id)
    , commands AS (UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{waitingAnswered}','true')
      WHERE id IN (SELECT report_id FROM answered) RETURNING id)
    UPDATE messages SET card=jsonb_set(card,'{waitingAnswered}','true')
      WHERE id IN (SELECT message_id FROM answered);
  ELSIF TG_TABLE_NAME='agent_commands' THEN
    IF NEW.private_payload->>'kind' IS DISTINCT FROM 'order' THEN RETURN NULL; END IF;
    WITH answered AS (DELETE FROM corner_report_blockers blocker WHERE blocker.corner_id=NEW.room_id
      AND NEW.private_payload->>'kind'='order'
      AND blocker.commander_id=NEW.private_payload->>'authorId' RETURNING blocker.report_id,blocker.message_id)
    , commands AS (UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{waitingAnswered}','true')
      WHERE id IN (SELECT report_id FROM answered) RETURNING id)
    UPDATE messages SET card=jsonb_set(card,'{waitingAnswered}','true')
      WHERE id IN (SELECT message_id FROM answered);
  ELSE
    IF NEW.lifecycle->'pr'->>'headSha' IS DISTINCT FROM OLD.lifecycle->'pr'->>'headSha'
      AND NEW.lifecycle->'pr'->>'headSha' IS NOT NULL THEN
      WITH answered AS (DELETE FROM corner_report_blockers WHERE corner_id=NEW.corner_id RETURNING report_id,message_id)
      , commands AS (UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{waitingAnswered}','true')
        WHERE id IN (SELECT report_id FROM answered) RETURNING id)
      UPDATE messages SET card=jsonb_set(card,'{waitingAnswered}','true')
        WHERE id IN (SELECT message_id FROM answered);
    END IF;
  END IF;
  RETURN NULL;
END $report$;
DROP TRIGGER IF EXISTS corner_report_answer ON messages;
CREATE TRIGGER corner_report_answer AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION clear_corner_report_blockers();
DROP TRIGGER IF EXISTS corner_report_resume ON agent_turns;
DROP TRIGGER IF EXISTS corner_report_restart ON agent_turns;
DROP TRIGGER IF EXISTS corner_report_order ON agent_commands;
CREATE TRIGGER corner_report_order AFTER INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION clear_corner_report_blockers();
DROP TRIGGER IF EXISTS corner_report_push ON corner_facts;
CREATE TRIGGER corner_report_push AFTER UPDATE OF lifecycle ON corner_facts FOR EACH ROW EXECUTE FUNCTION clear_corner_report_blockers();
-- A queued automatic wake predating the report is not new input either.
CREATE OR REPLACE FUNCTION quiet_corner_report_wakes() RETURNS trigger LANGUAGE plpgsql AS $quiet$
BEGIN
  WITH cancelled AS (
    UPDATE agent_commands command SET state='cancelled',completed_at=now(),cancellation_reason='corner_waiting'
    WHERE command.room_id=NEW.corner_id AND command.state='pending' AND command.action IN ('input','resume')
      AND command.private_payload->>'kind' IS DISTINCT FROM 'order'
      AND command.private_payload->>'kind' IS DISTINCT FROM 'report'
      AND NOT EXISTS(SELECT 1 FROM messages source JOIN identities author ON author.id=source.author_id
        WHERE source.id=command.source_message_id AND author.kind='human' AND source.system_event IS NULL)
    RETURNING command.*)
  UPDATE agent_turns turn SET status='cancelled',created_at=now()
    FROM cancelled WHERE turn.room_id=cancelled.room_id AND turn.agent_id=cancelled.agent_id
      AND turn.request_id=cancelled.turn_request_id AND turn.status='working';
  RETURN NULL;
END $quiet$;
DROP TRIGGER IF EXISTS corner_report_quiet ON corner_report_blockers;
CREATE TRIGGER corner_report_quiet AFTER INSERT OR UPDATE ON corner_report_blockers FOR EACH ROW EXECUTE FUNCTION quiet_corner_report_wakes();
CREATE TABLE IF NOT EXISTS corner_owed (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  answerable boolean NOT NULL,
  blocking boolean NOT NULL DEFAULT false,
  PRIMARY KEY (message_id, person_id)
);
ALTER TABLE corner_owed ADD COLUMN IF NOT EXISTS blocking boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS corner_owed_corner_person_idx ON corner_owed(corner_id, person_id);
CREATE INDEX IF NOT EXISTS corner_owed_blocking_idx ON corner_owed(corner_id,created_at DESC,message_id DESC)
  WHERE blocking;
-- The leader's owed expiry job finds due and next expiries by this index.
CREATE INDEX IF NOT EXISTS corner_owed_expires_idx ON corner_owed(expires_at)
  WHERE expires_at IS NOT NULL;

-- Every item one person is owed in one corner, recomputed from messages.
CREATE OR REPLACE FUNCTION corner_owed_refresh(p_corner uuid, p_person text) RETURNS void
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  DELETE FROM corner_owed WHERE corner_id=p_corner AND person_id=p_person;
  ${CORNER_OWED_INSERT}
  ${cornerOwedRowsSql('owed_corner.id=p_corner AND person.id=p_person', true, 'p_corner')}
  ON CONFLICT DO NOTHING;
END
$corner_owed$;

-- The rows one message is owed by, recomputed from that message.
CREATE OR REPLACE FUNCTION corner_owed_recompute_message(p_message text) RETURNS void
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  DELETE FROM corner_owed WHERE message_id=p_message;
  ${CORNER_OWED_INSERT}
  ${cornerOwedRowsSql('item.id=p_message', false)}
  ON CONFLICT DO NOTHING;
END
$corner_owed$;

CREATE OR REPLACE FUNCTION corner_owed_message_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  IF NEW.card_type='squire-approval-decision' THEN
    PERFORM corner_owed_recompute_message(owed.message_id)
      FROM corner_owed owed JOIN messages approval ON approval.id=owed.message_id
      WHERE owed.corner_id=NEW.room_id AND approval.card_type='squire-approval'
        AND approval.card->>'approvalId'=NEW.card->>'approvalId';
  END IF;
  -- A reply in the return Room also answers reports owed by their originating corner.
  IF TG_OP='INSERT' AND NEW.presentation='message' AND NEW.deleted_at IS NULL THEN
    DELETE FROM corner_owed owed
    WHERE owed.person_id=NEW.author_id AND owed.answerable AND owed.created_at<NEW.created_at
      AND (owed.corner_id=NEW.room_id OR EXISTS (
        SELECT 1 FROM messages question WHERE question.id=owed.message_id AND question.room_id=NEW.room_id));
  END IF;
  IF TG_OP='UPDATE' AND (OLD.presentation='message' OR NEW.presentation='message')
    AND (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.presentation IS DISTINCT FROM NEW.presentation
      OR OLD.author_id IS DISTINCT FROM NEW.author_id) THEN
    ${refreshReportedCornersSql('NEW.room_id', 'NEW.author_id')}
    IF OLD.author_id IS DISTINCT FROM NEW.author_id THEN
      ${refreshReportedCornersSql('OLD.room_id', 'OLD.author_id')}
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rooms WHERE id=NEW.room_id AND parent_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM rooms WHERE id=CASE WHEN NEW.card->>'sourceRoomId' ~ '${CANONICAL_UUID}'
      THEN (NEW.card->>'sourceRoomId')::uuid END AND parent_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM agent_commands report JOIN rooms origin ON origin.id=CASE
      WHEN report.private_payload->>'originCornerId' ~ '${CANONICAL_UUID}'
        THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END
      WHERE report.id=NEW.request_id AND report.agent_id=NEW.author_id AND origin.parent_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' THEN
    ${CORNER_OWED_INSERT}
    ${cornerOwedRowsSql('item.id=NEW.id', false)}
    ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  -- A post that stops or starts answering (deleted, moved, re-authored)
  -- changes what its author is owed.
  IF (OLD.presentation='message' OR NEW.presentation='message')
    AND (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.presentation IS DISTINCT FROM NEW.presentation
      OR OLD.author_id IS DISTINCT FROM NEW.author_id) THEN
    PERFORM corner_owed_refresh(NEW.room_id, NEW.author_id);
    IF OLD.author_id IS DISTINCT FROM NEW.author_id THEN
      PERFORM corner_owed_refresh(NEW.room_id, OLD.author_id);
    END IF;
  END IF;
  PERFORM corner_owed_recompute_message(NEW.id);
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_message_insert ON messages;
CREATE TRIGGER corner_owed_message_insert AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION corner_owed_message_changed();
DROP TRIGGER IF EXISTS corner_owed_message_update ON messages;
CREATE TRIGGER corner_owed_message_update
  AFTER UPDATE OF text,card,card_type,presentation,reply_to_message_id,attachments,
    author_id,created_at,deleted_at ON messages
  FOR EACH ROW WHEN (
    (OLD.text,OLD.card,OLD.card_type,OLD.presentation,OLD.reply_to_message_id,
      OLD.attachments,OLD.author_id,OLD.created_at,OLD.deleted_at)
    IS DISTINCT FROM
    (NEW.text,NEW.card,NEW.card_type,NEW.presentation,NEW.reply_to_message_id,
      NEW.attachments,NEW.author_id,NEW.created_at,NEW.deleted_at)
  ) EXECUTE FUNCTION corner_owed_message_changed();

-- Joining or leaving a corner, or its Room (whose membership an @channel
-- tag reads), changes what that person is owed there.
-- Membership changes are short OLTP writes. Planner estimates over inherited
-- audiences must not trigger seconds of LLVM compilation on a large Room.
CREATE OR REPLACE FUNCTION corner_owed_member_changed() RETURNS trigger
LANGUAGE plpgsql SET jit=off AS $corner_owed$
DECLARE
  member memberships%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN member := OLD; ELSE member := NEW; END IF;
  IF member.room_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM identities WHERE id=member.identity_id AND kind='human') THEN
    RETURN NULL;
  END IF;
  -- Legacy corner-row deletion during migration cannot change inherited access.
  IF EXISTS (SELECT 1 FROM rooms WHERE id=member.room_id AND parent_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  DELETE FROM corner_owed owed USING rooms corner
    WHERE owed.corner_id=corner.id AND corner.parent_id=member.room_id AND owed.person_id=member.identity_id;
  ${CORNER_OWED_INSERT}
  ${cornerOwedRowsSql('owed_corner.parent_id=member.room_id AND person.id=member.identity_id', true, undefined, 'member.room_id')}
  ON CONFLICT DO NOTHING;
  ${refreshReportedCornersSql('member.room_id', 'member.identity_id')}
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_member_insert ON memberships;
CREATE TRIGGER corner_owed_member_insert AFTER INSERT OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION corner_owed_member_changed();
DROP TRIGGER IF EXISTS corner_owed_member_update ON memberships;
CREATE TRIGGER corner_owed_member_update AFTER UPDATE OF removed_at,room_id,identity_id ON memberships
  FOR EACH ROW WHEN (
    (OLD.removed_at,OLD.room_id,OLD.identity_id) IS DISTINCT FROM
    (NEW.removed_at,NEW.room_id,NEW.identity_id)
  ) EXECUTE FUNCTION corner_owed_member_changed();

-- A handle change changes which tags reach that person.
CREATE OR REPLACE FUNCTION corner_owed_handle_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  PERFORM corner_owed_refresh(corner.id, NEW.id)
  FROM rooms corner
  JOIN memberships corner_member ON corner_member.room_id=corner.parent_id
    AND corner_member.identity_id=NEW.id AND corner_member.removed_at IS NULL
  WHERE corner.parent_id IS NOT NULL;
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_handle_update ON identities;
CREATE TRIGGER corner_owed_handle_update AFTER UPDATE OF handle,kind ON identities
  FOR EACH ROW WHEN ((OLD.handle,OLD.kind) IS DISTINCT FROM (NEW.handle,NEW.kind))
  EXECUTE FUNCTION corner_owed_handle_changed();

-- The commissioner and owner decide whose deliverables and finished
-- states are owed to whom.
CREATE OR REPLACE FUNCTION corner_owed_facts_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  PERFORM corner_owed_refresh(NEW.corner_id, member.identity_id)
  FROM effective_memberships member
  JOIN identities person ON person.id=member.identity_id AND person.kind='human'
  WHERE member.room_id=NEW.corner_id AND member.removed_at IS NULL;
  IF TG_OP='UPDATE' AND OLD.commissioned_by IS DISTINCT FROM NEW.commissioned_by
    AND OLD.commissioned_by IS NOT NULL THEN
    PERFORM corner_owed_refresh(NEW.corner_id, OLD.commissioned_by);
  END IF;
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_facts_insert ON corner_facts;
CREATE TRIGGER corner_owed_facts_insert AFTER INSERT ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_owed_facts_changed();
DROP TRIGGER IF EXISTS corner_owed_facts_update ON corner_facts;
CREATE TRIGGER corner_owed_facts_update
  AFTER UPDATE OF commissioned_by,owner_agent_id ON corner_facts
  FOR EACH ROW WHEN (
    (OLD.commissioned_by,OLD.owner_agent_id) IS DISTINCT FROM
    (NEW.commissioned_by,NEW.owner_agent_id)
  ) EXECUTE FUNCTION corner_owed_facts_changed();

-- A grant changing status recomputes the cards that ask it: the owed ones,
-- and any in the grant's own Room. A card that gains a grant is an edit,
-- which the message trigger already recomputes.
CREATE OR REPLACE FUNCTION corner_owed_grant_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  PERFORM corner_owed_recompute_message(card.id)
  FROM messages card
  WHERE (card.room_id=NEW.room_id OR card.id IN (SELECT owed.message_id FROM corner_owed owed))
    AND card.card_type='grant-request' AND jsonb_typeof(card.card->'grants')='array'
    AND card.card->'grants' @> jsonb_build_array(jsonb_build_object('grantId',NEW.id::text));
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_grant_update ON agent_grants;
CREATE TRIGGER corner_owed_grant_update AFTER UPDATE OF status ON agent_grants
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION corner_owed_grant_changed();

CREATE OR REPLACE FUNCTION corner_owed_permission_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  PERFORM corner_owed_recompute_message(card.id) FROM messages card
    WHERE card.room_id=NEW.room_id AND card.card_type='permission'
      AND card.card->>'permissionId'=NEW.permission_id;
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_permission_update ON permission_authority;
CREATE TRIGGER corner_owed_permission_update AFTER UPDATE OF status ON permission_authority
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION corner_owed_permission_changed();

-- Human-directed reports keep their visible message and share the same waiting index.
INSERT INTO corner_report_blockers(corner_id,person_id,message_id,return_room_id,created_at,commander_id)
SELECT DISTINCT ON (owed.corner_id,owed.person_id)
  owed.corner_id,owed.person_id,report.id,report.room_id,report.created_at,report.card->>'reportToId'
FROM corner_owed owed JOIN messages report ON report.id=owed.message_id
JOIN corner_facts fact ON fact.corner_id=owed.corner_id
WHERE owed.blocking AND report.card->>'reportToId' IS NOT NULL
  AND report.card->>'waitingAnswered' IS DISTINCT FROM 'true'
  AND report.author_id=COALESCE(fact.worker_agent_id,fact.owner_agent_id)
  AND NOT EXISTS(SELECT 1 FROM messages answer JOIN effective_memberships member
    ON member.room_id=owed.corner_id AND member.identity_id=answer.author_id AND member.removed_at IS NULL
    JOIN identities person ON person.id=answer.author_id AND person.kind='human'
    WHERE answer.room_id IN (owed.corner_id,report.room_id) AND answer.presentation='message'
      AND answer.system_event IS NULL AND answer.deleted_at IS NULL AND answer.created_at>report.created_at)
  AND NOT EXISTS(SELECT 1 FROM agent_commands answer WHERE answer.room_id=owed.corner_id
    AND answer.private_payload->>'kind'='order' AND answer.private_payload->>'authorId'=report.card->>'reportToId'
    AND answer.created_at>report.created_at)
ORDER BY owed.corner_id,owed.person_id,report.created_at DESC,report.id DESC
ON CONFLICT DO NOTHING;

-- Old writers may have queued work before quieting was installed. Reapply it
-- to restored and existing blockers without changing their waiting timestamps.
UPDATE corner_report_blockers SET commander_id=commander_id;

-- Existing projection rows from the former automatic escalation policy must
-- not keep a person waiting after release. History itself stays readable.
DELETE FROM corner_owed owed USING messages item
WHERE item.id=owed.message_id AND item.card_type IN (${RETIRED_AUTOMATIC_ATTENTION});
`;
}

/** Fill `corner_owed` from every corner's messages, once, on the release that adds it. */
export function cornerOwedBackfillSql(): string {
  return `${CORNER_OWED_INSERT}
    ${cornerOwedRowsSql('true', true)}
    ON CONFLICT(message_id,person_id) DO UPDATE SET
      blocking=EXCLUDED.blocking,expires_at=EXCLUDED.expires_at`;
}

/**
 * A LATERAL lookup over one corner (`corner`, a `rooms` row) and one viewer
 * (`viewerExpr`) in `corner_owed`, never in messages, yielding:
 *
 * - `owed`: something in the corner is still owed to a human member;
 * - `owed_viewer`: something is owed to the viewer;
 * - `attention`: something owed to the viewer is newer than their read mark
 *   in the corner, so they have not opened it since.
 */
export function cornerOwedLookupSql(corner: string, viewerExpr: string): string {
  return `LEFT JOIN LATERAL (
    SELECT COALESCE(bool_or(true),false) owed,
      COALESCE(bool_or(owed_item.blocking),false) blocking,
      COALESCE(bool_or(owed_item.person_id=${viewerExpr}),false) owed_viewer,
      COALESCE(bool_or(owed_item.person_id=${viewerExpr} AND NOT EXISTS (
        SELECT 1 FROM room_read_marks seen
        WHERE seen.room_id=${corner}.id AND seen.identity_id=${viewerExpr}
          AND (seen.message_created_at,seen.message_id)>=(owed_item.created_at,owed_item.message_id)
      )),false) attention
    FROM corner_owed owed_item
    JOIN memberships current_member ON current_member.room_id=${corner}.parent_id
      AND current_member.identity_id=owed_item.person_id AND current_member.removed_at IS NULL
    WHERE owed_item.corner_id=${corner}.id
      AND (owed_item.expires_at IS NULL OR owed_item.expires_at>now())
  ) owed ON true`;
}
