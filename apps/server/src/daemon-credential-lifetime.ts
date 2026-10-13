import type { SqlDatabase } from './database.js';

/** Take before exchange-row or membership locks; held until the caller commits. */
export async function lockDaemonCredentialLifetime(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
) {
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `daemon-credential-lifetime:${agentId}`,
  ]);
}

/** Shared retirement/rollback/deletion primitive, inside the caller's transaction. */
export async function revokeDaemonCredentials(database: SqlDatabase, agentId: string) {
  await lockDaemonCredentialLifetime(database, agentId);
  await database.query(
    `DELETE FROM daemon_token_exchanges WHERE agent_id=$1 AND consumed_at IS NULL`,
    [agentId],
  );
  await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [agentId]);
}
