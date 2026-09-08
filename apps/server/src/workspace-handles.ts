import type { SqlDatabase } from './database.js';

export async function lockIdentityHandleWorkspaces(
  database: SqlDatabase,
  identityId: string,
  additionalWorkspaceIds: readonly string[] = [],
): Promise<readonly string[]> {
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `identity-handle:${identityId}`,
  ]);
  const memberships = await database.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM memberships
     WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`,
    [identityId],
  );
  const workspaceIds = [
    ...new Set([...additionalWorkspaceIds, ...memberships.rows.map((row) => row.workspace_id)]),
  ].sort();
  if (workspaceIds.length)
    await database.query(
      `SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [workspaceIds],
    );
  return workspaceIds;
}

export async function workspaceHandleAvailable(
  database: SqlDatabase,
  identityId: string,
  handle: string | null | undefined,
  workspaceIds: readonly string[],
): Promise<boolean> {
  if (!handle || !workspaceIds.length) return true;
  const conflict = await database.query(
    `SELECT 1
     FROM memberships membership
     JOIN identities identity ON identity.id=membership.identity_id
     WHERE membership.workspace_id=ANY($1::uuid[]) AND membership.room_id IS NULL
       AND membership.removed_at IS NULL AND identity.hidden_from_roster=false
       AND identity.id<>$2 AND lower(identity.handle)=lower($3)
     LIMIT 1`,
    [workspaceIds, identityId, handle],
  );
  return conflict.rowCount === 0;
}
