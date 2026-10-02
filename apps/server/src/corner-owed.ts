import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';
import {
  CORNER_CHECKS_BLOCKED_CARD_TYPE,
  CORNER_REVIEW_DEADLOCK_CARD_TYPE,
} from './agent-command.js';
import { tagsKnownIdentitySql } from './message-mentions.js';
import { grantDecidedBySql } from './needs-you.js';

/** A tag, a reply, or a deliverable stops keeping its corner waiting this long after it was posted. */
const CORNER_OWED_EXPIRY_HOURS = 24;
/** Card types owed until resolved, read whatever their age. */
const NEVER_EXPIRES = [
  CHOICE_CARD_TYPE,
  'grant-request',
  CORNER_CHECKS_BLOCKED_CARD_TYPE,
  CORNER_REVIEW_DEADLOCK_CARD_TYPE,
]
  .map((type) => `'${type}'`)
  .join(',');

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
): string {
  return `(
    EXISTS (
      SELECT 1 FROM messages addressed
      WHERE addressed.id = ${m}.reply_to_message_id
        AND addressed.author_id=${personIdExpr}
    )
    OR ${tagsKnownIdentitySql(m, personIdExpr, personHandleExpr, personKindExpr)}
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
    -- with no pull request), its checks are failing with nobody left
    -- to fix them, or it stopped at the review handback limit.
    OR EXISTS (
      SELECT 1 FROM corner_facts finished
      WHERE finished.commissioned_by=${personIdExpr}
        AND (
          (${m}.card_type='daemon-fact' AND ${m}.card->>'type'='corner-complete'
            AND finished.corner_id::text=${m}.card->>'cornerId')
          OR (${m}.presentation='message' AND finished.corner_id=${m}.room_id
            AND finished.lane<>'code' AND ${m}.author_id=finished.owner_agent_id
            AND jsonb_typeof(${m}.attachments)='array'
            AND jsonb_array_length(${m}.attachments)>0)
          OR (${m}.card_type IN ('${CORNER_CHECKS_BLOCKED_CARD_TYPE}',
              '${CORNER_REVIEW_DEADLOCK_CARD_TYPE}')
            AND finished.corner_id=${m}.room_id)
        )
    )
  )`;
}

/**
 * Which human members message `item` (a corner `messages` row) is owed to,
 * as `corner_owed` rows. An item is owed while it is open:
 * - a question card until it is answered or closed, and a grant request
 *   until it is decided; neither expires (`expires_at` NULL);
 * - a checks-blocked or review-handback line until that person posts in
 *   the corner after it; it never expires;
 * - a tag, reply or deliverable until that person posts in the corner after
 *   it, or `CORNER_OWED_EXPIRY_HOURS` pass (`expires_at`).
 *
 * `answerable` rows are the ones a later post by their person clears.
 * `bulk` reads many items at once (backfill, a person's refresh): it reads
 * each person's latest post once instead of once per item, and skips items
 * that can no longer be owed.
 */
function cornerOwedRowsSql(where: string, bulk: boolean): string {
  const answered = bulk
    ? `(answered.at IS NULL OR answered.at<=item.created_at)`
    : `NOT EXISTS (
          SELECT 1 FROM messages answer
          WHERE answer.room_id=item.room_id AND answer.author_id=person.id
            AND answer.presentation='message' AND answer.deleted_at IS NULL
            AND answer.created_at>item.created_at
        )`;
  return `SELECT item.room_id,person.id,item.id,item.created_at,
      CASE
        WHEN item.card_type IN ('grant-request','${CORNER_CHECKS_BLOCKED_CARD_TYPE}',
            '${CORNER_REVIEW_DEADLOCK_CARD_TYPE}') THEN NULL
        WHEN item.card_type='${CHOICE_CARD_TYPE}'
          AND COALESCE(item.card->>'status','open')='open' THEN NULL
        ELSE item.created_at+interval '${CORNER_OWED_EXPIRY_HOURS} hours'
      END,
      item.card_type IS DISTINCT FROM 'grant-request'
        AND item.card_type IS DISTINCT FROM '${CHOICE_CARD_TYPE}'
    FROM messages item
    JOIN rooms owed_corner ON owed_corner.id=item.room_id AND owed_corner.parent_id IS NOT NULL
    JOIN memberships person_member ON person_member.room_id=item.room_id
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
      ${
        bulk
          ? `AND (item.created_at>now()-interval '${CORNER_OWED_EXPIRY_HOURS} hours'
        OR (item.card_type IN (${NEVER_EXPIRES})
          AND (item.card_type<>'${CHOICE_CARD_TYPE}'
            OR COALESCE(item.card->>'status','open')='open')))`
          : ''
      }
      AND CASE
        WHEN item.card_type='grant-request' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(item.card->'grants')='array' THEN item.card->'grants' ELSE '[]'::jsonb END
          ) entry
          JOIN agent_grants pending_grant ON pending_grant.id::text=entry->>'grantId'
            AND pending_grant.status='pending'
          WHERE ${grantDecidedBySql('pending_grant', 'person.id')}
        )
        WHEN item.card_type='${CHOICE_CARD_TYPE}'
          THEN ${addressedToPersonSql('item', 'person.id', 'person.handle', 'person.kind')}
        ELSE ${addressedToPersonSql('item', 'person.id', 'person.handle', 'person.kind')}
          AND ${answered}
      END`;
}

