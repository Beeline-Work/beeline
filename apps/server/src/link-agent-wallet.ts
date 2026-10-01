import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';

type Grant = { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };
type Token = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
type SpendRequest = { id: string; status: string; approval_url?: string; card?: {
  number: string; cvc?: string; exp_month: number; exp_year: number;
  billing_address?: { name?: string; postal_code?: string; line1?: string; city?: string;
    state?: string; country?: string }; valid_until?: string;
}; shared_payment_token?: { id: string; valid_until?: string };
  status_details?: { requires_action?: { next_action?: { resolution?: string;
    display_message?: string; action_url?: string } } } };

const SCOPE = 'payment_methods.agentic userinfo:read';
const INELIGIBLE = 'Link agent payments are available only to consumers in the US or Canada.';

/** Hosted Link wallet: secrets and refreshes never leave the server. */
export class LinkAgentWallet {
  private readonly key: Buffer;
  readonly redirectUri: string;

  constructor(private readonly database: SqlDatabase, private readonly clientId: string,
    private readonly clientSecret: string, private readonly publishableKey: string,
    publicOrigin: string, encryptionKey: string, private readonly transport: typeof fetch = fetch) {
    this.key = Buffer.from(encryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('BEELINE_LINK_TOKEN_KEY must be a base64 32-byte key');
    this.redirectUri = new URL('/v1/link/oauth/callback', publicOrigin).toString();
  }

  private seal(grant: Grant): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(grant)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private open(value: string): Grant {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as Grant;
  }

  async begin(ownerId: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.database.query(
      `INSERT INTO link_oauth_accounts(owner_identity_id,state,code_verifier,attempt_expires_at,ineligible)
       VALUES ($1,$2,$3,now()+interval '10 minutes',false)
       ON CONFLICT (owner_identity_id) DO UPDATE SET state=EXCLUDED.state,
         code_verifier=EXCLUDED.code_verifier,attempt_expires_at=EXCLUDED.attempt_expires_at,
         ineligible=false,updated_at=now()`, [ownerId, state, verifier]);
    const url = new URL('https://login.link.com/auth');
    url.search = new URLSearchParams({ key: this.publishableKey, client_id: this.clientId,
      redirect_uri: this.redirectUri, response_type: 'code', scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.toString();
  }

  async status(ownerId: string): Promise<{ connected: boolean; pending: boolean; ineligible: boolean }> {
    const row = (await this.database.query<{ sealed_grant: string | null; pending: boolean;
      ineligible: boolean }>(`SELECT sealed_grant,
         (state IS NOT NULL AND attempt_expires_at>now()) pending,ineligible FROM link_oauth_accounts
       WHERE owner_identity_id=$1`, [ownerId])).rows[0];
    return { connected: Boolean(row?.sealed_grant), pending: Boolean(row?.pending),
      ineligible: Boolean(row?.ineligible) };
  }

  async cancel(ownerId: string, state?: string): Promise<void> {
    await this.database.query(`UPDATE link_oauth_accounts SET state=NULL,code_verifier=NULL,
      attempt_expires_at=NULL,updated_at=now() WHERE owner_identity_id=$1
      AND ($2::text IS NULL OR state=$2)`, [ownerId, state ?? null]);
  }

  async complete(state: string, code?: string, error?: string, description?: string): Promise<{
    completed: boolean; ownerId?: string }> {
    // Claim once before exchanging the one-use code. A concurrent callback cannot exchange twice.
    const claimed = (await this.database.query<{ owner_identity_id: string; code_verifier: string }>(
      `WITH claim AS (SELECT owner_identity_id,code_verifier FROM link_oauth_accounts
         WHERE state=$1 AND attempt_expires_at>now() FOR UPDATE)
       UPDATE link_oauth_accounts account SET state=NULL,code_verifier=NULL,
         attempt_expires_at=NULL,updated_at=now() FROM claim
       WHERE account.owner_identity_id=claim.owner_identity_id
       RETURNING claim.owner_identity_id,claim.code_verifier`, [state])).rows[0];
    if (!claimed) return { completed: false };
    if (!code) {
      if (/ineligible|not eligible|unavailable|unsupported|country|region|location|United States|Canada/i
        .test(`${error ?? ''} ${description ?? ''}`))
        await this.database.query(`UPDATE link_oauth_accounts SET ineligible=true WHERE owner_identity_id=$1`,
          [claimed.owner_identity_id]);
      return { completed: false, ownerId: claimed.owner_identity_id };
    }
    const token = await this.token(new URLSearchParams({ grant_type: 'authorization_code',
      client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri,
      code, code_verifier: claimed.code_verifier }));
    if (!token?.access_token || !token.refresh_token || !token.scope?.split(' ').includes('payment_methods.agentic'))
      return { completed: false, ownerId: claimed.owner_identity_id };
    const grant: Grant = { accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      scopes: token.scope.split(' ').filter(Boolean) };
    let ineligible = false;
    if (grant.scopes.includes('userinfo:read')) {
      const user = await this.transport('https://api.link.com/userinfo', {
        headers: { authorization: `Bearer ${grant.accessToken}` },
      }).catch(() => null);
      if (user?.ok) {
        const info = await user.json() as { address?: { country?: string } };
        const country = info.address?.country?.toUpperCase();
        ineligible = Boolean(country && country !== 'US' && country !== 'CA');
      }
    }
    await this.database.query(`UPDATE link_oauth_accounts SET sealed_grant=$2,
      granted_scopes=$3::text[],ineligible=$4,updated_at=now() WHERE owner_identity_id=$1`,
      [claimed.owner_identity_id, this.seal(grant), grant.scopes, ineligible]);
    return { completed: true, ownerId: claimed.owner_identity_id };
  }

  private async token(body: URLSearchParams): Promise<Token | null> {
    const response = await this.transport('https://login.link.com/auth/token', {
      method: 'POST', headers: { authorization: `Bearer ${this.publishableKey}`,
        'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    return response.ok ? await response.json() as Token : null;
  }

  private async access(ownerId: string): Promise<string> {
    return this.database.transaction(async database => {
      const row = (await database.query<{ sealed_grant: string; ineligible: boolean }>(
        `SELECT sealed_grant,ineligible FROM link_oauth_accounts WHERE owner_identity_id=$1 FOR UPDATE`,
        [ownerId])).rows[0];
      if (!row?.sealed_grant) throw new Error('Connect Link in Workbench first.');
      if (row.ineligible) throw new Error(INELIGIBLE);
      let grant = this.open(row.sealed_grant);
      if (grant.expiresAt < Date.now() + 60_000) {
        const refreshed = await this.token(new URLSearchParams({ grant_type: 'refresh_token',
          client_id: this.clientId, client_secret: this.clientSecret,
          refresh_token: grant.refreshToken }));
        if (!refreshed?.access_token || !refreshed.refresh_token)
          throw new Error('Link connection expired. Reconnect it in Workbench.');
        grant = { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token,
          expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
          scopes: refreshed.scope?.split(' ').filter(Boolean) ?? grant.scopes };
        await database.query(`UPDATE link_oauth_accounts SET sealed_grant=$2,
          granted_scopes=$3::text[],updated_at=now() WHERE owner_identity_id=$1`,
          [ownerId, this.seal(grant), grant.scopes]);
      }
      if (!grant.scopes.includes('payment_methods.agentic')) throw new Error('Reconnect Link to allow payments.');
      return grant.accessToken;
    });
  }

  async disconnect(ownerId: string): Promise<void> {
    const row = (await this.database.query<{ sealed_grant: string }>(
      `SELECT sealed_grant FROM link_oauth_accounts WHERE owner_identity_id=$1`, [ownerId])).rows[0];
    if (row?.sealed_grant) {
      const grant = this.open(row.sealed_grant);
      const revoked = await this.transport('https://login.link.com/auth/revoke', { method: 'POST',
        headers: { authorization: `Bearer ${this.publishableKey}`,
          'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret,
          token: grant.refreshToken, token_type_hint: 'refresh_token' }) });
      if (!revoked.ok) throw new Error('Link disconnection failed. Try again.');
    }
    await this.database.query(`DELETE FROM link_oauth_accounts WHERE owner_identity_id=$1`, [ownerId]);
  }

  private async request(ownerId: string, path: string, init: RequestInit): Promise<SpendRequest> {
    const response = await this.transport(`https://api.link.com${path}`, { ...init,
      headers: { authorization: `Bearer ${await this.access(ownerId)}`,
        'content-type': 'application/json' } });
    // Link error bodies may contain sensitive data; expose only a fixed status.
    if (!response.ok) throw new Error(`Link payment request failed (HTTP ${response.status}).`);
    return await response.json() as SpendRequest;
  }

  async create(ownerId: string, agentId: string, roomId: string, input: {
    merchant: string; merchantUrl?: string; amount: number; description: string;
    test?: boolean; idempotencyKey: string;
    credentialType?: 'card' | 'shared_payment_token'; networkId?: string;
  }): Promise<Pick<SpendRequest, 'id' | 'status' | 'approval_url'>> {
    if (!input.merchant.trim() || input.merchant.length > 80 ||
      input.description.length > 500 || (input.credentialType !== 'shared_payment_token'
        && !/^https:\/\//.test(input.merchantUrl ?? ''))
      || !Number.isSafeInteger(input.amount) || input.amount <= 0 || !input.description.trim())
      throw new Error('merchant, HTTPS merchantUrl, positive amount in cents, and description are required');
    if (input.credentialType === 'shared_payment_token' && !input.networkId?.trim())
      throw new Error('Link shared payment token requires networkId from the seller challenge');
    // Link requires >=100 characters of purchase context. Explain the user request without changing it.
    const context = input.description.length >= 100 ? input.description
      : `${input.description}. The customer asked their Beeline agent to buy this item from ${input.merchant} for ${input.amount} cents. Link approval is required for this exact purchase before checkout with the seller.`;
    const result = await this.request(ownerId, '/spend_requests', { method: 'POST',
      body: JSON.stringify({ ...(input.credentialType === 'shared_payment_token'
        ? { credential_type: 'shared_payment_token', network_id: input.networkId }
        : { merchant_name: input.merchant, merchant_url: input.merchantUrl }),
        amount: input.amount, context, request_approval: true,
        idempotency_key: input.idempotencyKey, ...(input.test ? { test: true } : {}) }) });
    if (!/^lsrq_[A-Za-z0-9]+$/.test(result.id)) throw new Error('Link returned an invalid request ID');
    if (result.status === 'pending_approval' && !result.approval_url)
      throw new Error('Link did not return an approval page');
    await this.database.query(`INSERT INTO link_spend_requests(id,owner_identity_id,agent_id,room_id,
      merchant,amount,description,test) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING`, [result.id, ownerId, agentId, roomId,
        input.merchant, input.amount, input.description, Boolean(input.test)]);
    return { id: result.id, status: result.status, approval_url: result.approval_url };
  }

  async retrieve(ownerId: string, agentId: string, id: string): Promise<SpendRequest> {
    const owned = await this.database.query(`SELECT 1 FROM link_spend_requests
      WHERE id=$1 AND owner_identity_id=$2 AND agent_id=$3`, [id, ownerId, agentId]);
    if (!owned.rowCount) throw new Error('Link spend request is unavailable');
    const result = await this.request(ownerId,
      `/spend_requests/${encodeURIComponent(id)}?include=card,shared_payment_token`, { method: 'GET' });
    if (result.status !== 'approved') return { id: result.id, status: result.status,
      approval_url: result.approval_url, status_details: result.status_details };
    return result;
  }
}
