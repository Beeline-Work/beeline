import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { GITHUB_IDENTITY_AUDIENCE } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import { ensureReviewWorkspace } from './review-proof-fixture.js';
import {
  lockIdentityHandleWorkspaces,
  reassignCollidingAgentHandles,
} from './workspace-handles.js';
import {
  REVIEW_IDENTITY_HANDLE,
  REVIEW_IDENTITY_ID,
  REVIEW_IDENTITY_NAME,
} from './review-access.js';

const ACCESS_LIFETIME_MS = 15 * 60_000;
// A date-valued sentinel keeps older server images able to read the row during
// the two-Machine rollout or a rollback. Session lifetime is explicit revocation,
// not this field; the sweeper no longer deletes phone sessions by age.
const DURABLE_REFRESH_EXPIRES_AT = Date.parse('9999-12-31T23:59:59.000Z');
const DAEMON_EXCHANGE_LIFETIME_MS = 15 * 60_000;
const DAEMON_AUTH_CACHE_TTL_MS = 10_000;

export interface GitHubIdentityProof {
  subject: string;
  login: string;
  name: string;
  avatar?: string;
  /** Trusted server-side credential; never serialized into phone responses. */
  githubCredential?: {
    encryptedToken: string;
    encryptedRefreshToken: string | null;
    expiresAt: Date | null;
  };
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

// Only the holder of the consumed token can decrypt its successor. The database
// keeps the hash and sealed reply, never the raw phone credentials.
function replayKey(refreshToken: string): Buffer {
  return createHash('sha256').update('beeline:refresh-replay:').update(refreshToken).digest();
}

function openSuccessor(refreshToken: string, sealed: string): PhoneTokens {
  const parts = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16)
    throw new Error('stored phone successor is invalid');
  const decipher = createDecipheriv('aes-256-gcm', replayKey(refreshToken), parts[0]!);
  decipher.setAuthTag(parts[1]!);
  return JSON.parse(
    Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8'),
  ) as PhoneTokens;
}

export interface PhoneTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  identityId: string;
}