const CORNER_OWED_INSERT = `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable)`;

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
CREATE TABLE IF NOT EXISTS corner_owed (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  answerable boolean NOT NULL,
  PRIMARY KEY (message_id, person_id)
);
CREATE INDEX IF NOT EXISTS corner_owed_corner_person_idx ON corner_owed(corner_id, person_id);

-- Every item one person is owed in one corner, recomputed from messages.
CREATE OR REPLACE FUNCTION corner_owed_refresh(p_corner uuid, p_person text) RETURNS void
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  DELETE FROM corner_owed WHERE corner_id=p_corner AND person_id=p_person;
  ${CORNER_OWED_INSERT}
  ${cornerOwedRowsSql('item.room_id=p_corner AND person.id=p_person', true)}
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
  IF NOT EXISTS (SELECT 1 FROM rooms WHERE id=NEW.room_id AND parent_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' THEN
    -- A person's post answers every answerable item owed to them before it.
    IF NEW.presentation='message' AND NEW.deleted_at IS NULL THEN
      DELETE FROM corner_owed
      WHERE corner_id=NEW.room_id AND person_id=NEW.author_id AND answerable
        AND created_at<NEW.created_at;
    END IF;
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
CREATE OR REPLACE FUNCTION corner_owed_member_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
DECLARE
  member memberships%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN member := OLD; ELSE member := NEW; END IF;
  IF member.room_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM identities WHERE id=member.identity_id AND kind='human') THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM rooms WHERE id=member.room_id AND parent_id IS NOT NULL) THEN
    PERFORM corner_owed_refresh(member.room_id, member.identity_id);
  ELSE
    PERFORM corner_owed_refresh(corner.id, member.identity_id)
    FROM rooms corner
    JOIN memberships corner_member ON corner_member.room_id=corner.id
      AND corner_member.identity_id=member.identity_id AND corner_member.removed_at IS NULL
    WHERE corner.parent_id=member.room_id;
  END IF;
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
  JOIN memberships corner_member ON corner_member.room_id=corner.id
    AND corner_member.identity_id=NEW.id AND corner_member.removed_at IS NULL
  WHERE corner.parent_id IS NOT NULL;
  RETURN NULL;
END
$corner_owed$;
DROP TRIGGER IF EXISTS corner_owed_handle_update ON identities;
CREATE TRIGGER corner_owed_handle_update AFTER UPDATE OF handle,kind ON identities
  FOR EACH ROW WHEN ((OLD.handle,OLD.kind) IS DISTINCT FROM (NEW.handle,NEW.kind))
  EXECUTE FUNCTION corner_owed_handle_changed();

-- The commissioner, owner and lane decide whose deliverables and finished
-- states are owed to whom.
CREATE OR REPLACE FUNCTION corner_owed_facts_changed() RETURNS trigger
LANGUAGE plpgsql AS $corner_owed$
BEGIN
  PERFORM corner_owed_refresh(NEW.corner_id, member.identity_id)
  FROM memberships member
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
  AFTER UPDATE OF commissioned_by,owner_agent_id,lane ON corner_facts
  FOR EACH ROW WHEN (
    (OLD.commissioned_by,OLD.owner_agent_id,OLD.lane) IS DISTINCT FROM
    (NEW.commissioned_by,NEW.owner_agent_id,NEW.lane)
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
`;
}

/** Fill `corner_owed` from every corner's messages, once, on the release that adds it. */
export function cornerOwedBackfillSql(): string {
  return `${CORNER_OWED_INSERT}
    ${cornerOwedRowsSql('true', true)}
    ON CONFLICT DO NOTHING`;
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
      COALESCE(bool_or(owed_item.person_id=${viewerExpr}),false) owed_viewer,
      COALESCE(bool_or(owed_item.person_id=${viewerExpr} AND NOT EXISTS (
        SELECT 1 FROM room_read_marks seen
        WHERE seen.room_id=${corner}.id AND seen.identity_id=${viewerExpr}
          AND (seen.message_created_at,seen.message_id)>=(owed_item.created_at,owed_item.message_id)
      )),false) attention
    FROM corner_owed owed_item
    WHERE owed_item.corner_id=${corner}.id
      AND (owed_item.expires_at IS NULL OR owed_item.expires_at>now())
  ) owed ON true`;
}
