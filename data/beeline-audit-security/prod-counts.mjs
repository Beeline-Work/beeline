import { readFile } from 'node:fs/promises';
import pg from 'pg';
const path = process.argv[2];
if (!path) throw new Error('Pass the authorized connection-string file; credentials are never printed');
const client = new pg.Client({ connectionString: (await readFile(path, 'utf8')).trim(), connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  const result = await client.query(`SELECT now() AS observed_at,
    (SELECT count(*) FROM daemon_token_exchanges e JOIN identities i ON i.id=e.agent_id
      WHERE e.consumed_at IS NULL AND e.expires_at>now() AND i.hidden_from_roster) AS pending_retired_exchanges,
    (SELECT count(*) FROM daemon_tokens t JOIN identities i ON i.id=t.agent_id
      WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND i.hidden_from_roster) AS live_tokens_for_hidden_agents,
    (SELECT count(*) FROM permission_authority p JOIN rooms r ON r.id=p.room_id
      WHERE p.status='pending' AND NOT EXISTS(SELECT 1 FROM memberships m
        WHERE m.room_id=p.room_id AND m.identity_id=p.principal_id AND m.removed_at IS NULL)) AS pending_permissions_without_requester_room_membership,
    (SELECT count(*) FROM memberships m JOIN identities i ON i.id=m.identity_id
      WHERE m.room_id IS NOT NULL AND m.removed_at IS NULL AND i.kind='agent'
        AND NOT EXISTS(SELECT 1 FROM memberships w WHERE w.workspace_id=m.workspace_id
          AND w.room_id IS NULL AND w.identity_id=m.identity_id AND w.removed_at IS NULL)) AS active_agent_room_memberships_without_workspace_membership`);
  console.log(JSON.stringify(result.rows[0], null, 2));
  await client.query('ROLLBACK');
} catch {
  // Provider errors can include connection information; emit no raw error.
  console.error('Read-only audit counts unavailable; no credentials printed');
  process.exitCode = 1;
} finally { await client.end(); }
