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
 * direct messages). Owed reads also include unresolved approval cards under
 * their decision authority, through the broader cornerOwedRowsSql below.
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
 * Human members' owed items, derived from the message log. The per-corner
 * candidate union bounds all message probes, including forwarded cards and
 * reports in another Room. Questions and grants retain their resolution rules;
 * ordinary tags, replies and deliverables clear after an answer or 24 hours.
 */
function cornerOwedRowsSql(corner: string): string {
  const candidates = `WITH open_corner AS MATERIALIZED (
      SELECT id FROM rooms WHERE id=${corner} AND parent_id IS NOT NULL AND archived_at IS NULL
    ), candidate_items AS MATERIALIZED (
      SELECT item.id FROM open_corner scope JOIN messages item ON item.room_id=scope.id
      UNION
      SELECT item.id FROM open_corner scope JOIN messages item ON item.card->>'sourceRoomId'=scope.id::text
      UNION
      SELECT item.id FROM open_corner scope JOIN agent_commands report ON
        (CASE WHEN report.private_payload->>'originCornerId' ~ '${CANONICAL_UUID}'
          THEN (report.private_payload->>'originCornerId')::uuid ELSE report.room_id END)=scope.id
        JOIN messages item ON item.request_id=report.id
    ) `;
  return `${candidates}SELECT owed_corner.id corner_id,person.id person_id,item.id message_id,item.created_at,
      CASE
        WHEN ${BLOCKING_ITEM} THEN CASE
          WHEN item.card->>'expiresAt' ~ '^[0-9]{1,15}$'
            THEN to_timestamp((item.card->>'expiresAt')::bigint/1000.0) END
        WHEN item.card_type IN ('grant-request','${CORNER_AGENT_UNREACHABLE_CARD_TYPE}') THEN NULL
        WHEN item.card_type='${CHOICE_CARD_TYPE}'
          AND COALESCE(item.card->>'status','open')='open' THEN NULL
        ELSE item.created_at+interval '${CORNER_OWED_EXPIRY_HOURS} hours'
      END expires_at,
      COALESCE(item.card_type,'') NOT IN ('grant-request','${CHOICE_CARD_TYPE}',
        'permission','connector-offer','app-sign-in','agent-sign-in','squire-approval') answerable,
      ${BLOCKING_ITEM} blocking
    FROM candidate_items candidate
    -- Preserve the candidate-id probe even when a tiny corner makes planner
    -- estimates favor a full primary-key index scan of the message ledger.
    CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=candidate.id OFFSET 0) item
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
    WHERE item.deleted_at IS NULL AND owed_corner.id=${corner} AND owed_corner.archived_at IS NULL
      AND (item.card->>'reportToId' IS NULL OR item.card->>'waitingAnswered' IS DISTINCT FROM 'true')
      AND (item.room_id=owed_corner.id OR EXISTS (
        SELECT 1 FROM memberships source_member WHERE source_member.room_id=(SELECT COALESCE(parent_id,id) FROM rooms WHERE id=item.room_id)
          AND source_member.identity_id=person.id AND source_member.removed_at IS NULL))
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
          JOIN agent_grants pending_grant ON pending_grant.id=CASE WHEN entry->>'grantId' ~ '${CANONICAL_UUID}'
              THEN (entry->>'grantId')::uuid END
            AND pending_grant.status='pending' AND pending_grant.superseded_at IS NULL
          WHERE ${grantDecidedBySql('pending_grant', 'person.id')}
        )
        WHEN item.card_type='${CHOICE_CARD_TYPE}'
          THEN item.card->>'mode'='question' AND COALESCE(item.card->>'status','open')='open'
            AND ${addressedToPersonSql('item', 'person.id', 'person.handle', 'person.kind')}
        ELSE ${addressedToPersonSql('item', 'person.id', 'person.handle', 'person.kind')}
          AND NOT EXISTS (
            SELECT 1 FROM messages answer
            WHERE answer.room_id=item.room_id AND answer.author_id=person.id
              AND answer.presentation='message' AND answer.deleted_at IS NULL
              AND answer.created_at>item.created_at
          )
      END`;
}

/** The same owed rule for lists, headers, blockers and database-clock deadlines.
 * `after` allows the deadline job to see items that expired since its last sweep. */
