import { FIRST_ROOM_ABOUT, FIRST_ROOM_NAME } from '@beeline/api-contract/phone';
import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { joinWorkspaceMembersToPublicRoom } from './membership-join.js';

/**
 * The public `#general` Room a new Workspace starts with, so its creator
 * lands somewhere with a live composer instead of an empty deck. Idempotent
 * per Workspace: a retried create finds the Room it already made (a live
 * top-level `general`) and returns it rather than writing a second one.
 *
 * Runs inside the caller's transaction, after the creator's owner row exists:
 * the creator joins with their Workspace role, and every other active
 * Workspace member is projected in exactly as for any public Room.
 */
export async function ensureFirstRoom(
  database: SqlDatabase,
  workspaceId: string,
  creatorId: string,
): Promise<string> {
  await database.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
  const existing = await database.query<{ id: string }>(
    `SELECT id FROM rooms
     WHERE workspace_id=$1 AND lower(name)=$2 AND parent_id IS NULL
       AND direct_participants IS NULL AND archived_at IS NULL
     ORDER BY created_at,id LIMIT 1`,
    [workspaceId, FIRST_ROOM_NAME],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,about,visibility,repository_resolution)
     VALUES($1,$2,$3,$4,$5,'public','none')`,
    [id, workspaceId, creatorId, FIRST_ROOM_NAME, FIRST_ROOM_ABOUT],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT $1,$2,$3,role FROM memberships
     WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$3 AND removed_at IS NULL`,
    [workspaceId, id, creatorId],
  );
  await joinWorkspaceMembersToPublicRoom(database, workspaceId, id);
  return id;
}

/**
 * The Room a person should open on arriving in a Workspace: the oldest live
 * top-level Room they are an active member of. Null when they can open none.
 */
export async function firstAccessibleRoomId(
  database: SqlDatabase,
  workspaceId: string,
  identityId: string,
): Promise<string | null> {
  const result = await database.query<{ id: string }>(
    `SELECT r.id FROM rooms r
     JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
     WHERE r.workspace_id=$1 AND r.parent_id IS NULL AND r.direct_participants IS NULL
       AND r.archived_at IS NULL
     ORDER BY r.created_at,r.id LIMIT 1`,
    [workspaceId, identityId],
  );
  return result.rows[0]?.id ?? null;
}
