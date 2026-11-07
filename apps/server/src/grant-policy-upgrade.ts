import {
  HOST_EMULATOR_TARGET,
  commandRuleEscalations,
  parseCommandGrantTarget,
  type CommandGrantScript,
} from '@beeline/api-contract/agent-grants';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity } from './system-line.js';

/**
 * Asks still pending from before an agent could use its own owner's resources
 * without a card. The current server never raises them: owner-machine access
 * is recorded as approved on the spot, and budget and repository asks are
 * retired. Connection installs for the agent's own account are superseded too.
 * Legacy install grants have no app_id: connect only provisioned the helper
 * owner's account. An explicit foreign app_id retains its owner decision.
 * Cancellation uses the existing revoked status and clears card actions. Nothing waits on these rows, yet their cards kept offering
 * No/Once/Always. Each is withdrawn by @system without waking the turn that
 * raised it, so an answer can no longer resume stale work. Asks the current
 * rule still raises — host emulator consent, the wallet, a credential file, an unread script — stay.
 */
export async function withdrawSupersededGrantAsks(database: SqlDatabase): Promise<number> {
  return database.transaction(async (db) => {
    const pending = await db.query<{
      id: string;
      kind: string;
      target: string;
      script: CommandGrantScript | null;
    }>(`SELECT g.id::text,g.kind,g.target,g.script FROM agent_grants g
      JOIN agents agent ON agent.agent_id=g.agent_id
      LEFT JOIN workspace_apps app ON app.id=g.app_id
      WHERE g.status='pending' AND NOT (g.kind='mcp' AND (g.target='wallet' OR
        (g.target LIKE 'connection-install:%' AND g.target NOT LIKE 'connection-install:beeline%'
          AND app.owner_identity_id IS NOT NULL AND app.owner_identity_id<>agent.owner_id)))
      FOR UPDATE OF g`);
    const superseded = pending.rows
      .filter((grant) => {
        if (grant.kind === 'host' && grant.target === HOST_EMULATOR_TARGET) return false;
        if (grant.kind !== 'command') return true;
        try {
          const rule = parseCommandGrantTarget(grant.target);
          return commandRuleEscalations(rule, grant.script ?? undefined).length === 0;
        } catch {
          return false;
        }
      })
      .map((grant) => grant.id);
    if (!superseded.length) return 0;
    await ensureSystemIdentity(db);
    await db.query(
      `UPDATE agent_grants SET status='revoked',decided_by=$2,decided_at=now()
       WHERE id::text=ANY($1::text[]) AND status='pending'`,
      [superseded, SYSTEM_IDENTITY_ID],
    );
    await db.query(
      `UPDATE messages m SET card=jsonb_set(m.card,'{grants}',(
        SELECT jsonb_agg(CASE WHEN e->>'grantId'=ANY($1::text[])
          THEN jsonb_set(e,'{status}','"revoked"'::jsonb) ELSE e END ORDER BY ordinal)
        FROM jsonb_array_elements(m.card->'grants') WITH ORDINALITY entries(e,ordinal)
      )) WHERE m.card_type='grant-request' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(m.card->'grants') e
        WHERE e->>'grantId'=ANY($1::text[])
      )`,
      [superseded],
    );
    return superseded.length;
  });
}
