import { cornerReviewerSql } from './corner-reviewer.js';
import { SUBSCRIBABLE_EVENT_KINDS } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

/** Sparse preferences only. Access always comes from the current parent membership. */
export const CORNER_PERSON_STATE_SCHEMA = `
DROP TRIGGER IF EXISTS sync_legacy_corner_state ON memberships;
CREATE TABLE IF NOT EXISTS corner_person_state (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  identity_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  event_subscriptions jsonb,
  identity_profile jsonb,
  push_muted boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(corner_id,identity_id)
);
DROP TRIGGER IF EXISTS sync_current_corner_state ON corner_person_state;
DROP FUNCTION IF EXISTS sync_legacy_corner_state();
DROP FUNCTION IF EXISTS sync_current_corner_state();
ALTER TABLE corner_person_state ADD COLUMN IF NOT EXISTS push_muted boolean NOT NULL DEFAULT false;
ALTER TABLE corner_person_state ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS corner_person_state_identity_idx ON corner_person_state(identity_id);

-- This view is read-only. Corner access projections have no stored roster row and cannot
-- authorize themselves: even a saved preference needs a live parent member.
CREATE OR REPLACE VIEW room_access AS
SELECT member.id,member.workspace_id,member.room_id,member.identity_id,member.role,
  member.generation,member.identity_profile,member.invited_by,member.joined_at,
  member.removed_at,member.push_muted,member.event_subscriptions
FROM memberships member
WHERE member.room_id IS NULL OR EXISTS (
  SELECT 1 FROM rooms room WHERE room.id=member.room_id AND room.parent_id IS NULL
)
UNION ALL
SELECT NULL::bigint id,corner.workspace_id,corner.id room_id,parent.identity_id,
  parent.role,COALESCE(state.generation,1) generation,state.identity_profile,
  parent.invited_by,COALESCE(state.created_at,parent.joined_at) joined_at,parent.removed_at,COALESCE(state.push_muted,false) push_muted,
  COALESCE(state.event_subscriptions,(SELECT COALESCE(jsonb_agg(kind),'[]'::jsonb)
    FROM jsonb_array_elements_text(parent.event_subscriptions) kind
    WHERE kind=ANY(ARRAY[${SUBSCRIBABLE_EVENT_KINDS.map((kind) => "'" + kind + "'").join(',')}]::text[]))) event_subscriptions
FROM rooms corner
JOIN memberships parent ON parent.room_id=corner.parent_id AND parent.removed_at IS NULL
LEFT JOIN corner_person_state state ON state.corner_id=corner.id AND state.identity_id=parent.identity_id
WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL;

-- Read-only alias for the preceding image during the rolling deployment.
CREATE OR REPLACE VIEW effective_memberships AS SELECT * FROM room_access;

`;

/** Preserve sparse preferences before the release removes legacy corner roster rows. */
export async function migrateCornerPersonState(database: SqlDatabase): Promise<number> {
  let total = 0;
  let after = '0';
  while (true) {
    const batch = await database.transaction(async (db) => {
      const batch = await db.query<{ id: string }>(
        `SELECT member.id FROM memberships member JOIN rooms corner ON corner.id=member.room_id
         WHERE corner.parent_id IS NOT NULL AND member.id>$1::bigint
         ORDER BY member.id LIMIT 250 FOR UPDATE OF member`, [after],
      );
      if (!batch.rowCount) return undefined;
      const ids = batch.rows.map((row) => row.id);
      const copied = await db.query(
        `WITH legacy AS (
           SELECT member.*,
             (SELECT COALESCE(jsonb_agg(kind),'[]'::jsonb)
              FROM jsonb_array_elements_text(member.event_subscriptions) kind WHERE kind=ANY($2::text[])) subscriptions,
             (SELECT COALESCE(jsonb_agg(kind),'[]'::jsonb)
              FROM jsonb_array_elements_text(COALESCE(parent.event_subscriptions,'[]'::jsonb)) kind
              WHERE kind=ANY($2::text[])) inherited_subscriptions
           FROM memberships member JOIN rooms corner ON corner.id=member.room_id
           LEFT JOIN memberships parent ON parent.room_id=corner.parent_id AND parent.identity_id=member.identity_id
           WHERE member.id=ANY($1::bigint[])
         ) INSERT INTO corner_person_state(corner_id,identity_id,event_subscriptions,identity_profile,generation,created_at,push_muted)
         SELECT room_id,identity_id,CASE WHEN subscriptions<>inherited_subscriptions THEN subscriptions END,
           identity_profile,generation,joined_at,push_muted FROM legacy
         WHERE subscriptions<>inherited_subscriptions OR identity_profile IS NOT NULL OR generation<>1 OR push_muted
         ON CONFLICT(corner_id,identity_id) DO NOTHING RETURNING corner_id`,
        [ids, SUBSCRIBABLE_EVENT_KINDS],
      );
      return { after: String(ids[ids.length - 1]), copied: copied.rowCount };
    });
    if (!batch) break;
    after = batch.after;
    total += batch.copied;
  }
  return total;
}

/** Save an explicit preference on the appropriate surface, without creating membership. */
export async function setRoomEventSubscriptions(
  database: SqlDatabase,
  roomId: string,
  identityId: string,
  kinds: readonly string[],
): Promise<string[]> {
  const result = await database.query<{ event_subscriptions: string[] }>(
    `WITH surface AS (
      SELECT room.id,room.parent_id,CASE WHEN ${cornerReviewerSql('room')}=$2
        AND NOT $3::jsonb @> '["check-passed"]'::jsonb
        THEN $3::jsonb||'["check-passed"]'::jsonb ELSE $3::jsonb END event_subscriptions
      FROM rooms room JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
      JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
        AND member.identity_id=$2 AND member.removed_at IS NULL WHERE room.id=$1
    ), room_update AS (
      UPDATE memberships member SET event_subscriptions=surface.event_subscriptions FROM surface
      WHERE surface.parent_id IS NULL AND member.room_id=surface.id AND member.identity_id=$2
      RETURNING member.event_subscriptions
    ), corner_update AS (
      INSERT INTO corner_person_state(corner_id,identity_id,event_subscriptions)
      SELECT id,$2,event_subscriptions FROM surface WHERE parent_id IS NOT NULL
      ON CONFLICT(corner_id,identity_id) DO UPDATE SET event_subscriptions=EXCLUDED.event_subscriptions
      RETURNING event_subscriptions
    ) SELECT * FROM room_update UNION ALL SELECT * FROM corner_update`,
    [roomId, identityId, JSON.stringify(kinds)],
  );
  if (!result.rowCount) throw new Error('daemon room access denied');
  return result.rows[0]!.event_subscriptions;
}
