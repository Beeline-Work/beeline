import type { SqlDatabase } from '../database.js';

/** Recover personal owner decisions lost to the retired provenance upgrade. */
export async function restoreOwnerApprovedGrants(database: SqlDatabase): Promise<void> {
  await database.query(`UPDATE agent_grants grant_row SET status=revocation.previous_status
    FROM agent_grant_policy_revocations revocation, agents agent
    WHERE revocation.grant_id=grant_row.id AND agent.agent_id=grant_row.agent_id
      AND revocation.reason='missing-requester-provenance'
      AND revocation.previous_status='approved'
      AND grant_row.decided_by=agent.owner_id
      AND grant_row.status='revoked'
      AND grant_row.decided_at<=revocation.revoked_at
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now())`);
}
