import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { notifyConnectorAssignment } from './postgres-live.js';
import { completeGoogleAccountOffers, resetGoogleAccountOffers, type CompletedConnectorOffer } from './connector-offer-completion.js';
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

  private authorizationUrl(state: string, scopes: readonly string[]): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri,
      response_type: 'code', scope: ['openid', 'email', ...scopes].join(' '),
      access_type: 'offline', prompt: 'consent', state,
    }).toString();
    return url.toString();
  }

  /** Human Google consent starts without a connector or a helper machine. */
  async beginAccount(ownerId: string, connectorType: keyof typeof GOOGLE_TOOL_SCOPES): Promise<string> {
    if (!(connectorType in GOOGLE_TOOL_SCOPES)) throw new Error('unknown Google tool');
    const state = randomUUID() + randomUUID();
    const row = await this.database.query<{ state: string; requested_scopes: string[] }>(
      `INSERT INTO google_oauth_accounts(owner_identity_id,state,expires_at,requested_scopes)
       VALUES ($1,$2,now()+interval '10 minutes',$3::text[])
       ON CONFLICT (owner_identity_id) DO UPDATE
       SET state=CASE WHEN google_oauth_accounts.claimed_at IS NOT NULL
                        AND google_oauth_accounts.expires_at>now()
                        THEN google_oauth_accounts.state ELSE EXCLUDED.state END,
           expires_at=CASE WHEN google_oauth_accounts.claimed_at IS NOT NULL
                             AND google_oauth_accounts.expires_at>now()
                             THEN google_oauth_accounts.expires_at ELSE EXCLUDED.expires_at END,
           requested_scopes=CASE WHEN google_oauth_accounts.claimed_at IS NOT NULL
                              AND google_oauth_accounts.expires_at>now()
                              THEN google_oauth_accounts.requested_scopes ELSE
                                (SELECT ARRAY(SELECT DISTINCT scope FROM unnest(
                                  google_oauth_accounts.granted_scopes || EXCLUDED.requested_scopes
                                ) scope ORDER BY scope)) END,
           claimed_at=CASE WHEN google_oauth_accounts.claimed_at IS NOT NULL
                             AND google_oauth_accounts.expires_at>now()
                             THEN google_oauth_accounts.claimed_at ELSE NULL END,
           updated_at=now()
       RETURNING state,requested_scopes`,
      [ownerId, state, GOOGLE_TOOL_SCOPES[connectorType]],
    );
    return this.authorizationUrl(row.rows[0]!.state, row.rows[0]!.requested_scopes);
  }

  async accountStatus(ownerId: string): Promise<{ connected: boolean; connectedTypes: string[]; authorizationUrl?: string }> {
    const row = await this.database.transaction(async (database) => {
      const expired = await database.query(
        `SELECT 1 FROM google_oauth_accounts WHERE owner_identity_id=$1 AND state IS NOT NULL
         AND expires_at<=now() FOR UPDATE`, [ownerId]);
      const account = await database.query<{ state: string | null; sealed_grant: string | null;
        requested_scopes: string[] }>(
      `UPDATE google_oauth_accounts
       SET state=CASE WHEN expires_at<=now() THEN NULL ELSE state END,
           expires_at=CASE WHEN expires_at<=now() THEN NULL ELSE expires_at END,
           claimed_at=CASE WHEN expires_at<=now() THEN NULL ELSE claimed_at END,
           updated_at=CASE WHEN expires_at<=now() THEN now() ELSE updated_at END
       WHERE owner_identity_id=$1 RETURNING state,sealed_grant,requested_scopes`, [ownerId]);
      if (expired.rowCount) await resetGoogleAccountOffers(database, ownerId);
      return account.rows[0];
    });
    const scopes = row?.sealed_grant ? this.open(row.sealed_grant).scopes : [];
    return {
      connected: Boolean(row?.sealed_grant),
      connectedTypes: Object.entries(GOOGLE_TOOL_SCOPES)
        .filter(([, required]) => required.every(scope => scopes.includes(scope)))
        .map(([kind]) => kind),
      ...(row?.state ? { authorizationUrl: this.authorizationUrl(row.state, row.requested_scopes) } : {}),
    };
  }

  async cancelAccount(ownerId: string, state?: string): Promise<boolean> {
    return this.database.transaction(async (database) => {
    const row = await database.query(
      `UPDATE google_oauth_accounts SET state=NULL,expires_at=NULL,updated_at=now()
       WHERE owner_identity_id=$1 AND state IS NOT NULL AND claimed_at IS NULL
         AND ($2::text IS NULL OR state=$2)
       RETURNING owner_identity_id`, [ownerId, state ?? null]);
    if (row.rowCount) await resetGoogleAccountOffers(database, ownerId);
    return row.rowCount > 0;
    });
  }

  async disconnectAccount(ownerId: string): Promise<void> {
    await this.database.transaction(async (database) => {
      await database.query(`UPDATE google_oauth_accounts SET sealed_grant=NULL,granted_scopes='{}',state=NULL,
        expires_at=NULL,claimed_at=NULL,updated_at=now() WHERE owner_identity_id=$1`, [ownerId]);
      await resetGoogleAccountOffers(database, ownerId);
    });
  }

  async cancelAccountState(state: string): Promise<boolean | null> {
    return this.database.transaction(async (database) => {
    const row = await database.query<{ owner_identity_id: string }>(
      `UPDATE google_oauth_accounts SET state=NULL,expires_at=NULL,updated_at=now()
       WHERE state=$1 AND claimed_at IS NULL RETURNING owner_identity_id`, [state]);
    if (row.rows[0]) await resetGoogleAccountOffers(database, row.rows[0].owner_identity_id);
    return row.rowCount ? true : null;
    });
  }

  /** null means this state belongs to the legacy connector callback path. */
  async completeAccount(state: string, code: string): Promise<
    { completed: boolean; offers: CompletedConnectorOffer[] } | null
  > {
    const claimed = await this.database.query<{ owner_identity_id: string; requested_scopes: string[] }>(
      `UPDATE google_oauth_accounts SET claimed_at=now()
       WHERE state=$1 AND expires_at>now() AND claimed_at IS NULL
       RETURNING owner_identity_id,requested_scopes`, [state]);
    const ownerId = claimed.rows[0]?.owner_identity_id;
    if (!ownerId) return null;
    try {
      const response = await this.transport('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: this.clientId,
          client_secret: this.clientSecret, redirect_uri: this.redirectUri,
          grant_type: 'authorization_code' }),
      });
      if (!response.ok) throw new Error('Google refused the authorization code');
      const token = await response.json() as TokenResponse;
      if (!token.access_token || !token.refresh_token) throw new Error('Google returned no renewable grant');
      const grantedScopes = (token.scope ?? '').split(' ').filter(Boolean);
      if (!claimed.rows[0]!.requested_scopes.every(scope => grantedScopes.includes(scope)))
        throw new Error('Google did not grant the selected tool scopes');
      const profile = await this.transport('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const user = profile.ok ? await profile.json() as { email?: string } : {};
      const grant: GoogleGrant = {
        accessToken: token.access_token, refreshToken: token.refresh_token,
        expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
        scopes: grantedScopes,
        ...(user.email ? { accountEmail: user.email } : {}),
      };
      const offers = await this.database.transaction(async (database) => {
        const stored = await database.query(
          `UPDATE google_oauth_accounts SET sealed_grant=$3,granted_scopes=$4::text[],state=NULL,expires_at=NULL,
             claimed_at=NULL,updated_at=now()
           WHERE owner_identity_id=$1 AND state=$2`, [ownerId, state, this.seal(grant), grant.scopes]);
        if (!stored.rowCount) throw new Error('Google attempt was superseded');
        const completed = await completeGoogleAccountOffers(database, ownerId, grant.scopes);
        await resetGoogleAccountOffers(database, ownerId);
        return completed;
      });
      return { completed: true, offers };
    } catch {
      await this.database.transaction(async (database) => {
      const retired = await database.query(
        `UPDATE google_oauth_accounts SET state=NULL,expires_at=NULL,claimed_at=NULL,
           updated_at=now() WHERE owner_identity_id=$1 AND state=$2`, [ownerId, state]);
      if (retired.rowCount) await resetGoogleAccountOffers(database, ownerId);
      });
      return { completed: false, offers: [] };
    }
  }

  async grantForOwner(ownerId: string): Promise<Omit<GoogleGrant, 'refreshToken'> | null> {
    const row = await this.database.query<{ sealed_grant: string }>(
      `SELECT sealed_grant FROM google_oauth_accounts
       WHERE owner_identity_id=$1 AND sealed_grant IS NOT NULL`, [ownerId]);
    if (!row.rows[0]) return null;
    const previousSealedGrant = row.rows[0].sealed_grant;
    let grant = this.open(previousSealedGrant);
    if (grant.expiresAt <= Date.now() + 60_000) {
      const response = await this.transport('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId,client_secret: this.clientSecret,
          refresh_token: grant.refreshToken,grant_type: 'refresh_token' }),
      });
      if (!response.ok) return null;
      const token = await response.json() as TokenResponse;
      if (!token.access_token) return null;
      grant = { ...grant, accessToken: token.access_token,
        expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 };
      const updated = await this.database.query(
        `UPDATE google_oauth_accounts SET sealed_grant=$2,updated_at=now()
         WHERE owner_identity_id=$1 AND sealed_grant=$3 RETURNING owner_identity_id`,
        [ownerId, this.seal(grant), previousSealedGrant]);
      if (!updated.rowCount) return null;
    }
    const { refreshToken: _serverOnly, ...access } = grant;
    return access;
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

  /** An abandoned browser never calls back. Retire only expired attempts owned
   * by this Workbench viewer so the next read offers Connect again. */
  async expirePending(ownerId: string): Promise<void> {
    await this.database.query(
      `WITH expired AS (
         DELETE FROM google_oauth_attempts a
         USING workspace_connectors c
         WHERE a.connector_id=c.id AND c.owner_identity_id=$1
           AND c.connector_type LIKE 'google-%' AND a.expires_at<=now()
         RETURNING a.connector_id
       )
       UPDATE workspace_connectors c
       SET status='disconnected',status_error=NULL,status_steps='[]'::jsonb,
           sign_in=NULL,updated_at=now()
       FROM expired WHERE c.id=expired.connector_id AND c.status='installing'`,
      [ownerId],
    );
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
    return this.database.transaction(async (database) => {
      const claimed = await database.query<{ connector_id: string }>(
        `DELETE FROM google_oauth_attempts WHERE state=$1 AND expires_at>now()
         RETURNING connector_id`, [state]);
      const connectorId = claimed.rows[0]?.connector_id;
      if (!connectorId) return false;
      await this.fail(connectorId, 'Google authorization was denied', database);
      return true;
    });
  }

  /** A person closed their own browser before Google returned. A completed
   * exchange already consumed the attempt, so it is left untouched. */
  async cancelConnector(connectorId: string, ownerId: string): Promise<boolean> {
    return this.database.transaction(async (database) => {
      const claimed = await database.query(
        `DELETE FROM google_oauth_attempts a USING workspace_connectors c
         WHERE a.connector_id=c.id AND c.id::text=$1 AND c.owner_identity_id=$2
           AND c.connector_type LIKE 'google-%' AND c.status='installing'
         RETURNING a.connector_id`,
        [connectorId, ownerId],
      );
      if (!claimed.rowCount) return false;
      await this.fail(connectorId, 'Google sign-in was cancelled; retry the connection', database);
      return true;
    });
  }

  private async fail(connectorId: string, _reason: string,
    database: SqlDatabase = this.database): Promise<void> {
    await database.query(
      `UPDATE workspace_connectors SET status='disconnected',status_error=NULL,
         status_steps='[]'::jsonb,sign_in=NULL,updated_at=now()
       WHERE id=$1 AND status='installing'
         AND NOT EXISTS (SELECT 1 FROM google_oauth_attempts a WHERE a.connector_id=$1::uuid)`,
      [connectorId]);
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
       JOIN agents a ON a.agent_id=c.helper_agent_id AND a.owner_id=c.owner_identity_id
       JOIN google_oauth_grants g ON g.workspace_id=c.workspace_id
        AND g.owner_identity_id=c.owner_identity_id AND g.machine_id=c.machine_id
       WHERE c.id=$1 AND c.helper_agent_id=$2 AND c.connector_type LIKE 'google-%'
         AND c.status IN ('installing','connected')
         AND c.sign_in->>'method' IS DISTINCT FROM 'oauth'`,
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
