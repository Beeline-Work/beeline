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
