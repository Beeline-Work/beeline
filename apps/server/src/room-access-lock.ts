import type { SqlDatabase } from './database.js';

/** Hold the actual access rows through a synchronous transport enqueue. Parent
 * membership owns corner access; every mutation conflicts on these same rows.
 * The caller's transaction must never await a provider response. */
export async function lockRoomAccess(database: SqlDatabase, roomIds: readonly string[], identityIds: readonly string[]): Promise<boolean> {
  const rooms = [...new Set(roomIds)], identities = [...new Set(identityIds)];
  if (!rooms.length || !identities.length) return true;
  const current = await database.query(`SELECT surface.id,member.identity_id FROM rooms surface
    JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
    JOIN memberships member ON member.room_id=parent.id AND member.identity_id=ANY($2::text[])
      AND member.removed_at IS NULL
    JOIN memberships workspace ON workspace.workspace_id=surface.workspace_id
      AND workspace.room_id IS NULL AND workspace.identity_id=member.identity_id AND workspace.removed_at IS NULL
    WHERE surface.id=ANY($1::uuid[]) AND surface.archived_at IS NULL AND parent.archived_at IS NULL
    ORDER BY surface.id,member.identity_id
    FOR SHARE OF surface,parent,member,workspace`, [rooms, identities]);
  return current.rowCount === rooms.length * identities.length;
}
