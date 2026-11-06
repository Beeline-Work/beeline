import type { SqlDatabase } from './database.js';

/** Shared retirement/rollback/deletion primitive, inside the caller's transaction. */
export async function revokeDaemonCredentials(database: SqlDatabase, agentId: string) {
  // Deleting an unused exchange orders retirement against its native consume.
  // Keep token revocation in a fresh statement so a waiter sees a token just
  // minted by the exchange transaction that committed ahead of it.
  await database.query(
    `DELETE FROM daemon_token_exchanges WHERE agent_id=$1 AND consumed_at IS NULL`,
    [agentId],
  );
  await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [agentId]);
}