export class TokenAuth {
  readonly #daemonAuthCache = new Map<string, { agentId: string | null; expiresAt: number }>();

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
        `INSERT INTO identities(id, kind, name, avatar, github_subject, updated_at)
       VALUES ($1, 'human', $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
        [id, github.name, github.avatar ?? null, github.subject, this.now()],
      );
      const workspaceIds = await lockIdentityHandleWorkspaces(database, id);
      await reassignCollidingAgentHandles(database, id, github.login, workspaceIds);
      // A name the person edited in Beeline survives later GitHub sign-ins;
      // only an identity with no name yet takes the GitHub one.
      await database.query(
        `UPDATE identities SET name=COALESCE(NULLIF(identities.name,''),$2),
           handle=$3,avatar=$4,github_subject=$5,updated_at=$6
         WHERE id=$1`,
        [id, github.name, github.login, github.avatar ?? null, github.subject, this.now()],
      );
      await database.query(
        `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
         VALUES('github',$1,$2,'https://github.com',$3,$4)
         ON CONFLICT(provider,subject) DO UPDATE SET
           identity_id=EXCLUDED.identity_id,
           issuer=EXCLUDED.issuer,
           audience=EXCLUDED.audience,
           provider_login=EXCLUDED.provider_login`,
        [github.subject, id, GITHUB_IDENTITY_AUDIENCE, github.login],
      );
      await this.persistGitHubCredential(database, github);
      // No landing: a person with no Workspace is sent to the phone's
      // create-or-join choice, and an invite link carries them to its own.
    });
    return this.issuePhoneTokens(id, randomUUID());
  }

  async reconnectGitHub(viewerId: string, ticket: string): Promise<boolean> {
    const github = await this.verifyGitHubOidc(ticket);
    return this.database.transaction(async (database) => {
      const linked = await database.query(
        `SELECT 1 FROM identity_external_links WHERE provider='github' AND identity_id=$1 AND subject=$2 FOR UPDATE`,
        [viewerId, github.subject],
      );
      if (!linked.rowCount) return false;
      if (!github.githubCredential) throw new Error('GitHub credential missing; reconnect again');
      await this.persistGitHubCredential(database, github);
      return true;
    });
  }

  private async persistGitHubCredential(database: SqlDatabase, github: GitHubIdentityProof) {
    const credential = github.githubCredential;
    if (!credential) return;
    await database.query(
      `INSERT INTO github_user_tokens(subject,encrypted_token,encrypted_refresh_token,expires_at)
       VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET
       encrypted_token=EXCLUDED.encrypted_token,encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
       expires_at=EXCLUDED.expires_at,stale_at=NULL,updated_at=now()`,
      [
        github.subject,
        credential.encryptedToken,
        credential.encryptedRefreshToken,
        credential.expiresAt,
      ],
    );
  }

  /**
   * Sign in the one fixed Google Play review identity. The reviewer must see
   * the ordinary product, so it lands the way a new Workspace creator does:
   * owner of its own fixed Workspace with a public `#general`, plus the
   * release proof's corner fixture (`ensureReviewWorkspace`). It holds no
   * `github_subject` or external link, so it can never install the App or
   * link a repository. The secret itself is checked by `ReviewAccess`.
   */
  async exchangeReviewIdentity(): Promise<PhoneTokens> {
    await this.database.transaction(async (database) => {
      await database.query(
        `INSERT INTO identities(id, kind, name, handle, updated_at)
         VALUES ($1, 'human', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [REVIEW_IDENTITY_ID, REVIEW_IDENTITY_NAME, REVIEW_IDENTITY_HANDLE, this.now()],
      );
      await ensureReviewWorkspace(database, REVIEW_IDENTITY_ID);
    });
    return this.issuePhoneTokens(REVIEW_IDENTITY_ID, randomUUID());
  }

  async refresh(refreshToken: string): Promise<PhoneTokens | null> {
    return this.database.transaction(async (database) => {
      if (!await this.lockPhoneIdentity(database, refreshToken)) return null;
      // A device credential survives sleep, process death and lost replies.
      // Only access tokens expire. Old rotating credentials can follow their
      // sealed successors to the same device session, with no replay deadline
      // and no family-wide punishment for an older request arriving late.
      const visited = new Set<string>();
      let familyId: string | undefined;
      let credential = refreshToken;
      while (true) {
        const hash = tokenHash(credential);
        if (visited.has(hash)) return null;
        visited.add(hash);
        const found = await database.query<{
          refresh_hash: string; identity_id: string; family_id: string;
          consumed_at: Date | null; successor_tokens: string | null;
        }>(`SELECT * FROM phone_sessions WHERE refresh_hash=$1 FOR UPDATE`, [hash]);
        const session = found.rows[0];
        if (!session || !sameHash(session.refresh_hash, hash)) return null;
        familyId ??= session.family_id;
        if (session.family_id !== familyId) return null;
        if (session.consumed_at) {
          if (!session.successor_tokens) return null;
          credential = openSuccessor(credential, session.successor_tokens).refreshToken;
          continue;
        }
        const access = await this.issuePhoneAccess(session.identity_id, familyId, database);
        return { ...access, refreshToken: credential, refreshExpiresAt: DURABLE_REFRESH_EXPIRES_AT, identityId: session.identity_id };
      }
    });
  }

  /** Revoke only the presenting device session; repeated sign-out is harmless. */
  async revokePhoneSession(refreshToken: string): Promise<void> {
    await this.database.transaction(async database => {
      if (!await this.lockPhoneIdentity(database, refreshToken)) return;
      const found = await database.query<{ family_id: string }>(
        'SELECT family_id FROM phone_sessions WHERE refresh_hash=$1 FOR UPDATE', [tokenHash(refreshToken)],
      );
      const familyId = found.rows[0]?.family_id;
      if (!familyId) return;
      await database.query('DELETE FROM phone_access_tokens WHERE family_id=$1', [familyId]);
      await database.query('DELETE FROM phone_sessions WHERE family_id=$1', [familyId]);
    });
  }

  private async lockPhoneIdentity(database: SqlDatabase, refreshToken: string): Promise<boolean> {
    const found = await database.query<{ identity_id: string }>(
      'SELECT identity_id FROM phone_sessions WHERE refresh_hash=$1', [tokenHash(refreshToken)],
    );
    const identityId = found.rows[0]?.identity_id;
    if (!identityId) return false;
    // Refresh and revocation acquire the identity before any session row.
    // A legacy ancestor retry and sign-out of its successor cannot deadlock.
    return !!(await database.query('SELECT id FROM identities WHERE id=$1 FOR UPDATE', [identityId])).rowCount;
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
    database: Pick<SqlDatabase, 'query'> = this.database,
  ): Promise<{ exchangeToken: string; expiresAt: number }> {
    const exchangeToken = opaque('bde');
    const expiresAt = this.now().getTime() + DAEMON_EXCHANGE_LIFETIME_MS;
    await database.query(
      `INSERT INTO daemon_token_exchanges(exchange_hash, agent_id, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash(exchangeToken), agentId, new Date(expiresAt)],
    );
    return { exchangeToken, expiresAt };
  }

  /** One forward credential migration; never restores a revoked monolith token. */
  async migrateLegacyDaemon(input: { agentId: string; workspaceId: string; pairedBy: string; proofId: string }): Promise<{ agentId: string; exchangeToken: string; expiresAt: number } | null> {
    return this.database.transaction(async (database) => {
      const identity = await database.query(
        `SELECT a.agent_id FROM agents a JOIN identities i ON i.id=a.agent_id
         WHERE a.agent_id=$1 AND a.owner_id=$2 AND i.kind='agent' AND NOT i.hidden_from_roster
           AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=$3 AND m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL)
           AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=$3 AND m.identity_id=a.owner_id AND m.room_id IS NULL AND m.removed_at IS NULL)
         FOR UPDATE OF a`, [input.agentId, input.pairedBy, input.workspaceId],
      );
      if (!identity.rowCount) return null;
      if ((await database.query(`SELECT 1 FROM daemon_tokens WHERE agent_id=$1 AND (revoked_at IS NOT NULL OR expires_at<=$2) LIMIT 1`, [input.agentId, this.now()])).rowCount) return null;
      const prior = (await database.query<{ proof_id: string; exchange_hash: string }>(
        `SELECT proof_id,exchange_hash FROM legacy_daemon_migrations WHERE agent_id=$1`, [input.agentId],
      )).rows[0];
      if (prior?.proof_id === input.proofId) return null;
      if (prior && (await database.query(`SELECT 1 FROM daemon_token_exchanges WHERE exchange_hash=$1 AND consumed_at IS NOT NULL`, [prior.exchange_hash])).rowCount) return null;
      // An interrupted local write can retry with a fresh proof. Only the latest exchange survives.
      if (prior) await database.query(`DELETE FROM daemon_token_exchanges WHERE exchange_hash=$1 AND consumed_at IS NULL`, [prior.exchange_hash]);
      const exchange = await this.createDaemonExchange(input.agentId, database);
      await database.query(
        `INSERT INTO legacy_daemon_migrations(agent_id,proof_id,exchange_hash,workspace_id,owner_id)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(agent_id) DO UPDATE SET proof_id=EXCLUDED.proof_id,exchange_hash=EXCLUDED.exchange_hash,migrated_at=now()`,
        [input.agentId, input.proofId, tokenHash(exchange.exchangeToken), input.workspaceId, input.pairedBy],
      );
      return { agentId: input.agentId, ...exchange };
    });
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
      if (!exchange) return null;
      const legacy = (await database.query<{ workspace_id: string; owner_id: string }>(
        `SELECT workspace_id,owner_id FROM legacy_daemon_migrations WHERE exchange_hash=$1 AND agent_id=$2`, [hash, exchange.agent_id],
      )).rows[0];
      // A consumed legacy exchange only redelivers its already-issued, still
      // authorized credential. A long interruption cannot turn a lost local
      // write into a reconnect requirement; unused exchanges still expire.
      if (exchange.expires_at.getTime() <= this.now().getTime() && !(legacy && exchange.consumed_at)) return null;
      if (legacy) {
        // Lock the current membership before minting. Removal takes this row first,
        // so it either wins here or revokes the newly minted token afterward.
        const authorized = await database.query(
          `SELECT member.id FROM memberships member JOIN memberships owner
             ON owner.workspace_id=member.workspace_id AND owner.identity_id=$3 AND owner.room_id IS NULL AND owner.removed_at IS NULL
           JOIN identities i ON i.id=member.identity_id JOIN agents a ON a.agent_id=i.id
           WHERE member.workspace_id=$1 AND member.identity_id=$2 AND member.room_id IS NULL
             AND member.removed_at IS NULL AND NOT i.hidden_from_roster AND a.owner_id=$3
           FOR UPDATE OF member,owner`, [legacy.workspace_id, exchange.agent_id, legacy.owner_id],
        );
        if (!authorized.rowCount) return null;
      }
      // Delivering a legacy credential is idempotent across a lost HTTP reply
      // or process death after minting. Derive its high-entropy bearer from the
      // exchange secret so the database still stores hashes only. Ordinary
      // exchanges retain their one-use contract; revoked tokens never revive.
      const daemonToken = legacy ? `bdt_${createHash('sha256').update('beeline legacy daemon exchange\0').update(exchangeToken).digest('base64url')}` : opaque('bdt');
      if (exchange.consumed_at) {
        if (!legacy) return null;
        const existing = await database.query(`SELECT 1 FROM daemon_tokens WHERE token_hash=$1 AND agent_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3)`, [tokenHash(daemonToken), exchange.agent_id, this.now()]);
        return existing.rowCount ? { daemonToken, agentId: exchange.agent_id } : null;
      }
      await database.query(
        `UPDATE daemon_token_exchanges SET consumed_at = $2 WHERE exchange_hash = $1`,
        [hash, this.now()],
      );
      await database.query(`INSERT INTO daemon_tokens(token_hash, agent_id) VALUES ($1, $2)`, [
        tokenHash(daemonToken),
        exchange.agent_id,
      ]);
      return { daemonToken, agentId: exchange.agent_id };
    });
  }

