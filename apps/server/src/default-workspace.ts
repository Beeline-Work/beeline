import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  WELCOME_ROOM_ABOUT,
  WELCOME_ROOM_ID,
  WELCOME_ROOM_NAME,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

/**
 * Seed the shared "Beeline Welcome" Workspace and its `#welcome` Room, then
 * backfill every human identity into both. Idempotent: rerunning changes
 * nothing, a membership someone ended (`removed_at`) is never resurrected,
 * and the Room's `about` is written once so a later edit survives a reboot.
 * The backfill is silent (no join line, no push); a new sign-in still joins
 * through `joinRooms`, which posts the ordinary `<name> joined` line.
 * Workspace owners/admins manage `#welcome` with the same role.
 */
export async function seedDefaultWorkspace(database: SqlDatabase): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,
      [DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME],
    );
    await transaction.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,about)
       SELECT $1,$2,
         (SELECT identity_id FROM memberships
          WHERE workspace_id=$2 AND room_id IS NULL AND role='owner' AND removed_at IS NULL
          ORDER BY joined_at,id LIMIT 1),
         $3,$4
       ON CONFLICT(id) DO NOTHING`,
      [WELCOME_ROOM_ID, DEFAULT_WORKSPACE_ID, WELCOME_ROOM_NAME, WELCOME_ROOM_ABOUT],
    );
    await transaction.query(
      `UPDATE rooms SET created_by=owner.identity_id
       FROM (
         SELECT identity_id FROM memberships
         WHERE workspace_id=$2 AND room_id IS NULL AND role='owner' AND removed_at IS NULL
         ORDER BY joined_at,id LIMIT 1
       ) owner
       WHERE rooms.id=$1 AND rooms.created_by IS NULL`,
      [WELCOME_ROOM_ID, DEFAULT_WORKSPACE_ID],
    );
    await transaction.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,NULL,identity.id,'member' FROM identities identity
       WHERE identity.kind='human'
       ON CONFLICT (workspace_id,identity_id) WHERE room_id IS NULL DO NOTHING`,
      [DEFAULT_WORKSPACE_ID],
    );
    await transaction.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       SELECT $1,$2,member.identity_id,member.role
       FROM memberships member JOIN identities identity ON identity.id=member.identity_id
       WHERE member.workspace_id=$1 AND member.room_id IS NULL AND member.removed_at IS NULL
         AND identity.kind='human'
       ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL
       DO UPDATE SET role=EXCLUDED.role
         WHERE memberships.removed_at IS NULL
           AND memberships.role='member' AND EXCLUDED.role<>'member'`,
      [DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID],
    );
  });
}
