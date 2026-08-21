import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface SqlResult<Row extends QueryResultRow> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<Row extends QueryResultRow>(sql: string, values?: unknown[]): Promise<SqlResult<Row>>;
}

export interface TransactionalDatabase extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresDatabase implements TransactionalDatabase {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 10 });
  }

  async query<Row extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<SqlResult<Row>> {
    return this.#pool.query<Row>(sql, values);
  }

  async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS beeline_oidc_flows (
    state_hash CHAR(64) PRIMARY KEY,
    community TEXT NOT NULL,
    issuer TEXT NOT NULL,
    audience TEXT NOT NULL,
    nonce TEXT NOT NULL,
    pkce_verifier TEXT NOT NULL,
    browser_session_hash CHAR(64) NOT NULL,
    redirect_uri TEXT NOT NULL,
    app_redirect_uri TEXT,
    app_state TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
  )`,
  `ALTER TABLE beeline_oidc_flows ADD COLUMN IF NOT EXISTS app_redirect_uri TEXT`,
  `ALTER TABLE beeline_oidc_flows ADD COLUMN IF NOT EXISTS app_state TEXT`,
  `CREATE TABLE IF NOT EXISTS beeline_bind_tickets (
    ticket_hash CHAR(64) PRIMARY KEY,
    challenge TEXT NOT NULL,
    community TEXT NOT NULL,
    issuer TEXT NOT NULL,
    audience TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
    consumed_at TIMESTAMPTZ,
    bound_pubkey CHAR(64)
  )`,
  `CREATE TABLE IF NOT EXISTS beeline_identity_links (
    community TEXT NOT NULL,
    issuer TEXT NOT NULL,
    audience TEXT NOT NULL,
    subject TEXT NOT NULL,
    pubkey CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, issuer, audience, subject),
    CHECK (pubkey ~ '^[0-9a-f]{64}$')
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_identity_links_pubkey_idx
    ON beeline_identity_links (community, pubkey)`,
  `CREATE TABLE IF NOT EXISTS beeline_nip98_replays (
    event_id CHAR(64) PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS beeline_nip05_names (
    name TEXT PRIMARY KEY,
    pubkey CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (pubkey ~ '^[0-9a-f]{64}$')
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_oidc_flows_expiry_idx ON beeline_oidc_flows (expires_at)`,
  `CREATE INDEX IF NOT EXISTS beeline_bind_tickets_expiry_idx ON beeline_bind_tickets (expires_at)`,
  `CREATE INDEX IF NOT EXISTS beeline_nip98_replays_expiry_idx ON beeline_nip98_replays (expires_at)`,
  `CREATE INDEX IF NOT EXISTS beeline_nip05_names_pubkey_idx ON beeline_nip05_names (pubkey)`,
  `CREATE TABLE IF NOT EXISTS beeline_github_install_flows (
    state_hash CHAR(64) PRIMARY KEY,
    community TEXT NOT NULL,
    pubkey CHAR(64) NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CHECK (pubkey ~ '^[0-9a-f]{64}$')
  )`,
  `CREATE TABLE IF NOT EXISTS beeline_github_installations (
    community TEXT NOT NULL,
    pubkey CHAR(64) NOT NULL,
    account_id TEXT NOT NULL,
    account_login TEXT NOT NULL DEFAULT '',
    account_type TEXT NOT NULL DEFAULT 'User',
    account_avatar_url TEXT,
    installation_id BIGINT NOT NULL,
    repository_selection TEXT NOT NULL DEFAULT 'selected',
    status TEXT NOT NULL DEFAULT 'active',
    repository_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, pubkey, installation_id),
    UNIQUE (community, installation_id),
    CHECK (pubkey ~ '^[0-9a-f]{64}$')
  )`,
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS account_login TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'User'`,
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS account_avatar_url TEXT`,
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS repository_selection TEXT NOT NULL DEFAULT 'selected'`,
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS repository_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE beeline_github_installations DROP CONSTRAINT IF EXISTS beeline_github_installations_pkey`,
  `CREATE UNIQUE INDEX IF NOT EXISTS beeline_github_installations_owner_idx
    ON beeline_github_installations (community, pubkey, installation_id)`,
  `CREATE TABLE IF NOT EXISTS beeline_github_repositories (
    community TEXT NOT NULL,
    installation_id BIGINT NOT NULL,
    repository_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    remote TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, installation_id, repository_id)
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_github_repositories_name_idx
    ON beeline_github_repositories (community, lower(full_name))`,
  `CREATE TABLE IF NOT EXISTS beeline_github_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS beeline_github_user_tokens (
    community TEXT NOT NULL,
    subject TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, subject)
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_github_install_flows_expiry_idx
    ON beeline_github_install_flows (expires_at)`,
] as const;

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('database returned invalid timestamp');
  return date;
}

interface FlowRow extends QueryResultRow {
  community: string;
  issuer: string;
  audience: string;
  nonce: string;
  pkce_verifier: string;
  browser_session_hash: string;
  redirect_uri: string;
  app_redirect_uri: string | null;
  app_state: string | null;
  created_at: unknown;
  expires_at: unknown;
}

export interface OidcFlow {
  community: string;
  issuer: string;
  audience: string;
  nonce: string;
  pkceVerifier: string;
  browserSessionHash: string;
  redirectUri: string;
  appRedirectUri: string | null;
  appState: string | null;
  createdAt: Date;
  expiresAt: Date;
}

interface TicketRow extends QueryResultRow {
  challenge: string;
  community: string;
  issuer: string;
  audience: string;
  subject: string;
  created_at: unknown;
  expires_at: unknown;
  attempt_count: number;
  consumed_at: unknown | null;
  bound_pubkey: string | null;
}

export interface BindTicket {
  challenge: string;
  community: string;
  issuer: string;
  audience: string;
  subject: string;
  createdAt: Date;
  expiresAt: Date;
  attemptCount: number;
  consumedAt: Date | null;
  boundPubkey: string | null;
}

export interface IdentityLink {
  community: string;
  issuer: string;
  audience: string;
  subject: string;
  pubkey: string;
  createdAt: Date;
}

export interface GitHubInstallFlow {
  community: string;
  pubkey: string;
  redirectUri: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface GitHubInstallation {
  community: string;
  pubkey: string;
  accountId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  accountAvatarUrl?: string;
  installationId: number;
  repositorySelection: 'all' | 'selected';
  status: 'active' | 'revoked' | 'suspended';
  repositoryCount: number;
}

export interface StoredGitHubRepository {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  remote: string;
  defaultBranch: string;
}

export type BindResult =
  | { status: 'linked' | 'idempotent'; link: IdentityLink }
  | { status: 'conflict'; existingPubkey: string }
  | { status: 'missing' | 'used' | 'expired' };

function flowFromRow(row: FlowRow): OidcFlow {
  return {
    community: row.community,
    issuer: row.issuer,
    audience: row.audience,
    nonce: row.nonce,
    pkceVerifier: row.pkce_verifier,
    browserSessionHash: row.browser_session_hash,
    redirectUri: row.redirect_uri,
    appRedirectUri: row.app_redirect_uri,
    appState: row.app_state,
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
  };
}

function ticketFromRow(row: TicketRow): BindTicket {
  return {
    challenge: row.challenge,
    community: row.community,
    issuer: row.issuer,
    audience: row.audience,
    subject: row.subject,
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
    attemptCount: row.attempt_count,
    consumedAt: row.consumed_at === null ? null : asDate(row.consumed_at),
    boundPubkey: row.bound_pubkey,
  };
}

export class AuthStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) await this.database.query(migration);
  }

  async createFlow(stateHash: string, flow: OidcFlow): Promise<void> {
    await this.database.query(`DELETE FROM beeline_oidc_flows WHERE expires_at < $1`, [
      flow.createdAt,
    ]);
    await this.database.query(
      `INSERT INTO beeline_oidc_flows
        (state_hash, community, issuer, audience, nonce, pkce_verifier, browser_session_hash, redirect_uri, app_redirect_uri, app_state, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        stateHash,
        flow.community,
        flow.issuer,
        flow.audience,
        flow.nonce,
        flow.pkceVerifier,
        flow.browserSessionHash,
        flow.redirectUri,
        flow.appRedirectUri,
        flow.appState,
        flow.createdAt,
        flow.expiresAt,
      ],
    );
  }

  async consumeFlow(
    stateHash: string,
    browserSessionHash: string,
    now: Date,
  ): Promise<OidcFlow | null> {
    const result = await this.database.query<FlowRow>(
      `UPDATE beeline_oidc_flows
       SET consumed_at = $3
       WHERE state_hash = $1 AND browser_session_hash = $2 AND consumed_at IS NULL AND expires_at >= $3
       RETURNING community, issuer, audience, nonce, pkce_verifier, browser_session_hash, redirect_uri, app_redirect_uri, app_state, created_at, expires_at`,
      [stateHash, browserSessionHash, now],
    );
    return result.rows[0] ? flowFromRow(result.rows[0]) : null;
  }

  async createTicket(ticketHash: string, ticket: BindTicket): Promise<void> {
    await this.database.query(`DELETE FROM beeline_bind_tickets WHERE expires_at < $1`, [
      ticket.createdAt,
    ]);
    await this.database.query(
      `INSERT INTO beeline_bind_tickets
        (ticket_hash, challenge, community, issuer, audience, subject, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ticketHash,
        ticket.challenge,
        ticket.community,
        ticket.issuer,
        ticket.audience,
        ticket.subject,
        ticket.createdAt,
        ticket.expiresAt,
      ],
    );
  }

  async findTicket(ticketHash: string): Promise<BindTicket | null> {
    const result = await this.database.query<TicketRow>(
      `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey
       FROM beeline_bind_tickets WHERE ticket_hash = $1`,
      [ticketHash],
    );
    return result.rows[0] ? ticketFromRow(result.rows[0]) : null;
  }

  async recordFailedTicketAttempt(ticketHash: string, now: Date): Promise<number | null> {
    const result = await this.database.query<QueryResultRow & { attempt_count: number }>(
      `UPDATE beeline_bind_tickets
       SET attempt_count = attempt_count + 1,
           consumed_at = CASE WHEN attempt_count + 1 >= 5 THEN $2 ELSE consumed_at END
       WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at >= $2 AND attempt_count < 5
       RETURNING attempt_count`,
      [ticketHash, now],
    );
    return result.rows[0]?.attempt_count ?? null;
  }

  async consumeTicketAndLink(ticketHash: string, pubkey: string, now: Date): Promise<BindResult> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey
         FROM beeline_bind_tickets WHERE ticket_hash = $1 FOR UPDATE`,
        [ticketHash],
      );
      const row = selected.rows[0];
      if (!row) return { status: 'missing' };
      const ticket = ticketFromRow(row);
      if (ticket.consumedAt) return { status: 'used' };
      if (ticket.expiresAt.getTime() < now.getTime()) return { status: 'expired' };

      await transaction.query(
        `UPDATE beeline_bind_tickets SET consumed_at = $2, bound_pubkey = $3 WHERE ticket_hash = $1`,
        [ticketHash, now, pubkey],
      );
      const inserted = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_identity_links
          (community, issuer, audience, subject, pubkey, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (community, issuer, audience, subject) DO NOTHING
         RETURNING community`,
        [ticket.community, ticket.issuer, ticket.audience, ticket.subject, pubkey, now],
      );
      const linked = await transaction.query<
        QueryResultRow & {
          community: string;
          issuer: string;
          audience: string;
          subject: string;
          pubkey: string;
          created_at: unknown;
        }
      >(
        `SELECT community, issuer, audience, subject, pubkey, created_at
         FROM beeline_identity_links
         WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4`,
        [ticket.community, ticket.issuer, ticket.audience, ticket.subject],
      );
      const linkRow = linked.rows[0];
      if (!linkRow) throw new Error('identity link transaction produced no mapping');
      if (linkRow.pubkey !== pubkey) return { status: 'conflict', existingPubkey: linkRow.pubkey };
      return {
        status: inserted.rowCount === 1 ? 'linked' : 'idempotent',
        link: {
          community: linkRow.community,
          issuer: linkRow.issuer,
          audience: linkRow.audience,
          subject: linkRow.subject,
          pubkey: linkRow.pubkey,
          createdAt: asDate(linkRow.created_at),
        },
      };
    });
  }

  async claimNip98Event(eventId: string, expiresAt: Date, now: Date): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await transaction.query(`DELETE FROM beeline_nip98_replays WHERE expires_at < $1`, [now]);
      const result = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_nip98_replays (event_id, expires_at)
         VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [eventId, expiresAt],
      );
      return result.rowCount === 1;
    });
  }

  async linksForPubkey(community: string, pubkey: string): Promise<IdentityLink[]> {
    const result = await this.database.query<
      QueryResultRow & {
        community: string;
        issuer: string;
        audience: string;
        subject: string;
        pubkey: string;
        created_at: unknown;
      }
    >(
      `SELECT community, issuer, audience, subject, pubkey, created_at
       FROM beeline_identity_links WHERE community = $1 AND pubkey = $2
       ORDER BY issuer, audience, subject`,
      [community, pubkey],
    );
    return result.rows.map((row) => ({
      community: row.community,
      issuer: row.issuer,
      audience: row.audience,
      subject: row.subject,
      pubkey: row.pubkey,
      createdAt: asDate(row.created_at),
    }));
  }

  async githubSubjectForPubkey(community: string, pubkey: string): Promise<string | null> {
    const result = await this.database.query<QueryResultRow & { subject: string }>(
      `SELECT subject FROM beeline_identity_links
       WHERE community = $1 AND pubkey = $2 AND issuer = 'https://github.com'
       ORDER BY created_at DESC LIMIT 1`,
      [community, pubkey],
    );
    return result.rows[0]?.subject ?? null;
  }

  async createGitHubInstallFlow(stateHash: string, flow: GitHubInstallFlow): Promise<void> {
    await this.database.query(`DELETE FROM beeline_github_install_flows WHERE expires_at < $1`, [
      flow.createdAt,
    ]);
    await this.database.query(
      `INSERT INTO beeline_github_install_flows
        (state_hash, community, pubkey, redirect_uri, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [stateHash, flow.community, flow.pubkey, flow.redirectUri, flow.createdAt, flow.expiresAt],
    );
  }

  async consumeGitHubInstallFlow(stateHash: string, now: Date): Promise<GitHubInstallFlow | null> {
    const result = await this.database.query<
      QueryResultRow & {
        community: string;
        pubkey: string;
        redirect_uri: string;
        created_at: unknown;
        expires_at: unknown;
      }
    >(
      `UPDATE beeline_github_install_flows SET consumed_at = $2
       WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at >= $2
       RETURNING community, pubkey, redirect_uri, created_at, expires_at`,
      [stateHash, now],
    );
    const row = result.rows[0];
    return row
      ? {
          community: row.community,
          pubkey: row.pubkey,
          redirectUri: row.redirect_uri,
          createdAt: asDate(row.created_at),
          expiresAt: asDate(row.expires_at),
        }
      : null;
  }

  async saveGitHubInstallation(installation: GitHubInstallation, now: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO beeline_github_installations
        (community, pubkey, account_id, account_login, account_type, account_avatar_url,
         installation_id, repository_selection, status, repository_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       ON CONFLICT (community, installation_id) DO UPDATE SET
         pubkey = EXCLUDED.pubkey,
         account_id = EXCLUDED.account_id,
         account_login = EXCLUDED.account_login,
         account_type = EXCLUDED.account_type,
         account_avatar_url = EXCLUDED.account_avatar_url,
         repository_selection = EXCLUDED.repository_selection,
         status = EXCLUDED.status,
         repository_count = EXCLUDED.repository_count,
         updated_at = EXCLUDED.updated_at`,
      [
        installation.community,
        installation.pubkey,
        installation.accountId,
        installation.accountLogin,
        installation.accountType,
        installation.accountAvatarUrl ?? null,
        installation.installationId,
        installation.repositorySelection,
        installation.status,
        installation.repositoryCount,
        now,
      ],
    );
  }

  async githubInstallationsForPubkey(
    community: string,
    pubkey: string,
  ): Promise<GitHubInstallation[]> {
    const result = await this.database.query<
      QueryResultRow & {
        account_id: string;
        account_login: string;
        account_type: string;
        account_avatar_url: string | null;
        installation_id: string | number;
        repository_selection: string;
        status: string;
        repository_count: number;
      }
    >(
      `SELECT account_id, account_login, account_type, account_avatar_url, installation_id,
              repository_selection, status, repository_count
       FROM beeline_github_installations
       WHERE community = $1 AND pubkey = $2
       ORDER BY lower(account_login), installation_id`,
      [community, pubkey],
    );
    return result.rows.map((row) => {
      const installationId = Number(row.installation_id);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw new Error('stored GitHub installation id is invalid');
      }
      if (row.account_type !== 'User' && row.account_type !== 'Organization') {
        throw new Error('stored GitHub account type is invalid');
      }
      if (row.repository_selection !== 'all' && row.repository_selection !== 'selected') {
        throw new Error('stored GitHub repository selection is invalid');
      }
      if (row.status !== 'active' && row.status !== 'revoked' && row.status !== 'suspended') {
        throw new Error('stored GitHub installation status is invalid');
      }
      return {
        community,
        pubkey,
        accountId: row.account_id,
        accountLogin: row.account_login,
        accountType: row.account_type,
        ...(row.account_avatar_url ? { accountAvatarUrl: row.account_avatar_url } : {}),
        installationId,
        repositorySelection: row.repository_selection,
        status: row.status,
        repositoryCount: row.repository_count,
      };
    });
  }

  async githubInstallationForPubkey(
    community: string,
    pubkey: string,
  ): Promise<GitHubInstallation | null> {
    return (await this.githubInstallationsForPubkey(community, pubkey))[0] ?? null;
  }

  async replaceGitHubRepositories(
    community: string,
    installationId: number,
    repositories: readonly StoredGitHubRepository[],
    now: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE beeline_github_repositories SET active = FALSE, updated_at = $3
         WHERE community = $1 AND installation_id = $2`,
        [community, installationId, now],
      );
      for (const repository of repositories) {
        await this.upsertGitHubRepository(transaction, community, repository, now);
      }
      await transaction.query(
        `UPDATE beeline_github_installations
         SET repository_count = $3, status = 'active', updated_at = $4
         WHERE community = $1 AND installation_id = $2`,
        [community, installationId, repositories.length, now],
      );
    });
  }

  private async upsertGitHubRepository(
    executor: SqlExecutor,
    community: string,
    repository: StoredGitHubRepository,
    now: Date,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO beeline_github_repositories
        (community, installation_id, repository_id, name, full_name, remote, default_branch, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
       ON CONFLICT (community, installation_id, repository_id) DO UPDATE SET
         name = EXCLUDED.name, full_name = EXCLUDED.full_name, remote = EXCLUDED.remote,
         default_branch = EXCLUDED.default_branch, active = TRUE, updated_at = EXCLUDED.updated_at`,
      [
        community,
        repository.installationId,
        repository.id,
        repository.name,
        repository.fullName,
        repository.remote,
        repository.defaultBranch,
        now,
      ],
    );
  }

  async applyGitHubRepositoryChanges(
    installationId: number,
    added: readonly StoredGitHubRepository[],
    removedIds: readonly number[],
    now: Date,
  ): Promise<void> {
    const installations = await this.database.query<QueryResultRow & { community: string }>(
      `SELECT community FROM beeline_github_installations WHERE installation_id = $1`,
      [installationId],
    );
    for (const { community } of installations.rows) {
      await this.database.transaction(async (transaction) => {
        for (const repository of added) {
          await this.upsertGitHubRepository(transaction, community, repository, now);
        }
        if (removedIds.length) {
          await transaction.query(
            `UPDATE beeline_github_repositories SET active = FALSE, updated_at = $3
             WHERE community = $1 AND installation_id = $2 AND repository_id = ANY($4::bigint[])`,
            [community, installationId, now, removedIds],
          );
        }
        await transaction.query(
          `UPDATE beeline_github_installations SET repository_count = (
             SELECT count(*)::integer FROM beeline_github_repositories
             WHERE community = $1 AND installation_id = $2 AND active = TRUE
           ), status = 'active', updated_at = $3
           WHERE community = $1 AND installation_id = $2`,
          [community, installationId, now],
        );
      });
    }
  }

  async markGitHubInstallationStatus(
    installationId: number,
    status: 'active' | 'revoked' | 'suspended',
    now: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE beeline_github_installations SET status = $2, updated_at = $3
         WHERE installation_id = $1`,
        [installationId, status, now],
      );
      if (status === 'revoked') {
        await transaction.query(
          `UPDATE beeline_github_repositories SET active = FALSE, updated_at = $2
           WHERE installation_id = $1`,
          [installationId, now],
        );
      }
    });
  }

  async githubRepositoriesForPubkey(
    community: string,
    pubkey: string,
  ): Promise<StoredGitHubRepository[]> {
    const result = await this.database.query<
      QueryResultRow & {
        repository_id: string | number;
        installation_id: string | number;
        name: string;
        full_name: string;
        remote: string;
        default_branch: string;
      }
    >(
      `SELECT r.repository_id, r.installation_id, r.name, r.full_name, r.remote, r.default_branch
       FROM beeline_github_repositories r
       JOIN beeline_github_installations i
         ON i.community = r.community AND i.installation_id = r.installation_id
       WHERE i.community = $1 AND i.pubkey = $2 AND i.status = 'active' AND r.active = TRUE
       ORDER BY lower(i.account_login), lower(r.name)`,
      [community, pubkey],
    );
    return result.rows.map((row) => ({
      id: Number(row.repository_id),
      installationId: Number(row.installation_id),
      name: row.name,
      fullName: row.full_name,
      remote: row.remote,
      defaultBranch: row.default_branch,
    }));
  }

  async githubRepositoryAccess(
    community: string,
    pubkey: string,
    fullName: string,
  ): Promise<{ accessible: boolean; installationId?: number; reason?: 'revoked' | 'not_granted' }> {
    const result = await this.database.query<
      QueryResultRow & { installation_id: string | number; status: string; active: boolean }
    >(
      `SELECT i.installation_id, i.status, COALESCE(r.active, FALSE) AS active
       FROM beeline_github_installations i
       LEFT JOIN beeline_github_repositories r
         ON r.community = i.community AND r.installation_id = i.installation_id
        AND lower(r.full_name) = lower($3)
       WHERE i.community = $1 AND i.pubkey = $2
         AND lower(split_part($3, '/', 1)) = lower(i.account_login)
       ORDER BY (i.status = 'active' AND COALESCE(r.active, FALSE)) DESC
       LIMIT 1`,
      [community, pubkey, fullName],
    );
    const row = result.rows[0];
    if (!row) return { accessible: false, reason: 'not_granted' };
    const installationId = Number(row.installation_id);
    return row.status === 'active' && row.active
      ? { accessible: true, installationId }
      : {
          accessible: false,
          installationId,
          reason: row.status === 'active' ? 'not_granted' : 'revoked',
        };
  }

  async claimGitHubWebhookDelivery(deliveryId: string, now: Date): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO beeline_github_webhook_deliveries (delivery_id, received_at)
       VALUES ($1, $2) ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, now],
    );
    return result.rowCount === 1;
  }

  async releaseGitHubWebhookDelivery(deliveryId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM beeline_github_webhook_deliveries WHERE delivery_id = $1`,
      [deliveryId],
    );
  }

  async saveGitHubUserToken(
    community: string,
    subject: string,
    encryptedToken: string,
    now: Date,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO beeline_github_user_tokens (community, subject, encrypted_token, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community, subject) DO UPDATE SET
         encrypted_token = EXCLUDED.encrypted_token, updated_at = EXCLUDED.updated_at`,
      [community, subject, encryptedToken, now],
    );
  }

  async githubUserToken(community: string, subject: string): Promise<string | null> {
    const result = await this.database.query<QueryResultRow & { encrypted_token: string }>(
      `SELECT encrypted_token FROM beeline_github_user_tokens
       WHERE community = $1 AND subject = $2`,
      [community, subject],
    );
    return result.rows[0]?.encrypted_token ?? null;
  }

  /** First-come-first-served claim: inserts, or reports the existing owner on conflict. */
  async claimNip05Name(
    name: string,
    pubkey: string,
    now: Date,
  ): Promise<'claimed' | 'idempotent' | 'taken'> {
    const inserted = await this.database.query<QueryResultRow>(
      `INSERT INTO beeline_nip05_names (name, pubkey, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [name, pubkey, now],
    );
    if (inserted.rowCount === 1) return 'claimed';
    const existing = await this.database.query<QueryResultRow & { pubkey: string }>(
      `SELECT pubkey FROM beeline_nip05_names WHERE name = $1`,
      [name],
    );
    return existing.rows[0]?.pubkey === pubkey ? 'idempotent' : 'taken';
  }

  async resolveNip05Name(name: string): Promise<string | null> {
    const result = await this.database.query<QueryResultRow & { pubkey: string }>(
      `SELECT pubkey FROM beeline_nip05_names WHERE name = $1`,
      [name],
    );
    return result.rows[0]?.pubkey ?? null;
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