export function cornerOwedItemsSql(corner: string, after = 'now()'): string {
  return `SELECT * FROM (${cornerOwedRowsSql(corner)}) owed_items
    WHERE expires_at IS NULL OR expires_at>${after}`;
}

/** Retain legacy tables while removing their maintenance during rolling upgrades. */
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
JOIN room_access member ON member.room_id=corner.id AND member.removed_at IS NULL
JOIN identities person ON person.id=member.identity_id
CROSS JOIN LATERAL (SELECT report.private_payload->>'text' text,'message'::text presentation,
  corner.id room_id,COALESCE(fact.worker_agent_id,fact.owner_agent_id) author_id) item
WHERE corner.archived_at IS NULL AND item.text ~ '^(needs-decision|blocked):'
  AND (person.id=report.agent_id OR (person.kind='human' AND ${tagsKnownIdentitySql('item', 'person.id', 'person.handle', 'person.kind')}))
  AND report.private_payload->>'waitingAnswered' IS DISTINCT FROM 'true'
  AND NOT EXISTS(SELECT 1 FROM messages answer WHERE answer.room_id IN (corner.id,report.room_id)
    AND (answer.author_id=report.agent_id OR EXISTS(SELECT 1 FROM identities author
      JOIN room_access member ON member.identity_id=author.id AND member.room_id=corner.id
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
      AND (blocker.commander_id=NEW.author_id OR EXISTS(SELECT 1 FROM room_access member JOIN identities author ON author.id=member.identity_id
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
-- Retained until the separately approved table removal.
CREATE INDEX IF NOT EXISTS corner_owed_expires_idx ON corner_owed(expires_at)
  WHERE expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS corner_owed_message_insert ON messages;
DROP TRIGGER IF EXISTS corner_owed_message_update ON messages;
DROP TRIGGER IF EXISTS corner_owed_member_insert ON memberships;
DROP TRIGGER IF EXISTS corner_owed_member_update ON memberships;
DROP TRIGGER IF EXISTS corner_owed_handle_update ON identities;
DROP TRIGGER IF EXISTS corner_owed_facts_insert ON corner_facts;
DROP TRIGGER IF EXISTS corner_owed_facts_update ON corner_facts;
DROP TRIGGER IF EXISTS corner_owed_grant_update ON agent_grants;
DROP TRIGGER IF EXISTS corner_owed_permission_update ON permission_authority;
DROP FUNCTION IF EXISTS corner_owed_message_changed();
DROP FUNCTION IF EXISTS corner_owed_member_changed();
DROP FUNCTION IF EXISTS corner_owed_handle_changed();
DROP FUNCTION IF EXISTS corner_owed_facts_changed();
DROP FUNCTION IF EXISTS corner_owed_grant_changed();
DROP FUNCTION IF EXISTS corner_owed_permission_changed();
DROP FUNCTION IF EXISTS corner_owed_recompute_message(text);
DROP FUNCTION IF EXISTS corner_owed_refresh(uuid,text);

-- Human-directed reports keep their visible message and share the same waiting index.
INSERT INTO corner_report_blockers(corner_id,person_id,message_id,return_room_id,created_at,commander_id)
SELECT DISTINCT ON (owed.corner_id,owed.person_id)
  owed.corner_id,owed.person_id,report.id,report.room_id,report.created_at,report.card->>'reportToId'
FROM rooms seed_corner CROSS JOIN LATERAL (${cornerOwedItemsSql('seed_corner.id')}) owed
JOIN messages report ON report.id=owed.message_id
JOIN corner_facts fact ON fact.corner_id=owed.corner_id
WHERE seed_corner.parent_id IS NOT NULL AND seed_corner.archived_at IS NULL
  AND owed.blocking AND report.card->>'reportToId' IS NOT NULL
  AND report.card->>'waitingAnswered' IS DISTINCT FROM 'true'
  AND report.author_id=COALESCE(fact.worker_agent_id,fact.owner_agent_id)
  AND NOT EXISTS(SELECT 1 FROM messages answer JOIN room_access member
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

`;
}

/**
 * A LATERAL lookup over one corner (`corner`, a `rooms` row) and one viewer
 * (`viewerExpr`), evaluated from the message log, yielding:
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
    FROM (${cornerOwedItemsSql(`${corner}.id`)}) owed_item
  ) owed ON true`;
}
