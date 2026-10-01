import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';
import {
  CORNER_CHECKS_BLOCKED_CARD_TYPE,
  CORNER_REVIEW_DEADLOCK_CARD_TYPE,
} from './agent-command.js';
import { tagsKnownIdentitySql } from './message-mentions.js';
import { grantDecidedBySql } from './needs-you.js';

/** A tag, a reply, or a deliverable stops keeping its corner waiting this long after it was posted. */
const CORNER_OWED_EXPIRY_HOURS = 24;
/** How many of a corner's newest candidate messages are read for owed items. */
const CORNER_OWED_CANDIDATES = 20;

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
 * A LATERAL subquery over one corner (`corner`, a `rooms` row) and one viewer
 * (`viewerExpr`), yielding:
 *
 * - `owed`: something in the corner is still owed to a human member;
 * - `owed_viewer`: something is owed to the viewer;
 * - `attention`: something owed to the viewer is newer than their read mark
 *   in the corner, so they have not opened it since.
 *
 * An item is owed while it is open:
 * - a question card until it is answered or closed, and a grant request
 *   until it is decided; neither expires;
 * - a checks-blocked or review-handback line until that person posts in
 *   the corner after it; it never expires;
 * - a tag, reply or deliverable until that person posts in the corner after
 *   it, or `CORNER_OWED_EXPIRY_HOURS` pass.
 */
export function cornerOwedLateralSql(corner: string, viewerExpr: string): string {
  return `LEFT JOIN LATERAL (
    SELECT COALESCE(bool_or(true),false) owed,
      COALESCE(bool_or(person.id=${viewerExpr}),false) owed_viewer,
      COALESCE(bool_or(person.id=${viewerExpr} AND NOT EXISTS (
        SELECT 1 FROM room_read_marks seen
        WHERE seen.room_id=${corner}.id AND seen.identity_id=${viewerExpr}
          AND (seen.message_created_at,seen.message_id)>=(item.created_at,item.id)
      )),false) attention
    FROM (
      SELECT * FROM messages candidate
      WHERE candidate.room_id=${corner}.id AND candidate.deleted_at IS NULL
        AND (candidate.created_at>now()-interval '${CORNER_OWED_EXPIRY_HOURS} hours'
          OR candidate.card_type IN ('${CHOICE_CARD_TYPE}','grant-request',
            '${CORNER_CHECKS_BLOCKED_CARD_TYPE}','${CORNER_REVIEW_DEADLOCK_CARD_TYPE}'))
      ORDER BY candidate.created_at DESC,candidate.id DESC
      LIMIT ${CORNER_OWED_CANDIDATES}
    ) item
    JOIN memberships person_member ON person_member.room_id=item.room_id
      AND person_member.removed_at IS NULL
      AND person_member.identity_id IS DISTINCT FROM item.author_id
    JOIN identities person ON person.id=person_member.identity_id AND person.kind='human'
    WHERE CASE
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
        AND (item.card_type IN ('${CORNER_CHECKS_BLOCKED_CARD_TYPE}',
            '${CORNER_REVIEW_DEADLOCK_CARD_TYPE}')
          OR item.created_at>now()-interval '${CORNER_OWED_EXPIRY_HOURS} hours')
        AND NOT EXISTS (
          SELECT 1 FROM messages answer
          WHERE answer.room_id=item.room_id AND answer.author_id=person.id
            AND answer.presentation='message' AND answer.deleted_at IS NULL
            AND answer.created_at>item.created_at
        )
    END
  ) owed ON true`;
}
