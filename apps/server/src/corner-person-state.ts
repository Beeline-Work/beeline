import { SUBSCRIBABLE_EVENT_KINDS } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

/** Sparse preferences only. Access always comes from the current parent membership. */
export const CORNER_PERSON_STATE_SCHEMA = `
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
ALTER TABLE corner_person_state ADD COLUMN IF NOT EXISTS push_muted boolean NOT NULL DEFAULT false;
ALTER TABLE corner_person_state ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS corner_person_state_identity_idx ON corner_person_state(identity_id);

-- This view is read-only. Derived rows have no membership id, and cannot
-- authorize themselves: even a saved preference needs a live parent member.
CREATE OR REPLACE VIEW effective_memberships AS
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
  CASE WHEN corner.archived_at IS NOT NULL THEN '[]'::jsonb ELSE COALESCE(state.event_subscriptions,(SELECT COALESCE(jsonb_agg(kind),'[]'::jsonb)
    FROM jsonb_array_elements_text(parent.event_subscriptions) kind
    WHERE kind=ANY(ARRAY[${SUBSCRIBABLE_EVENT_KINDS.map((kind) => "'" + kind + "'").join(',')}]::text[]))) END event_subscriptions
FROM rooms corner
JOIN memberships parent ON parent.room_id=corner.parent_id AND parent.removed_at IS NULL
LEFT JOIN corner_person_state state ON state.corner_id=corner.id AND state.identity_id=parent.identity_id
WHERE corner.parent_id IS NOT NULL;
`;

/** Each batch copies and removes the same locked rows atomically; retries resume safely. */
export async function migrateCornerPersonState(database: SqlDatabase): Promise<number> {
  await database.query(`
    CREATE OR REPLACE FUNCTION forbid_corner_membership() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE parent uuid;
    BEGIN
      SELECT parent_id INTO parent FROM rooms WHERE id=NEW.room_id FOR SHARE;
      IF parent IS NOT NULL THEN
        RAISE EXCEPTION 'corner access is inherited from its parent Room' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS forbid_corner_membership ON memberships;
    CREATE TRIGGER forbid_corner_membership BEFORE INSERT OR UPDATE OF room_id ON memberships
      FOR EACH ROW EXECUTE FUNCTION forbid_corner_membership();
  `);
  await database.query(`
    CREATE OR REPLACE FUNCTION forbid_corner_roster() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.parent_id IS NOT NULL AND EXISTS(SELECT 1 FROM memberships WHERE room_id=NEW.id) THEN
        RAISE EXCEPTION 'a corner cannot have membership rows' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS forbid_corner_roster ON rooms;
    CREATE TRIGGER forbid_corner_roster BEFORE UPDATE OF parent_id ON rooms
      FOR EACH ROW EXECUTE FUNCTION forbid_corner_roster();
  `);
  let total = 0;
  while (true) {
    const count = await database.transaction(async (db) => {
      const batch = await db.query<{ id: string }>(
        `SELECT member.id FROM memberships member JOIN rooms corner ON corner.id=member.room_id
         WHERE corner.parent_id IS NOT NULL ORDER BY member.id LIMIT 250 FOR UPDATE OF member`,
      );
      if (!batch.rowCount) return 0;
      const ids = batch.rows.map((row) => row.id);
      await db.query(
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
         ON CONFLICT(corner_id,identity_id) DO NOTHING`,
        [ids, SUBSCRIBABLE_EVENT_KINDS],
      );
      await db.query('DELETE FROM memberships WHERE id=ANY($1::bigint[])', [ids]);
      return batch.rowCount;
    });
    total += count;
    if (!count) break;
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
      SELECT room.id,room.parent_id,CASE WHEN parent.reviewer_agent_id=$2
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