  /** Resolve a daemon exchange token to its agent, consuming it in the same transaction. */
  async consumeDaemonExchangeAgent(exchangeToken: string): Promise<string | null> {
    const hash = tokenHash(exchangeToken);
    return this.database.transaction(async (database) => {
      const found = await database.query<{ agent_id: string; expires_at: Date }>(
        `SELECT agent_id,expires_at FROM daemon_token_exchanges WHERE exchange_hash = $1 FOR UPDATE`,
        [hash],
      );
      const exchange = found.rows[0];
      if (!exchange || exchange.expires_at.getTime() <= this.now().getTime()) return null;
      await database.query(`DELETE FROM daemon_token_exchanges WHERE exchange_hash = $1`, [hash]);
      return exchange.agent_id;
    });
  }

  /** Resolve a daemon exchange token to its agent even after it was consumed. */
  async resolveDaemonExchangeAgent(exchangeToken: string): Promise<string | null> {
    const row = (
      await this.database.query<{ agent_id: string; expires_at: Date }>(
        `SELECT agent_id,expires_at FROM daemon_token_exchanges WHERE exchange_hash = $1`,
        [tokenHash(exchangeToken)],
      )
    ).rows[0];
    if (!row || row.expires_at.getTime() <= this.now().getTime()) return null;
    return row.agent_id;
  }

