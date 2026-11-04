import { randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { tokenHash } from './auth.js';
import { ensureMcpMember, retireMcpMember } from './rooms-mcp-members.js';

// Known callbacks, loopback, private-use schemes and this server's handoff hold
// full rights. An unknown https client also gets rooms:limited: it can read and
// post, and cannot order agents or merge. Existing tokens omit that marker.
export const MCP_SCOPES = ['rooms:read', 'rooms:write'];
export const MCP_FULL_SCOPE = MCP_SCOPES.join(' ');
export const MCP_LIMITED_SCOPE = 'rooms:limited';
export const MCP_UNVERIFIED_SCOPE = `${MCP_FULL_SCOPE} ${MCP_LIMITED_SCOPE}`;
export function mcpScopeLimited(scope: string): boolean {
  return scope.split(' ').includes(MCP_LIMITED_SCOPE);
}
export function mcpRefreshedScope(scope: string): string {
  return mcpScopeLimited(scope) ? MCP_UNVERIFIED_SCOPE : MCP_FULL_SCOPE;
}

interface Grant { client_id: string; identity_id: string; scope: string; redirect_uri?: string }
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
    redirectUri: grant.redirect_uri,
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
    // Older read-only families widen to full rights; a narrower requested scope never narrows them.
    // rooms:limited stays on unknown https clients and is not a scope they can request.
    if (scope !== undefined && scope.split(' ').some(s => !MCP_SCOPES.includes(s))) return undefined;
    const nextScope = mcpRefreshedScope(row.scope);
    await tx.query('UPDATE rooms_mcp_refresh SET consumed_at=now() WHERE hash=$1', [tokenHash(raw)]);
    await tx.query('UPDATE rooms_mcp_families SET scope=$2 WHERE id=$1', [row.id, nextScope]);
    return issueMcpTokens(tx, { ...row, scope: nextScope }, row.id);
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
