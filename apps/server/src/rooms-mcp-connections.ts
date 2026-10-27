import { randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { tokenHash } from './auth.js';
import { ensureMcpMember, retireMcpMember } from './rooms-mcp-members.js';

interface Grant { client_id: string; identity_id: string; scope: string }
const opaque = () => randomBytes(32).toString('base64url');

/** The caller holds the connection lock before issuing or rotating a family. */
export async function issueMcpTokens(db: SqlDatabase, grant: Grant, familyId: string) {
  const access = opaque(), refresh = opaque();
  await db.query(`INSERT INTO rooms_mcp_tokens(hash,identity_id,client_id,scope,family_id,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`,
    [tokenHash(access), grant.identity_id, grant.client_id, grant.scope, familyId]);
  await db.query('INSERT INTO rooms_mcp_refresh(hash,family_id) VALUES($1,$2)', [tokenHash(refresh), familyId]);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: grant.scope };
}

export async function connectMcp(db: SqlDatabase, grant: Grant) {
  const client = (
    await db.query<{ name: string }>('SELECT name FROM rooms_mcp_clients WHERE id=$1', [
      grant.client_id,
    ])
  ).rows[0];
  // The connection acts through a member owned by the approving person; the
  // registered client name is its model label and its initial display name.
  await ensureMcpMember(db, {
    clientId: grant.client_id,
    ownerId: grant.identity_id,
    modelLabel: client?.name ?? 'Connected app',
  });
  await db.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope) VALUES($1,$2,$3)
    ON CONFLICT(client_id,identity_id) DO UPDATE SET scope=EXCLUDED.scope,revoked_at=NULL,
    connected_at=CASE WHEN rooms_mcp_connections.revoked_at IS NULL THEN rooms_mcp_connections.connected_at ELSE now() END`,
    [grant.client_id, grant.identity_id, grant.scope]);
  const familyId = opaque();
  await db.query('INSERT INTO rooms_mcp_families(id,client_id,identity_id,scope) VALUES($1,$2,$3,$4)',
    [familyId, grant.client_id, grant.identity_id, grant.scope]);
  return issueMcpTokens(db, grant, familyId);
}

export async function refreshMcp(db: SqlDatabase, raw: string, clientId: string, scope?: string) {
  return db.transaction(async tx => {
    // All refreshes and disconnects serialize on the connection, before the family.
    const connection = (await tx.query(`SELECT c.client_id FROM rooms_mcp_connections c
      WHERE c.client_id=$2 AND c.revoked_at IS NULL AND c.identity_id=(
        SELECT f.identity_id FROM rooms_mcp_refresh r JOIN rooms_mcp_families f ON f.id=r.family_id WHERE r.hash=$1 AND f.client_id=$2
      ) FOR UPDATE`, [tokenHash(raw), clientId])).rows[0];
    if (!connection) return undefined;
    const row = (await tx.query<Grant & { id: string; revoked_at: string | null; consumed_at: string | null }>(`
      SELECT f.*,r.consumed_at FROM rooms_mcp_refresh r
      JOIN rooms_mcp_families f ON f.id=r.family_id
      JOIN rooms_mcp_connections c ON c.client_id=f.client_id AND c.identity_id=f.identity_id
      WHERE r.hash=$1 AND f.client_id=$2 AND c.revoked_at IS NULL FOR UPDATE OF f,r`,
      [tokenHash(raw), clientId])).rows[0];
    if (!row || row.revoked_at) return undefined;
    if (row.consumed_at) {
      // Commit the revocation before returning invalid_grant; throwing here would undo it.
      await tx.query('UPDATE rooms_mcp_families SET revoked_at=now() WHERE id=$1', [row.id]);
      return undefined;
    }
    if (scope !== undefined && scope.split(' ').some(s => !row.scope.split(' ').includes(s))) return undefined;
    await tx.query('UPDATE rooms_mcp_refresh SET consumed_at=now() WHERE hash=$1', [tokenHash(raw)]);
    return issueMcpTokens(tx, { ...row, scope: scope ?? row.scope }, row.id);
  });
}

export async function disconnectMcp(db: SqlDatabase, identityId: string, clientId: string): Promise<void> {
  await retireMcpMember(db, clientId, identityId);
  await db.transaction(async tx => {
    await tx.query('UPDATE rooms_mcp_connections SET revoked_at=now() WHERE identity_id=$1 AND client_id=$2', [identityId, clientId]);
    await tx.query('UPDATE rooms_mcp_families SET revoked_at=now() WHERE identity_id=$1 AND client_id=$2', [identityId, clientId]);
    await tx.query('UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE identity_id=$1 AND client_id=$2', [identityId, clientId]);
    await tx.query('DELETE FROM rooms_mcp_codes WHERE identity_id=$1 AND client_id=$2', [identityId, clientId]);
    await tx.query('DELETE FROM rooms_mcp_flows WHERE identity_id=$1 AND client_id=$2', [identityId, clientId]);
  });
}
