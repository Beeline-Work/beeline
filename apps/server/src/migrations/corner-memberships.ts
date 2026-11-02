import { CornerAccessDatabase } from '../corner-access-database.js';
import type { SqlDatabase } from '../database.js';

/** Corners have assignments and sparse preferences, never a stored roster. */
export const CORNER_MEMBERSHIPS_SCHEMA = `
CREATE OR REPLACE FUNCTION guard_corner_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.room_id IS NOT NULL AND EXISTS(SELECT 1 FROM rooms WHERE id=NEW.room_id AND parent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'corner memberships are not supported; use parent Room membership' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_corner_membership ON memberships;
CREATE TRIGGER guard_corner_membership BEFORE INSERT OR UPDATE OF room_id ON memberships
  FOR EACH ROW EXECUTE FUNCTION guard_corner_membership();
`;

/** Run after migrateCornerPersonState: retain preferences, messages, history and assignments. */
export async function removeCornerMemberships(database: SqlDatabase): Promise<number> {
  const physical = CornerAccessDatabase.physical(database);
  let total = 0;
  while (true) {
    const removed = await physical.query(
      `DELETE FROM memberships member WHERE member.id IN (
         SELECT legacy.id FROM memberships legacy JOIN rooms corner ON corner.id=legacy.room_id
         WHERE corner.parent_id IS NOT NULL ORDER BY legacy.id LIMIT 250
       ) RETURNING member.id`,
    );
    total += removed.rowCount;
    if (!removed.rowCount) return total;
  }
}