  async authenticateDaemon(token: string): Promise<string | null> {
    const hash = tokenHash(token);
    const now = this.now();
    const cached = this.#daemonAuthCache.get(hash);
    if (cached && cached.expiresAt > now.getTime()) return cached.agentId;
    if (cached) this.#daemonAuthCache.delete(hash);

    const result = await this.database.query<{ agent_id: string; token_hash: string }>(
      `SELECT agent_id, token_hash FROM daemon_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
      [hash, now],
    );
    const row = result.rows[0];
    const agentId = row && sameHash(row.token_hash, hash) ? row.agent_id : null;
    this.#daemonAuthCache.set(hash, {
      agentId,
      expiresAt: now.getTime() + DAEMON_AUTH_CACHE_TTL_MS,
    });
    return agentId;
  }

  /**
   * The one definitive "your agent was removed" answer. A daemon token that
   * was revoked AND whose agent holds no live membership anywhere is not a
   * transient authentication failure: nothing can restore it, so the helper
   * that presented it may retire itself on this and only this. A live agent
   * whose token was merely rotated, an unknown token, and every transport or
   * server failure all resolve to `null` here and stay a plain 401.
   */
  async retiredDaemonAgent(token: string): Promise<string | null> {
    const hash = tokenHash(token);
    const result = await this.database.query<{ agent_id: string; token_hash: string }>(
      `SELECT agent_id,token_hash FROM daemon_tokens t
       WHERE t.token_hash = $1 AND t.revoked_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM memberships m
           WHERE m.identity_id = t.agent_id AND m.removed_at IS NULL
         )`,
      [hash],
    );
    const row = result.rows[0];
    return row && sameHash(row.token_hash, hash) ? row.agent_id : null;
  }

  private async issuePhoneTokens(
    identity: string,
    familyId: string,
  ): Promise<PhoneTokens> {
    return this.database.transaction(async database => {
      const access = await this.issuePhoneAccess(identity, familyId, database);
      const refreshToken = opaque('brt');
      await database.query(
        `INSERT INTO phone_sessions(refresh_hash, identity_id, family_id, expires_at)
         VALUES ($1, $2, $3, $4)`, [tokenHash(refreshToken), identity, familyId, new Date(DURABLE_REFRESH_EXPIRES_AT)],
      );
      return { ...access, refreshToken, refreshExpiresAt: DURABLE_REFRESH_EXPIRES_AT, identityId: identity };
    });
  }

  private async issuePhoneAccess(identity: string, familyId: string, database: SqlDatabase):
    Promise<Pick<PhoneTokens, 'accessToken' | 'accessExpiresAt'>> {
    const accessToken = opaque('bat');
    const accessExpiresAt = this.now().getTime() + ACCESS_LIFETIME_MS;
    await database.query(
      `INSERT INTO phone_access_tokens(token_hash, identity_id, family_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash(accessToken), identity, familyId, new Date(accessExpiresAt)],
    );
    return { accessToken, accessExpiresAt };
  }
}

export function bearer(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token.length >= 20 ? token : null;
}

/** Prefer the mounted auth store; an endpoint override remains available for tests and migrations. */
export function verifierFromEnvironment(inProcess: VerifyGitHubOidc): VerifyGitHubOidc {
  const endpoint = process.env.PHONE_GITHUB_EXCHANGE_ENDPOINT;
  return async (token) => {
    if (process.env.NODE_ENV !== 'production' && token.startsWith('local:')) {
      const login = token.slice('local:'.length);
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('invalid local GitHub identity');
      return { subject: `local-${login}`, login, name: login };
    }
    if (!endpoint) return inProcess(token);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: token }),
    });
    if (!response.ok) throw new Error('GitHub identity exchange failed');
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.subject !== 'string' || typeof body.login !== 'string') {
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
