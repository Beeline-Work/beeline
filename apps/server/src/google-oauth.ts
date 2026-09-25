import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { notifyConnectorAssignment } from './postgres-live.js';
import { GOOGLE_TOOL_SCOPES } from '@beeline/api-contract/workbench';

const SCOPES = [
  'openid', 'email',
  ...new Set(Object.values(GOOGLE_TOOL_SCOPES).flat()),
];

type GoogleGrant = { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[]; accountEmail?: string };
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };

/** Beeline's server owns consent, state, and encrypted refresh tokens. */
export class GoogleOAuth {
  private readonly key: Buffer;
  private readonly redirectUri: string;

  constructor(
    private readonly database: SqlDatabase,
    private readonly clientId: string,
    private readonly clientSecret: string,
    publicOrigin: string,
    encryptionKey: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.key = Buffer.from(encryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('BEELINE_GOOGLE_TOKEN_KEY must be a base64 32-byte key');
    this.redirectUri = new URL('/v1/google/oauth/callback', publicOrigin).toString();
  }

  async begin(connectorId: string, database: SqlDatabase = this.database): Promise<string> {
    const state = randomUUID() + randomUUID();
    // A retry supersedes the earlier browser page for this connector.
    await database.query(`DELETE FROM google_oauth_attempts WHERE connector_id=$1`, [connectorId]);
    await database.query(
      `INSERT INTO google_oauth_attempts(state,connector_id,expires_at)
       VALUES ($1,$2,now()+interval '10 minutes')`,
      [state, connectorId],
    );
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();
    return url.toString();
  }

  async hasGrant(workspaceId: string, ownerId: string, machineId: string,
    database: SqlDatabase = this.database): Promise<boolean> {
    const row = await database.query(
      `SELECT 1 FROM google_oauth_grants
       WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3`,
      [workspaceId, ownerId, machineId],
    );
    return row.rowCount > 0;
  }

  private seal(grant: GoogleGrant): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(grant)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  private open(value: string): GoogleGrant {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as GoogleGrant;
  }

  async cancel(state: string): Promise<boolean> {
    const claimed = await this.database.query<{ connector_id: string }>(
      `DELETE FROM google_oauth_attempts WHERE state=$1 AND expires_at>now()
       RETURNING connector_id`, [state]);
    const connectorId = claimed.rows[0]?.connector_id;
    if (!connectorId) return false;
    await this.fail(connectorId, 'Google authorization was denied');
    return true;
  }

  private async fail(connectorId: string, reason: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_connectors SET status='error',status_error=$2,
         status_steps=$3::jsonb,sign_in=NULL,updated_at=now()
       WHERE id=$1 AND status='installing'`,
      [connectorId, reason, JSON.stringify([{ label: 'Google sign-in', status: 'failed', reason }])]);
  }

  async complete(state: string, code: string): Promise<boolean> {
    const claimed = await this.database.query<{ connector_id: string }>(
      `DELETE FROM google_oauth_attempts WHERE state=$1 AND expires_at>now()
       RETURNING connector_id`,
      [state],
    );
    const connectorId = claimed.rows[0]?.connector_id;
    if (!connectorId) return false;
    const connector = await this.database.query<{
      workspace_id: string; owner_identity_id: string; machine_id: string; helper_agent_id: string;
    }>(
      `SELECT workspace_id,owner_identity_id,machine_id,helper_agent_id
       FROM workspace_connectors WHERE id=$1 AND status='installing'`,
      [connectorId],
    );
    const row = connector.rows[0];
    if (!row) return false;
    try {
      const response = await this.transport('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: this.clientId, client_secret: this.clientSecret,
          redirect_uri: this.redirectUri, grant_type: 'authorization_code',
        }),
      });
      if (!response.ok) throw new Error('Google refused the authorization code');
      const token = await response.json() as TokenResponse;
      if (!token.access_token || !token.refresh_token) throw new Error('Google returned no renewable grant');
      const granted = new Set((token.scope ?? '').split(' '));
      const userInfo = await this.transport('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const profile = userInfo.ok ? await userInfo.json() as { email?: string } : {};
      const grant: GoogleGrant = {
        accessToken: token.access_token, refreshToken: token.refresh_token,
        expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
        scopes: [...granted],
        ...(profile.email ? { accountEmail: profile.email } : {}),
      };
      await this.database.query(
        `INSERT INTO google_oauth_grants(workspace_id,owner_identity_id,machine_id,sealed_grant)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id,owner_identity_id,machine_id)
         DO UPDATE SET sealed_grant=EXCLUDED.sealed_grant,updated_at=now()`,
        [row.workspace_id, row.owner_identity_id, row.machine_id, this.seal(grant)],
      );
      await this.database.query(
        `UPDATE workspace_connectors SET sign_in=NULL,updated_at=now()
         WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3
           AND connector_type LIKE 'google-%' AND status='installing'`,
        [row.workspace_id, row.owner_identity_id, row.machine_id],
      );
      await notifyConnectorAssignment(this.database, row.helper_agent_id);
      return true;
    } catch {
      await this.fail(connectorId, 'Google authorization failed; retry the connection');
      return false;
    }
  }

  async grantForHelper(connectorId: string, agentId: string): Promise<Omit<GoogleGrant, 'refreshToken'> | null> {
    const result = await this.database.query<{ sealed_grant: string; workspace_id: string;
      owner_identity_id: string; machine_id: string }>(
      `SELECT g.sealed_grant,g.workspace_id,g.owner_identity_id,g.machine_id FROM workspace_connectors c
       JOIN google_oauth_grants g ON g.workspace_id=c.workspace_id
        AND g.owner_identity_id=c.owner_identity_id AND g.machine_id=c.machine_id
       WHERE c.id=$1 AND c.helper_agent_id=$2 AND c.connector_type LIKE 'google-%'
         AND c.status IN ('installing','connected')`,
      [connectorId, agentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    let grant = this.open(row.sealed_grant);
    if (grant.expiresAt <= Date.now() + 60_000) {
      const response = await this.transport('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId, client_secret: this.clientSecret,
          refresh_token: grant.refreshToken, grant_type: 'refresh_token',
        }),
      });
      if (!response.ok) throw new Error('Google refused to refresh the grant; reconnect Google Workspace');
      const token = await response.json() as TokenResponse;
      if (!token.access_token) throw new Error('Google returned no refreshed access token');
      grant = { ...grant, accessToken: token.access_token,
        expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 };
      await this.database.query(
        `UPDATE google_oauth_grants SET sealed_grant=$4,updated_at=now()
         WHERE workspace_id=$1 AND owner_identity_id=$2 AND machine_id=$3`,
        [row.workspace_id,row.owner_identity_id,row.machine_id,this.seal(grant)],
      );
    }
    const { refreshToken: _serverOnly, ...access } = grant;
    return access;
  }
}
