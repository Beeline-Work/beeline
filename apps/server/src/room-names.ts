import type { SqlDatabase } from './database.js';

export const ROOM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function requireRoomSlug(value: string): string {
  if (value.length > 48 || !ROOM_SLUG_PATTERN.test(value))
    throw new Error(
      'invalid Room name: use lowercase letters, numbers and single hyphens (up to 48 characters)',
    );
  return value;
}

/**
 * Refuse a name another top-level Room in the Workspace already uses.
 * Existing Rooms are never renamed, so this only guards new names; the
 * Workspace row lock serializes concurrent creates and renames.
 */
export async function reserveRoomName(
  db: SqlDatabase,
  workspaceId: string,
  name: string,
  roomId?: string,
): Promise<void> {
  await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
  const occupied = await db.query(
    `SELECT 1 FROM rooms WHERE workspace_id=$1 AND lower(name)=lower($2)
       AND parent_id IS NULL AND direct_participants IS NULL AND id IS DISTINCT FROM $3::uuid
     LIMIT 1`,
    [workspaceId, name, roomId ?? null],
  );
  if (occupied.rowCount) throw new Error('Room name conflict: already used in this Workspace');
}