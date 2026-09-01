import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './database.js';

const ACCESS_LIFETIME_MS = 15 * 60_000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const DAEMON_EXCHANGE_LIFETIME_MS = 15 * 60_000;

export interface GitHubIdentityProof {
  subject: string;
  login: string;
  name: string;
  avatar?: string;
}

export type VerifyGitHubOidc = (token: string) => Promise<GitHubIdentityProof>;

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function identityId(subject: string): string {
  return createHash('sha256').update(`github:${subject}`).digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PhoneTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  identityId: string;
}

export class TokenAuth {
  constructor(
    private readonly database: SqlDatabase,
    private readonly verifyGitHubOidc: VerifyGitHubOidc,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exchangeGitHubOidc(oidcToken: string): Promise<PhoneTokens> {
    const github = await this.verifyGitHubOidc(oidcToken);
    if (!github.subject || !github.login || !github.name)
      throw new Error('invalid GitHub identity');
    const linked = await this.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_external_links WHERE provider = 'github' AND subject = $1`,
      [github.subject],
    );
    const id = linked.rows[0]?.identity_id ?? identityId(github.subject);
    await this.database.transaction(async (database) => {
      await database.query(
        `INSERT INTO identities(id, kind, name, handle, avatar, github_subject, updated_at)
       VALUES ($1, 'human', $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, handle = EXCLUDED.handle,
         avatar = EXCLUDED.avatar, github_subject = EXCLUDED.github_subject, updated_at = EXCLUDED.updated_at`,
        [id, github.name, github.login, github.avatar ?? null, github.subject, this.now()],
      );
      await database.query(
        `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience)
         VALUES('github',$1,$2,'https://github.com','github')
         ON CONFLICT(provider,subject) DO UPDATE SET identity_id=EXCLUDED.identity_id`,
        [github.subject, id],
      );
    });
    return this.issuePhoneTokens(id, randomUUID());
  }

  async refresh(refreshToken: string): Promise<PhoneTokens | null> {
    const hash = tokenHash(refreshToken);
    return this.database.transaction(async (database) => {
      const found = await database.query<{
        refresh_hash: string;
        identity_id: string;
        family_id: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(`SELECT * FROM phone_sessions WHERE refresh_hash = $1 FOR UPDATE`, [hash]);
      const session = found.rows[0];
      if (!session || !sameHash(session.refresh_hash, hash)) return null;
      if (session.consumed_at || session.expires_at.getTime() <= this.now().getTime()) {
        await database.query(`DELETE FROM phone_sessions WHERE family_id = $1`, [
          session.family_id,
        ]);
        await database.query(`DELETE FROM phone_access_tokens WHERE family_id = $1`, [
          session.family_id,
        ]);
        return null;
      }
      await database.query(`UPDATE phone_sessions SET consumed_at = $2 WHERE refresh_hash = $1`, [
        hash,
        this.now(),
      ]);
      return this.issuePhoneTokens(session.identity_id, session.family_id, database);
    });
  }

  async authenticatePhone(token: string): Promise<string | null> {
    const hash = tokenHash(token);
    const result = await this.database.query<{ identity_id: string; token_hash: string }>(
      `SELECT identity_id, token_hash FROM phone_access_tokens
       WHERE token_hash = $1 AND expires_at > $2`,
      [hash, this.now()],
    );
    const row = result.rows[0];
    return row && sameHash(row.token_hash, hash) ? row.identity_id : null;
  }

  async createDaemonExchange(
    agentId: string,
  ): Promise<{ exchangeToken: string; expiresAt: number }> {
    const exchangeToken = opaque('bde');
    const expiresAt = this.now().getTime() + DAEMON_EXCHANGE_LIFETIME_MS;
    await this.database.query(
      `INSERT INTO daemon_token_exchanges(exchange_hash, agent_id, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash(exchangeToken), agentId, new Date(expiresAt)],
    );
    return { exchangeToken, expiresAt };
  }

  async exchangeDaemonToken(
    exchangeToken: string,
  ): Promise<{ daemonToken: string; agentId: string } | null> {
    const hash = tokenHash(exchangeToken);
    return this.database.transaction(async (database) => {
      const found = await database.query<{
        agent_id: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT agent_id, expires_at, consumed_at FROM daemon_token_exchanges WHERE exchange_hash = $1 FOR UPDATE`,
        [hash],
      );
      const exchange = found.rows[0];
      if (
        !exchange ||
        exchange.consumed_at ||
        exchange.expires_at.getTime() <= this.now().getTime()
      )
        return null;
      await database.query(
        `UPDATE daemon_token_exchanges SET consumed_at = $2 WHERE exchange_hash = $1`,
        [hash, this.now()],
      );
      const daemonToken = opaque('bdt');
      await database.query(`INSERT INTO daemon_tokens(token_hash, agent_id) VALUES ($1, $2)`, [
        tokenHash(daemonToken),
        exchange.agent_id,
      ]);
      return { daemonToken, agentId: exchange.agent_id };
    });
  }

  async authenticateDaemon(token: string): Promise<string | null> {
    const hash = tokenHash(token);
    const result = await this.database.query<{ agent_id: string; token_hash: string }>(
      `UPDATE daemon_tokens SET last_used_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
       RETURNING agent_id, token_hash`,
      [hash, this.now()],
    );
    const row = result.rows[0];
    return row && sameHash(row.token_hash, hash) ? row.agent_id : null;
  }

  private async issuePhoneTokens(
    identity: string,
    familyId: string,
    database: SqlDatabase = this.database,
  ): Promise<PhoneTokens> {
    const accessToken = opaque('bat');
    const refreshToken = opaque('brt');
    const accessExpiresAt = this.now().getTime() + ACCESS_LIFETIME_MS;
    const refreshExpiresAt = this.now().getTime() + REFRESH_LIFETIME_MS;
    await database.query(
      `INSERT INTO phone_access_tokens(token_hash, identity_id, family_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash(accessToken), identity, familyId, new Date(accessExpiresAt)],
    );
    await database.query(
      `INSERT INTO phone_sessions(refresh_hash, identity_id, family_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash(refreshToken), identity, familyId, new Date(refreshExpiresAt)],
    );
    return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, identityId: identity };
  }
}

export function bearer(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token.length >= 20 ? token : null;
}

/** Redeem the auth service's one-use GitHub bind ticket; raw provider tokens never cross services. */
export function verifierFromEnvironment(): VerifyGitHubOidc {
  const endpoint =
    process.env.PHONE_GITHUB_EXCHANGE_ENDPOINT ??
    'https://usebeeline.app/auth/github/phone-exchange';
  return async (token) => {
    if (process.env.NODE_ENV !== 'production' && token.startsWith('local:')) {
      const login = token.slice('local:'.length);
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('invalid local GitHub identity');
      return { subject: `local-${login}`, login, name: login };
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: token }),
    });
    if (!response.ok) throw new Error('GitHub identity exchange failed');
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.subject !== 'string' ||
      typeof body.login !== 'string'
    ) {
      throw new Error('GitHub identity response is invalid');
    }
    return {
      subject: body.subject,
      login: body.login,
      name: typeof body.name === 'string' && body.name ? body.name : body.login,
      ...(typeof body.avatar_url === 'string' ? { avatar: body.avatar_url } : {}),
    };
  };
}
