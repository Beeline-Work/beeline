import { uniqueAgentHandle } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

export async function lockIdentityHandleWorkspaces(
  database: SqlDatabase,
  identityId: string,
  additionalWorkspaceIds: readonly string[] = [],
): Promise<readonly string[]> {
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    'workspace-handle-allocation',
  ]);
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

export async function reassignCollidingAgentHandles(
  database: SqlDatabase,
  humanId: string,
  handle: string | null | undefined,
  workspaceIds: readonly string[],
): Promise<void> {
  if (!handle || !workspaceIds.length) return;
  const conflicts = await database.query<{ id: string; name: string }>(
    `SELECT DISTINCT identity.id,identity.name
     FROM memberships membership
     JOIN identities identity ON identity.id=membership.identity_id
     WHERE membership.workspace_id=ANY($1::uuid[]) AND membership.room_id IS NULL
       AND membership.removed_at IS NULL AND identity.hidden_from_roster=false
       AND identity.id<>$2 AND identity.kind='agent'
       AND lower(identity.handle)=lower($3)
     ORDER BY identity.id`,
    [workspaceIds, humanId, handle],
  );
  for (const agent of conflicts.rows) {
    const agentWorkspaceIds = await lockIdentityHandleWorkspaces(database, agent.id);
    const taken = await database.query<{ handle: string }>(
      `SELECT identity.handle
       FROM memberships membership
       JOIN identities identity ON identity.id=membership.identity_id
       WHERE membership.workspace_id=ANY($1::uuid[]) AND membership.room_id IS NULL
         AND membership.removed_at IS NULL AND identity.hidden_from_roster=false
         AND identity.id<>$2 AND identity.handle IS NOT NULL`,
      [agentWorkspaceIds, agent.id],
    );
    const replacement = uniqueAgentHandle(agent.name, [handle, ...taken.rows.map((row) => row.handle)]);
    await database.query(`UPDATE identities SET handle=$2,updated_at=now() WHERE id=$1`, [
      agent.id,
      replacement,
    ]);
  }
}
