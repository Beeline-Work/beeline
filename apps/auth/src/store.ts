import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/** How long a stored repository event remains fetchable by a late daemon. */
export const GITHUB_REPO_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

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
  `ALTER TABLE beeline_oidc_flows ADD COLUMN IF NOT EXISTS device_code_hash CHAR(64)`,
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
    bound_pubkey CHAR(64),
    recovery_eligible BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `ALTER TABLE beeline_bind_tickets ADD COLUMN IF NOT EXISTS recovery_eligible BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE beeline_bind_tickets ADD COLUMN IF NOT EXISTS provider_login TEXT`,
  `ALTER TABLE beeline_bind_tickets ADD COLUMN IF NOT EXISTS provider_display_name TEXT`,
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
  `DELETE FROM beeline_identity_links AS legacy
   USING beeline_identity_links AS canonical
   WHERE legacy.community=canonical.community
     AND legacy.issuer='https://github.com'
     AND canonical.issuer=legacy.issuer
     AND legacy.subject=canonical.subject
     AND legacy.audience<>'github'
     AND canonical.audience='github'`,
  `UPDATE beeline_identity_links SET audience='github'
   WHERE issuer='https://github.com' AND audience<>'github'`,
  `CREATE INDEX IF NOT EXISTS beeline_identity_links_pubkey_idx
    ON beeline_identity_links (community, pubkey)`,
  `CREATE TABLE IF NOT EXISTS beeline_key_successions (
    community TEXT NOT NULL,
    issuer TEXT NOT NULL,
    audience TEXT NOT NULL,
    subject TEXT NOT NULL,
    old_pubkey CHAR(64) NOT NULL,
    new_pubkey CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, issuer, audience, subject, old_pubkey),
    CHECK (old_pubkey ~ '^[0-9a-f]{64}$'),
    CHECK (new_pubkey ~ '^[0-9a-f]{64}$')
  )`,
  `DELETE FROM beeline_key_successions AS legacy
   USING beeline_key_successions AS canonical
   WHERE legacy.community=canonical.community
     AND legacy.issuer='https://github.com'
     AND canonical.issuer=legacy.issuer
     AND legacy.subject=canonical.subject
     AND legacy.old_pubkey=canonical.old_pubkey
     AND legacy.audience<>'github'
     AND canonical.audience='github'`,
  `UPDATE beeline_key_successions SET audience='github'
   WHERE issuer='https://github.com' AND audience<>'github'`,
  `CREATE INDEX IF NOT EXISTS beeline_key_successions_new_idx
    ON beeline_key_successions (community, new_pubkey)`,
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
  `CREATE TABLE IF NOT EXISTS beeline_agent_connect_devices (
    device_code_hash CHAR(64) PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    code_challenge CHAR(64) NOT NULL,
    tenant_community TEXT NOT NULL,
    harness TEXT NOT NULL,
    provider TEXT,
    model TEXT NOT NULL,
    soul TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    sealed_credentials TEXT,
    pairing_token_hash CHAR(64),
    workspace_id UUID,
    paired_by BYTEA,
    agent_pubkey BYTEA,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    CHECK (code_challenge ~ '^[0-9a-f]{64}$'),
    CHECK (pairing_token_hash IS NULL OR pairing_token_hash ~ '^[0-9a-f]{64}$')
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_agent_connect_devices_expiry_idx
    ON beeline_agent_connect_devices (expires_at)`,
  `CREATE TABLE IF NOT EXISTS beeline_agent_connect_grants (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    community_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    minter_pubkey BYTEA NOT NULL,
    agent_pubkey BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS beeline_identity_handles (
    community TEXT NOT NULL,
    pubkey CHAR(64) NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('key', 'github')),
    github_subject TEXT,
    github_login TEXT,
    github_rename_available BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, pubkey),
    CHECK (pubkey ~ '^[0-9a-f]{64}$')
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_identity_handles_handle_idx
    ON beeline_identity_handles (community, handle)`,
  `CREATE TABLE IF NOT EXISTS beeline_github_handle_reservations (
    community TEXT NOT NULL,
    subject TEXT NOT NULL,
    handle TEXT NOT NULL,
    pubkey CHAR(64) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, subject),
    UNIQUE (community, handle),
    CHECK (pubkey ~ '^[0-9a-f]{64}$')
  )`,
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
    authorized_subject TEXT,
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
  `ALTER TABLE beeline_github_installations ADD COLUMN IF NOT EXISTS authorized_subject TEXT`,
  `UPDATE beeline_github_installations AS installation
   SET authorized_subject = (
     SELECT link.subject FROM beeline_identity_links AS link
     WHERE link.community = installation.community
       AND link.pubkey = installation.pubkey
       AND link.issuer = 'https://github.com'
     ORDER BY link.created_at DESC LIMIT 1
   )
   WHERE installation.authorized_subject IS NULL
     AND EXISTS (
       SELECT 1 FROM beeline_identity_links AS link
       WHERE link.community = installation.community
         AND link.pubkey = installation.pubkey
         AND link.issuer = 'https://github.com'
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
  `CREATE TABLE IF NOT EXISTS beeline_github_repository_aliases (
    community TEXT NOT NULL,
    alias_full_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS beeline_github_repository_aliases_idx
    ON beeline_github_repository_aliases (community, lower(alias_full_name))`,
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
  `ALTER TABLE beeline_github_user_tokens ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS beeline_github_installation_reconciliations (
    community TEXT NOT NULL,
    subject TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, subject)
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_github_install_flows_expiry_idx
    ON beeline_github_install_flows (expires_at)`,
  `CREATE TABLE IF NOT EXISTS beeline_github_repo_events (
    id BIGSERIAL PRIMARY KEY,
    full_name TEXT NOT NULL,
    delivery_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    number INTEGER,
    title TEXT,
    url TEXT,
    summary TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_github_repo_events_name_idx
    ON beeline_github_repo_events (full_name, id)`,
  `CREATE INDEX IF NOT EXISTS beeline_github_repo_events_received_idx
    ON beeline_github_repo_events (received_at)`,
  `CREATE TABLE IF NOT EXISTS beeline_github_room_link_requests (
    community TEXT NOT NULL,
    room_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    requested_by CHAR(64) NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ,
    PRIMARY KEY (community, room_id),
    CHECK (requested_by ~ '^[0-9a-f]{64}$')
  )`,
  `CREATE INDEX IF NOT EXISTS beeline_github_room_link_requests_name_idx
    ON beeline_github_room_link_requests (community, lower(full_name))
    WHERE activated_at IS NULL`,
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
  device_code_hash: string | null;
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
  deviceCodeHash?: string | null;
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
  recovery_eligible: boolean;
  provider_login: string | null;
  provider_display_name: string | null;
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
  providerLogin?: string | null;
  providerDisplayName?: string | null;
}

export interface ManagedIdentity {
  handle: string;
  displayName: string;
  nip05: string;
  source: 'key' | 'github';
  githubLogin?: string;
  githubRenameAvailable: boolean;
}

export type ClaimManagedHandleResult =
  | { status: 'claimed' | 'idempotent'; identity: ManagedIdentity }
  | { status: 'taken' | 'already_assigned' };

export interface IdentityLink {
  community: string;
  issuer: string;
  audience: string;
  subject: string;
  pubkey: string;
  createdAt: Date;
}

export interface AgentConnectDevice {
  deviceCodeHash: string;
  userCode: string;
  codeChallenge: string;
  tenantCommunity: string;
  harness: string;
  provider?: string;
  model: string;
  soul: string;
  agentName: string;
  sealedCredentials?: string;
  pairingTokenHash?: string;
  workspaceId?: string;
  pairedBy?: string;
  agentPubkey?: string;
  createdAt: Date;
  expiresAt: Date;
  approvedAt?: Date;
  consumedAt?: Date;
}

interface AgentConnectDeviceRow extends QueryResultRow {
  device_code_hash: string;
  user_code: string;
  code_challenge: string;
  tenant_community: string;
  harness: string;
  provider: string | null;
  model: string;
  soul: string;
  agent_name: string;
  sealed_credentials: string | null;
  pairing_token_hash: string | null;
  workspace_id: string | null;
  paired_by: Uint8Array | null;
  agent_pubkey: Uint8Array | null;
  created_at: unknown;
  expires_at: unknown;
  approved_at: unknown | null;
  consumed_at: unknown | null;
}

function agentConnectDeviceFromRow(row: AgentConnectDeviceRow): AgentConnectDevice {
  return {
    deviceCodeHash: row.device_code_hash,
    userCode: row.user_code,
    codeChallenge: row.code_challenge,
    tenantCommunity: row.tenant_community,
    harness: row.harness,
    ...(row.provider ? { provider: row.provider } : {}),
    model: row.model,
    soul: row.soul,
    agentName: row.agent_name,
    ...(row.sealed_credentials ? { sealedCredentials: row.sealed_credentials } : {}),
    ...(row.pairing_token_hash ? { pairingTokenHash: row.pairing_token_hash } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.paired_by ? { pairedBy: Buffer.from(row.paired_by).toString('hex') } : {}),
    ...(row.agent_pubkey ? { agentPubkey: Buffer.from(row.agent_pubkey).toString('hex') } : {}),
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
    ...(row.approved_at ? { approvedAt: asDate(row.approved_at) } : {}),
    ...(row.consumed_at ? { consumedAt: asDate(row.consumed_at) } : {}),
  };
}

/**
 * One recorded device-key replacement: the identity's authority moved from
 * `oldPubkey` to `newPubkey`. Multiple rows chain (A→B, B→C); a key's current
 * successor is found by walking rows forward.
 */
export interface KeySuccession {
  community: string;
  issuer: string;
  audience: string;
  subject: string;
  oldPubkey: string;
  newPubkey: string;
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
  authorizedSubject: string | null;
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

export interface GitHubRepositoryAccess {
  accessible: boolean;
  installationId?: number;
  repositoryId?: number;
  reason?: 'revoked' | 'not_granted';
  /** Set when the requested name resolved onto the repository's current location. */
  resolvedFullName?: string;
}

interface GitHubRepositoryAccessRow extends GitHubRepositoryAccess {
  /** The matched repository's current full_name, when a repository row matched. */
  fullName?: string;
}

/** One Room's repository binding waiting for the repository owner's App grant. */
export interface GitHubRoomLinkRequest {
  community: string;
  roomId: string;
  fullName: string;
  requestedBy: string;
  requestedAt: Date;
  activatedAt?: Date;
}

export type BindResult =
  | { status: 'linked' | 'idempotent'; link: IdentityLink }
  | { status: 'conflict'; existingPubkey: string }
  | { status: 'missing' | 'used' | 'expired' };

export type PhoneTicketExchangeResult =
  | { status: 'exchanged'; ticket: BindTicket }
  | { status: 'missing' | 'used' | 'expired' | 'wrong_provider' };

export type RecoverBindResult =
  | { status: 'replaced' | 'idempotent'; link: IdentityLink; previousPubkey: string }
  | { status: 'missing' | 'unused' | 'not_eligible' | 'wrong_key' | 'expired' };

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
    deviceCodeHash: row.device_code_hash,
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
    providerLogin: row.provider_login,
    providerDisplayName: row.provider_display_name,
  };
}

interface ManagedIdentityRow extends QueryResultRow {
  handle: string;
  display_name: string;
  source: 'key' | 'github';
  github_login: string | null;
  github_rename_available: boolean;
}

function managedIdentityFromRow(row: ManagedIdentityRow): ManagedIdentity {
  return {
    handle: row.handle,
    displayName: row.display_name,
    nip05: `${row.handle}@usebeeline.app`,
    source: row.source,
    ...(row.github_login ? { githubLogin: row.github_login } : {}),
    githubRenameAvailable: row.github_rename_available,
  };
}

export class AuthStore {
  constructor(private readonly database: TransactionalDatabase) {}

  /**
   * Resolve the relay's authoritative tenant stamp for a Room.
   *
   * The similarly named `community` tag on kind:9007 is client-authored
   * application metadata. Buzz stamps `channels.community_id` from the
   * request Host and treats that SQL column as the tenancy boundary.
   */
  async relayCommunityIdForRoom(roomId: string): Promise<string | null> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)
    ) {
      return null;
    }
    const result = await this.database.query<QueryResultRow & { community_id: string }>(
      `SELECT community_id::text AS community_id
       FROM channels
       WHERE id = $1::uuid AND deleted_at IS NULL
       LIMIT 1`,
      [roomId],
    );
    return result.rows[0]?.community_id ?? null;
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) await this.database.query(migration);
  }

  async createFlow(stateHash: string, flow: OidcFlow): Promise<void> {
    await this.database.query(`DELETE FROM beeline_oidc_flows WHERE expires_at < $1`, [
      flow.createdAt,
    ]);
    await this.database.query(
      `INSERT INTO beeline_oidc_flows
        (state_hash, community, issuer, audience, nonce, pkce_verifier, browser_session_hash, redirect_uri, app_redirect_uri, app_state, device_code_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
        flow.deviceCodeHash ?? null,
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
       RETURNING community, issuer, audience, nonce, pkce_verifier, browser_session_hash, redirect_uri, app_redirect_uri, app_state, device_code_hash, created_at, expires_at`,
      [stateHash, browserSessionHash, now],
    );
    return result.rows[0] ? flowFromRow(result.rows[0]) : null;
  }

  async identityLinkForSubject(
    community: string,
    issuer: string,
    audience: string,
    subject: string,
  ): Promise<IdentityLink | null> {
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
       FROM beeline_identity_links
       WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4
       LIMIT 1`,
      [community, issuer, audience, subject],
    );
    const row = result.rows[0];
    return row
      ? {
          community: row.community,
          issuer: row.issuer,
          audience: row.audience,
          subject: row.subject,
          pubkey: row.pubkey,
          createdAt: asDate(row.created_at),
        }
      : null;
  }

  async latestWorkspaceForMember(
    memberPubkey: string,
    relayCommunityIds: readonly string[],
  ): Promise<{ workspaceId: string; name: string } | null> {
    if (!/^[0-9a-f]{64}$/.test(memberPubkey) || relayCommunityIds.length === 0) return null;
    const result = await this.database.query<
      QueryResultRow & { workspace_id: string; name: string }
    >(
      `SELECT workspace.id::text AS workspace_id, workspace.name
       FROM channels workspace
       JOIN channel_members member
         ON member.community_id = workspace.community_id
        AND member.channel_id = workspace.id
        AND member.pubkey = decode($1, 'hex')
        AND member.removed_at IS NULL
       JOIN LATERAL (
         SELECT event.tags FROM events event
         WHERE event.community_id = workspace.community_id
           AND event.channel_id = workspace.id
           AND event.kind = 9007
           AND event.deleted_at IS NULL
         ORDER BY event.created_at ASC, event.id ASC LIMIT 1
       ) genesis ON EXISTS (
         SELECT 1 FROM jsonb_array_elements(genesis.tags) tag
         WHERE tag->>0 = 'community' AND tag->>1 = workspace.id::text
       )
       WHERE workspace.community_id = ANY($2::uuid[])
         AND workspace.deleted_at IS NULL
         AND workspace.archived_at IS NULL
       ORDER BY workspace.updated_at DESC, workspace.id ASC
       LIMIT 1`,
      [memberPubkey, relayCommunityIds],
    );
    const row = result.rows[0];
    return row ? { workspaceId: row.workspace_id, name: row.name } : null;
  }

  async createAgentConnectDevice(device: AgentConnectDevice): Promise<void> {
    await this.database.query(`DELETE FROM beeline_agent_connect_devices WHERE expires_at < $1`, [
      device.createdAt,
    ]);
    await this.database.query(
      `INSERT INTO beeline_agent_connect_devices (
         device_code_hash, user_code, code_challenge, tenant_community,
         harness, provider, model, soul, agent_name, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        device.deviceCodeHash,
        device.userCode,
        device.codeChallenge,
        device.tenantCommunity,
        device.harness,
        device.provider ?? null,
        device.model,
        device.soul,
        device.agentName,
        device.createdAt,
        device.expiresAt,
      ],
    );
  }

  async findAgentConnectDeviceByUserCode(userCode: string): Promise<AgentConnectDevice | null> {
    const result = await this.database.query<AgentConnectDeviceRow>(
      `SELECT device_code_hash, user_code, code_challenge, tenant_community,
              harness, provider, model, soul, agent_name, sealed_credentials,
              pairing_token_hash, workspace_id, paired_by, agent_pubkey,
              created_at, expires_at, approved_at, consumed_at
       FROM beeline_agent_connect_devices WHERE user_code = $1`,
      [userCode],
    );
    return result.rows[0] ? agentConnectDeviceFromRow(result.rows[0]) : null;
  }

  async findAgentConnectDevice(deviceCodeHash: string): Promise<AgentConnectDevice | null> {
    const result = await this.database.query<AgentConnectDeviceRow>(
      `SELECT device_code_hash, user_code, code_challenge, tenant_community,
              harness, provider, model, soul, agent_name, sealed_credentials,
              pairing_token_hash, workspace_id, paired_by, agent_pubkey,
              created_at, expires_at, approved_at, consumed_at
       FROM beeline_agent_connect_devices WHERE device_code_hash = $1`,
      [deviceCodeHash],
    );
    return result.rows[0] ? agentConnectDeviceFromRow(result.rows[0]) : null;
  }

  async approveAgentConnectDevice(input: {
    deviceCodeHash: string;
    workspaceId: string;
    pairedBy: string;
    agentPubkey: string;
    pairingTokenHash: string;
    sealedCredentials: string;
    now: Date;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const approved = await transaction.query<QueryResultRow>(
        `UPDATE beeline_agent_connect_devices
         SET workspace_id = $2::uuid,
             paired_by = decode($3, 'hex'),
             agent_pubkey = decode($4, 'hex'),
             pairing_token_hash = $5,
             sealed_credentials = $6,
             approved_at = $7
         WHERE device_code_hash = $1
           AND approved_at IS NULL
           AND consumed_at IS NULL
           AND expires_at >= $7
         RETURNING device_code_hash`,
        [
          input.deviceCodeHash,
          input.workspaceId,
          input.pairedBy,
          input.agentPubkey,
          input.pairingTokenHash,
          input.sealedCredentials,
          input.now,
        ],
      );
      if (approved.rowCount !== 1) return false;
      const grant = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_agent_connect_grants (
           token_hash, community_id, workspace_id, minter_pubkey, agent_pubkey,
           expires_at, created_at
         )
         SELECT pairing_token_hash, workspace.community_id, workspace_id,
                paired_by, agent_pubkey, expires_at, $2
         FROM beeline_agent_connect_devices device
         JOIN channels workspace ON workspace.id = device.workspace_id
         WHERE device.device_code_hash = $1
         RETURNING token_hash`,
        [input.deviceCodeHash, input.now],
      );
      if (grant.rowCount !== 1) throw new Error('device approval did not create a pairing grant');
      return true;
    });
  }

  async consumeAgentConnectDevice(
    deviceCodeHash: string,
    now: Date,
  ): Promise<AgentConnectDevice | null> {
    const result = await this.database.query<AgentConnectDeviceRow>(
      `UPDATE beeline_agent_connect_devices
       SET consumed_at = $2
       WHERE device_code_hash = $1
         AND approved_at IS NOT NULL
         AND consumed_at IS NULL
         AND expires_at >= $2
       RETURNING device_code_hash, user_code, code_challenge, tenant_community,
                 harness, provider, model, soul, agent_name, sealed_credentials,
                 pairing_token_hash, workspace_id, paired_by, agent_pubkey,
                 created_at, expires_at, approved_at, consumed_at`,
      [deviceCodeHash, now],
    );
    return result.rows[0] ? agentConnectDeviceFromRow(result.rows[0]) : null;
  }

  async createTicket(ticketHash: string, ticket: BindTicket): Promise<void> {
    await this.database.query(`DELETE FROM beeline_bind_tickets WHERE expires_at < $1`, [
      ticket.createdAt,
    ]);
    await this.database.query(
      `INSERT INTO beeline_bind_tickets
        (ticket_hash, challenge, community, issuer, audience, subject, created_at, expires_at,
         provider_login, provider_display_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ticketHash,
        ticket.challenge,
        ticket.community,
        ticket.issuer,
        ticket.audience,
        ticket.subject,
        ticket.createdAt,
        ticket.expiresAt,
        ticket.providerLogin ?? null,
        ticket.providerDisplayName ?? null,
      ],
    );
  }

  async findTicket(ticketHash: string): Promise<BindTicket | null> {
    const result = await this.database.query<TicketRow>(
      `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey, recovery_eligible, provider_login, provider_display_name
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

  /** Atomically consume the same short-lived GitHub proof used by the legacy key bind. */
  async consumeTicketForPhone(
    ticketHash: string,
    community: string,
    now: Date,
  ): Promise<PhoneTicketExchangeResult> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at,
                attempt_count, consumed_at, bound_pubkey, recovery_eligible,
                provider_login, provider_display_name
         FROM beeline_bind_tickets WHERE ticket_hash = $1 FOR UPDATE`,
        [ticketHash],
      );
      const row = selected.rows[0];
      if (!row) return { status: 'missing' };
      const ticket = ticketFromRow(row);
      if (ticket.consumedAt) return { status: 'used' };
      if (ticket.expiresAt.getTime() < now.getTime()) return { status: 'expired' };
      if (ticket.community !== community || ticket.issuer !== 'https://github.com') {
        return { status: 'wrong_provider' };
      }
      await transaction.query(
        `UPDATE beeline_bind_tickets SET consumed_at = $2 WHERE ticket_hash = $1`,
        [ticketHash, now],
      );
      return { status: 'exchanged', ticket };
    });
  }

  async consumeTicketAndLink(ticketHash: string, pubkey: string, now: Date): Promise<BindResult> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey, recovery_eligible, provider_login, provider_display_name
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
      if (linkRow.pubkey !== pubkey) {
        await transaction.query(
          `UPDATE beeline_bind_tickets SET recovery_eligible = TRUE WHERE ticket_hash = $1`,
          [ticketHash],
        );
        return { status: 'conflict', existingPubkey: linkRow.pubkey };
      }
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

  /**
   * Replace a conflicting link only after the normal bind path has consumed
   * this exact OAuth-backed ticket for this exact candidate key.
   */
  async recoverConsumedTicketLink(
    ticketHash: string,
    pubkey: string,
    now: Date,
  ): Promise<RecoverBindResult> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<TicketRow>(
        `SELECT challenge, community, issuer, audience, subject, created_at, expires_at, attempt_count, consumed_at, bound_pubkey, recovery_eligible, provider_login, provider_display_name
         FROM beeline_bind_tickets WHERE ticket_hash = $1 FOR UPDATE`,
        [ticketHash],
      );
      const row = selected.rows[0];
      if (!row) return { status: 'missing' };
      const ticket = ticketFromRow(row);
      if (ticket.expiresAt.getTime() < now.getTime()) return { status: 'expired' };
      if (!ticket.consumedAt) return { status: 'unused' };
      if (!row.recovery_eligible) return { status: 'not_eligible' };
      if (ticket.boundPubkey !== pubkey) return { status: 'wrong_key' };

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
         WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4
         FOR UPDATE`,
        [ticket.community, ticket.issuer, ticket.audience, ticket.subject],
      );
      const existing = linked.rows[0];
      if (!existing) return { status: 'missing' };
      const previousPubkey = existing.pubkey;
      if (previousPubkey !== pubkey) {
        await transaction.query(
          `UPDATE beeline_identity_links
           SET pubkey = $5, created_at = $6
           WHERE community = $1 AND issuer = $2 AND audience = $3 AND subject = $4`,
          [ticket.community, ticket.issuer, ticket.audience, ticket.subject, pubkey, now],
        );
        // Succession ledger: the old key authored rooms/bindings/approvals as
        // this identity, and chain-aware authority must keep honoring it
        // THROUGH the new key. Recorded in the same transaction as the link
        // update so the ledger can never disagree with the link. Replacing
        // from the same old key twice is idempotent (upsert keeps the latest
        // successor).
        await transaction.query(
          `INSERT INTO beeline_key_successions
            (community, issuer, audience, subject, old_pubkey, new_pubkey, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (community, issuer, audience, subject, old_pubkey)
           DO UPDATE SET new_pubkey = EXCLUDED.new_pubkey, created_at = EXCLUDED.created_at`,
          [
            ticket.community,
            ticket.issuer,
            ticket.audience,
            ticket.subject,
            previousPubkey,
            pubkey,
            now,
          ],
        );
      }
      return {
        status: previousPubkey === pubkey ? 'idempotent' : 'replaced',
        previousPubkey,
        link: {
          community: existing.community,
          issuer: existing.issuer,
          audience: existing.audience,
          subject: existing.subject,
          pubkey,
          createdAt: previousPubkey === pubkey ? asDate(existing.created_at) : now,
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

  /**
   * Walk the succession chain forward from `pubkey` to the CURRENT key of its
   * identity. A key with no recorded succession resolves to itself. Cycle-
   * safe (a chain can only grow by replacing the current link key, so cycles
   * are not reachable through the recovery flow, but the walk refuses to
   * loop forever on corrupt data).
   */
  async resolveCurrentPubkey(community: string, pubkey: string): Promise<string> {
    let current = pubkey;
    const visited = new Set<string>([current]);
    for (;;) {
      const result = await this.database.query<QueryResultRow & { new_pubkey: string }>(
        `SELECT new_pubkey FROM beeline_key_successions
         WHERE community = $1 AND old_pubkey = $2
         ORDER BY created_at DESC LIMIT 1`,
        [community, current],
      );
      const next = result.rows[0]?.new_pubkey;
      if (!next || visited.has(next)) return current;
      visited.add(next);
      current = next;
    }
  }

  /**
   * The one succession-aware equality check: two pubkeys name the same
   * Beeline identity when they resolve to the same current key. Every
   * "is this pubkey the authorized owner" comparison goes through here (or
   * through {@link resolveCurrentPubkey}) so succession semantics live in
   * exactly one place.
   */
  async sameIdentity(community: string, a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const [resolvedA, resolvedB] = await Promise.all([
      this.resolveCurrentPubkey(community, a),
      this.resolveCurrentPubkey(community, b),
    ]);
    return resolvedA === resolvedB;
  }

  /**
   * The keys that previously held THIS key's identity, oldest first — the
   * chain a successor client walks to rediscover its predecessor's Workspaces.
   * Only ever served to the key itself (the route checks the NIP-98 signer).
   */
  async successionPredecessors(community: string, pubkey: string): Promise<string[]> {
    const predecessors: string[] = [];
    const visited = new Set<string>([pubkey]);
    let current = pubkey;
    for (;;) {
      const result = await this.database.query<QueryResultRow & { old_pubkey: string }>(
        `SELECT old_pubkey FROM beeline_key_successions
         WHERE community = $1 AND new_pubkey = $2
         ORDER BY created_at DESC LIMIT 1`,
        [community, current],
      );
      const previous = result.rows[0]?.old_pubkey;
      if (!previous || visited.has(previous)) break;
      visited.add(previous);
      predecessors.unshift(previous);
      current = previous;
    }
    return predecessors;
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

  async saveGitHubInstallation(installation: GitHubInstallation, now: Date): Promise<boolean> {
    return this.upsertGitHubInstallation(this.database, installation, now);
  }

  private async upsertGitHubInstallation(
    executor: SqlExecutor,
    installation: GitHubInstallation,
    now: Date,
  ): Promise<boolean> {
    const result = await executor.query<QueryResultRow>(
      `INSERT INTO beeline_github_installations
        (community, pubkey, authorized_subject, account_id, account_login, account_type, account_avatar_url,
         installation_id, repository_selection, status, repository_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       ON CONFLICT (community, installation_id) DO UPDATE SET
         pubkey = EXCLUDED.pubkey,
         authorized_subject = EXCLUDED.authorized_subject,
         account_id = EXCLUDED.account_id,
         account_login = EXCLUDED.account_login,
         account_type = EXCLUDED.account_type,
         account_avatar_url = EXCLUDED.account_avatar_url,
         repository_selection = EXCLUDED.repository_selection,
         status = EXCLUDED.status,
         repository_count = EXCLUDED.repository_count,
         updated_at = EXCLUDED.updated_at
       WHERE beeline_github_installations.authorized_subject = EXCLUDED.authorized_subject
          OR (beeline_github_installations.authorized_subject IS NULL
              AND beeline_github_installations.account_type = 'User'
              AND beeline_github_installations.account_id = EXCLUDED.authorized_subject)
       RETURNING installation_id`,
      [
        installation.community,
        installation.pubkey,
        installation.authorizedSubject,
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
    return result.rowCount === 1;
  }

  async githubInstallationsForPubkey(
    community: string,
    pubkey: string,
  ): Promise<GitHubInstallation[]> {
    const result = await this.database.query<
      QueryResultRow & {
        account_id: string;
        authorized_subject: string | null;
        account_login: string;
        account_type: string;
        account_avatar_url: string | null;
        installation_id: string | number;
        repository_selection: string;
        status: string;
        repository_count: number;
      }
    >(
      `SELECT pubkey, authorized_subject, account_id, account_login, account_type, account_avatar_url, installation_id,
              repository_selection, status, repository_count
       FROM beeline_github_installations
       WHERE community = $1 AND pubkey = $2
       ORDER BY lower(account_login), installation_id`,
      [community, pubkey],
    );
    return result.rows.map((row) => this.#gitHubInstallationRow(community, row));
  }

  #gitHubInstallationRow(community: string, row: QueryResultRow): GitHubInstallation {
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
      pubkey: String(row.pubkey),
      authorizedSubject: row.authorized_subject as string | null,
      accountId: String(row.account_id),
      accountLogin: String(row.account_login),
      accountType: row.account_type as 'User' | 'Organization',
      ...(row.account_avatar_url ? { accountAvatarUrl: String(row.account_avatar_url) } : {}),
      installationId,
      repositorySelection: row.repository_selection as 'all' | 'selected',
      status: row.status as 'active' | 'revoked' | 'suspended',
      repositoryCount: Number(row.repository_count),
    };
  }

  /** One recorded installation by id within a Workspace, regardless of owner. */
  async githubInstallation(
    community: string,
    installationId: number,
  ): Promise<GitHubInstallation | null> {
    const result = await this.database.query<QueryResultRow & { pubkey: string }>(
      `SELECT pubkey, authorized_subject, account_id, account_login, account_type, account_avatar_url,
              installation_id, repository_selection, status, repository_count
       FROM beeline_github_installations
       WHERE community = $1 AND installation_id = $2`,
      [community, installationId],
    );
    const row = result.rows[0];
    return row ? this.#gitHubInstallationRow(community, row) : null;
  }

  /** Whether any ACTIVE recorded installation in the Workspace covers an account login. */
  async githubActiveInstallationCoversAccount(community: string, login: string): Promise<boolean> {
    const result = await this.database.query<QueryResultRow>(
      `SELECT 1 AS covered FROM beeline_github_installations
       WHERE community = $1 AND lower(account_login) = lower($2) AND status = 'active'
       LIMIT 1`,
      [community, login],
    );
    return result.rows.length > 0;
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
      await this.replaceGitHubRepositoriesInTransaction(
        transaction,
        community,
        installationId,
        repositories,
        now,
      );
    });
  }

  async replaceGitHubInstallationSnapshot(
    installation: GitHubInstallation,
    repositories: readonly StoredGitHubRepository[],
    now: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.upsertGitHubInstallation(transaction, installation, now))) return false;
      await this.replaceGitHubRepositoriesInTransaction(
        transaction,
        installation.community,
        installation.installationId,
        repositories,
        now,
      );
      return true;
    });
  }

  private async replaceGitHubRepositoriesInTransaction(
    transaction: SqlExecutor,
    community: string,
    installationId: number,
    repositories: readonly StoredGitHubRepository[],
    now: Date,
  ): Promise<void> {
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

  /** A stored alias maps a Room binding's pre-transfer owner/repo to its current location. */
  async githubRepositoryAlias(community: string, alias: string): Promise<string | null> {
    const result = await this.database.query<QueryResultRow & { full_name: string }>(
      `SELECT full_name FROM beeline_github_repository_aliases
       WHERE community = $1 AND lower(alias_full_name) = lower($2)`,
      [community, alias],
    );
    return result.rows[0]?.full_name ?? null;
  }

  async saveGitHubRepositoryAlias(
    community: string,
    alias: string,
    fullName: string,
    now: Date,
  ): Promise<void> {
    if (alias.toLowerCase() === fullName.toLowerCase()) return;
    await this.database.query(
      `INSERT INTO beeline_github_repository_aliases
        (community, alias_full_name, full_name, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community, lower(alias_full_name)) DO UPDATE SET
         full_name = EXCLUDED.full_name, updated_at = EXCLUDED.updated_at`,
      [community, alias, fullName, now],
    );
  }

  /** The repository id a (possibly stale) full_name was last listed under, active or not. */
  private async storedGitHubRepositoryIdForName(
    community: string,
    fullName: string,
  ): Promise<number | undefined> {
    const result = await this.database.query<QueryResultRow & { repository_id: string | number }>(
      `SELECT repository_id FROM beeline_github_repositories
       WHERE community = $1 AND lower(full_name) = lower($2)
       ORDER BY updated_at DESC LIMIT 1`,
      [community, fullName],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const repositoryId = Number(row.repository_id);
    return Number.isSafeInteger(repositoryId) && repositoryId > 0 ? repositoryId : undefined;
  }

  /** One installation-joined repository lookup; `condition`/`values` select the repository. */
  private async gitHubRepositoryAccessRow(
    condition: string,
    values: unknown[],
  ): Promise<GitHubRepositoryAccessRow | null> {
    const result = await this.database.query<
      QueryResultRow & {
        installation_id: string | number;
        repository_id: string | number | null;
        status: string;
        active: boolean;
        full_name: string | null;
      }
    >(
      `SELECT i.installation_id, r.repository_id, i.status, COALESCE(r.active, FALSE) AS active, r.full_name
       FROM beeline_github_installations i
       LEFT JOIN beeline_github_repositories r
         ON r.community = i.community AND r.installation_id = i.installation_id
       WHERE i.community = $1 AND i.pubkey = $2 ${condition}
       ORDER BY (i.status = 'active' AND COALESCE(r.active, FALSE)) DESC, r.updated_at DESC NULLS LAST
       LIMIT 1`,
      values,
    );
    const row = result.rows[0];
    if (!row) return null;
    const installationId = Number(row.installation_id);
    const repositoryId = Number(row.repository_id);
    const fullName = typeof row.full_name === 'string' ? row.full_name : undefined;
    if (row.status === 'active' && row.active) {
      return { accessible: true, installationId, repositoryId, fullName };
    }
    return {
      accessible: false,
      installationId,
      reason: row.status === 'active' ? 'not_granted' : 'revoked',
    };
  }

  async githubRepositoryAccess(
    community: string,
    pubkey: string,
    fullName: string,
  ): Promise<GitHubRepositoryAccess> {
    const exact = await this.gitHubRepositoryAccessRow(
      `AND lower(r.full_name) = lower($3)
       AND lower(split_part($3, '/', 1)) = lower(i.account_login)`,
      [community, pubkey, fullName],
    );
    if (exact?.accessible || exact?.reason === 'revoked') return exact;
    // A transferred or renamed repository keeps its immutable GitHub id, and
    // the installation snapshot deactivates stale full_name rows instead of
    // deleting them — so a Room binding that predates a transfer still
    // resolves onto the repository's current name without re-binding.
    const priorId = await this.storedGitHubRepositoryIdForName(community, fullName);
    if (priorId !== undefined) {
      const healed = await this.gitHubRepositoryAccessRow(`AND r.repository_id = $3::bigint`, [
        community,
        pubkey,
        priorId,
      ]);
      if (healed?.accessible) return { ...healed, resolvedFullName: healed.fullName };
    }
    return exact ?? { accessible: false, reason: 'not_granted' };
  }

  /**
   * Record that a Room's admin-authored repository binding names a repository
   * the GitHub App does not cover yet, so the link can complete automatically
   * once the repository owner grants access.
   *
   * A Room binds exactly one repository, so (community, room_id) is the whole
   * key: re-recording updates the pending row in place, and an already-ACTIVE
   * row is never resurrected — a later refusal for a different repository
   * after activation must not flip a completed link back to pending.
   */
  async recordGitHubRoomLinkRequest(
    community: string,
    roomId: string,
    fullName: string,
    requestedBy: string,
    now: Date,
  ): Promise<void> {
    if (!roomId || roomId.length > 200) return;
    await this.database.query(
      `INSERT INTO beeline_github_room_link_requests
        (community, room_id, full_name, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (community, room_id) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         requested_by = EXCLUDED.requested_by,
         requested_at = EXCLUDED.requested_at
       WHERE beeline_github_room_link_requests.activated_at IS NULL`,
      [community, roomId, fullName, requestedBy, now],
    );
  }

  /**
   * Activate every still-pending Room link whose repository is now covered by
   * one of the given (lowercased) full names, returning ONLY the requests this
   * call flipped — so duplicate grants (a webhook delivery and a reconcile
   * racing, or two webhooks for the same installation) are idempotent and each
   * completion is announced at most once.
   */
  async activateGitHubRoomLinks(
    community: string,
    fullNames: readonly string[],
    now: Date,
  ): Promise<GitHubRoomLinkRequest[]> {
    const normalized = [...new Set(fullNames.map((name) => name.toLowerCase()))].filter(Boolean);
    if (normalized.length === 0) return [];
    const result = await this.database.query<
      QueryResultRow & {
        room_id: string;
        full_name: string;
        requested_by: string;
        requested_at: Date | string;
      }
    >(
      `UPDATE beeline_github_room_link_requests
       SET activated_at = $3
       WHERE community = $1 AND activated_at IS NULL AND lower(full_name) = ANY($2::text[])
       RETURNING room_id, full_name, requested_by, requested_at`,
      [community, normalized, now],
    );
    return result.rows.map((row) => ({
      community,
      roomId: String(row.room_id),
      fullName: String(row.full_name),
      requestedBy: String(row.requested_by),
      requestedAt: asDate(row.requested_at),
      activatedAt: now,
    }));
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

  /** Store extracted repository-activity events; a repeated delivery is a no-op. */
  async saveGitHubRepoEvents(
    events: Array<{
      fullName: string;
      deliveryId: string;
      eventType: string;
      action: string;
      actor: string;
      number?: number;
      title?: string;
      url?: string;
      summary: string;
    }>,
    now: Date,
  ): Promise<void> {
    for (const event of events) {
      await this.database.query(
        `INSERT INTO beeline_github_repo_events
          (full_name, delivery_id, event_type, action, actor, number, title, url, summary, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (delivery_id) DO NOTHING`,
        [
          event.fullName,
          event.deliveryId,
          event.eventType,
          event.action,
          event.actor,
          event.number ?? null,
          event.title ?? null,
          event.url ?? null,
          event.summary,
          now,
        ],
      );
    }
    // Bounded history: an offline daemon catches up within this window and no
    // backlog can grow past it. Cheap enough to run on every insert batch.
    await this.database.query(`DELETE FROM beeline_github_repo_events WHERE received_at < $1`, [
      new Date(now.getTime() - GITHUB_REPO_EVENT_RETENTION_MS),
    ]);
  }

  /** The stored activity for one repository newer than `sinceId`, oldest first. */
  async githubRepoEvents(
    fullName: string,
    sinceId: number,
    limit: number,
  ): Promise<
    Array<{
      id: number;
      fullName: string;
      eventType: string;
      action: string;
      actor: string;
      number?: number;
      title?: string;
      url?: string;
      summary: string;
      receivedAt: string;
    }>
  > {
    const result = await this.database.query<
      QueryResultRow & {
        id: string | number;
        full_name: string;
        event_type: string;
        action: string;
        actor: string;
        number: number | null;
        title: string | null;
        url: string | null;
        summary: string;
        received_at: string | Date;
      }
    >(
      `SELECT id, full_name, event_type, action, actor, number, title, url, summary, received_at
       FROM beeline_github_repo_events
       WHERE full_name = $1 AND id > $2
       ORDER BY id ASC
       LIMIT $3`,
      [fullName, sinceId, limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      fullName: row.full_name,
      eventType: row.event_type,
      action: row.action,
      actor: row.actor,
      ...(row.number === null ? {} : { number: Number(row.number) }),
      ...(row.title ? { title: row.title } : {}),
      ...(row.url ? { url: row.url } : {}),
      summary: row.summary,
      receivedAt: new Date(row.received_at).toISOString(),
    }));
  }

  /** The newest stored event id for a repository (0 when none) — the bootstrap cursor. */
  async latestGitHubRepoEventId(fullName: string): Promise<number> {
    const result = await this.database.query<QueryResultRow & { id: string | number }>(
      `SELECT MAX(id) AS id FROM beeline_github_repo_events WHERE full_name = $1`,
      [fullName],
    );
    const value = result.rows[0]?.id;
    return value === null || value === undefined ? 0 : Number(value);
  }

  async saveGitHubUserToken(
    community: string,
    subject: string,
    encryptedToken: string,
    now: Date,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO beeline_github_user_tokens (community, subject, encrypted_token, updated_at, stale_at)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (community, subject) DO UPDATE SET
         encrypted_token = EXCLUDED.encrypted_token, updated_at = EXCLUDED.updated_at,
         stale_at = NULL`,
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

  /** A stored user token GitHub answered 401/403 with — the app can silently re-auth. */
  async markGitHubUserTokenStale(community: string, subject: string, now: Date): Promise<void> {
    // Only the FIRST observation is interesting; a newer credential that has
    // not been replaced yet keeps its original stale-since stamp.
    await this.database.query(
      `UPDATE beeline_github_user_tokens SET stale_at = COALESCE(stale_at, $3)
       WHERE community = $1 AND subject = $2`,
      [community, subject, now],
    );
  }

  async clearGitHubUserTokenStale(community: string, subject: string): Promise<void> {
    await this.database.query(
      `UPDATE beeline_github_user_tokens SET stale_at = NULL
       WHERE community = $1 AND subject = $2 AND stale_at IS NOT NULL`,
      [community, subject],
    );
  }

  async githubUserTokenStaleAt(community: string, subject: string): Promise<Date | null> {
    const result = await this.database.query<QueryResultRow & { stale_at: string | Date | null }>(
      `SELECT stale_at FROM beeline_github_user_tokens
       WHERE community = $1 AND subject = $2`,
      [community, subject],
    );
    const raw = result.rows[0]?.stale_at;
    if (!raw) return null;
    const date = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  async claimGitHubInstallationReconciliation(
    community: string,
    subject: string,
    now: Date,
    retryAfter: Date,
  ): Promise<boolean> {
    const result = await this.database.query<QueryResultRow>(
      `INSERT INTO beeline_github_installation_reconciliations
        (community, subject, attempted_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (community, subject) DO UPDATE SET
         attempted_at = EXCLUDED.attempted_at
       WHERE beeline_github_installation_reconciliations.attempted_at <= $4
       RETURNING subject`,
      [community, subject, now, retryAfter],
    );
    return result.rowCount === 1;
  }

  /**
   * Assign the one canonical hosted handle for a key-only identity. GitHub
   * reservations win, so a key ceremony can never squat a known linked login.
   */
  async claimNip05Name(
    community: string,
    name: string,
    pubkey: string,
    now: Date,
  ): Promise<ClaimManagedHandleResult> {
    return this.database.transaction(async (transaction) => {
      const assigned = await transaction.query<ManagedIdentityRow>(
        `SELECT handle, display_name, source, github_login, github_rename_available
         FROM beeline_identity_handles
         WHERE community = $1 AND pubkey = $2
         FOR UPDATE`,
        [community, pubkey],
      );
      if (assigned.rows[0]) {
        return assigned.rows[0].handle === name
          ? { status: 'idempotent', identity: managedIdentityFromRow(assigned.rows[0]) }
          : { status: 'already_assigned' };
      }

      const reservation = await transaction.query<QueryResultRow & { pubkey: string }>(
        `SELECT pubkey FROM beeline_github_handle_reservations
         WHERE community = $1 AND handle = $2`,
        [community, name],
      );
      if (reservation.rows[0] && reservation.rows[0].pubkey !== pubkey) {
        return { status: 'taken' };
      }

      const inserted = await transaction.query<QueryResultRow>(
        `INSERT INTO beeline_nip05_names (name, pubkey, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO NOTHING
         RETURNING name`,
        [name, pubkey, now],
      );
      if (inserted.rowCount !== 1) {
        const existing = await transaction.query<QueryResultRow & { pubkey: string }>(
          `SELECT pubkey FROM beeline_nip05_names WHERE name = $1`,
          [name],
        );
        if (existing.rows[0]?.pubkey !== pubkey) return { status: 'taken' };
      }

      const identity = await transaction.query<ManagedIdentityRow>(
        `INSERT INTO beeline_identity_handles
          (community, pubkey, handle, display_name, source, created_at, updated_at)
         VALUES ($1, $2, $3, $3, 'key', $4, $4)
         RETURNING handle, display_name, source, github_login, github_rename_available`,
        [community, pubkey, name, now],
      );
      return {
        status: inserted.rowCount === 1 ? 'claimed' : 'idempotent',
        identity: managedIdentityFromRow(identity.rows[0]!),
      };
    });
  }

  /** Reconcile a verified GitHub login onto the already-bound device key. */
  async provisionGitHubIdentity(
    community: string,
    subject: string,
    pubkey: string,
    login: string,
    displayName: string,
    now: Date,
  ): Promise<ManagedIdentity> {
    return this.database.transaction(async (transaction) => {
      // GitHub confirms the login's current owner. Drop any stale reservation
      // left by a different subject that previously held the same login.
      await transaction.query(
        `DELETE FROM beeline_github_handle_reservations
         WHERE community = $1 AND handle = $3 AND subject <> $2`,
        [community, subject, login],
      );
      await transaction.query(
        `INSERT INTO beeline_github_handle_reservations
          (community, subject, handle, pubkey, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (community, subject) DO UPDATE SET
           handle = EXCLUDED.handle,
           pubkey = EXCLUDED.pubkey,
           updated_at = EXCLUDED.updated_at`,
        [community, subject, login, pubkey, now],
      );
      // A GitHub login is authoritative for its hosted NIP-05 name. This also
      // reconciles the rare case where a key-only claim predated our first
      // verified sighting of that GitHub account.
      await transaction.query(
        `INSERT INTO beeline_nip05_names (name, pubkey, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET pubkey = EXCLUDED.pubkey`,
        [login, pubkey, now],
      );
      // The hosted namespace is global. If this GitHub login was claimed by a
      // key before its owner first linked, revoke that stale managed identity;
      // its next authenticated lookup resumes the handle ceremony.
      await transaction.query(
        `DELETE FROM beeline_identity_handles
         WHERE handle = $1 AND pubkey <> $2`,
        [login, pubkey],
      );

      const existing = await transaction.query<ManagedIdentityRow>(
        `SELECT handle, display_name, source, github_login, github_rename_available
         FROM beeline_identity_handles
         WHERE community = $1 AND pubkey = $2
         FOR UPDATE`,
        [community, pubkey],
      );
      let result: SqlResult<ManagedIdentityRow>;
      if (existing.rows[0]) {
        result = await transaction.query<ManagedIdentityRow>(
          `UPDATE beeline_identity_handles SET
             github_subject = $3,
             github_login = $4,
             github_rename_available = (handle <> $4),
             display_name = CASE WHEN source = 'github' THEN $5 ELSE display_name END,
             updated_at = $6
           WHERE community = $1 AND pubkey = $2
           RETURNING handle, display_name, source, github_login, github_rename_available`,
          [community, pubkey, subject, login, displayName, now],
        );
      } else {
        result = await transaction.query<ManagedIdentityRow>(
          `INSERT INTO beeline_identity_handles
            (community, pubkey, handle, display_name, source, github_subject, github_login,
             github_rename_available, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'github', $5, $3, FALSE, $6, $6)
           RETURNING handle, display_name, source, github_login, github_rename_available`,
          [community, pubkey, login, displayName, subject, now],
        );
      }
      return managedIdentityFromRow(result.rows[0]!);
    });
  }

  async managedIdentity(community: string, pubkey: string): Promise<ManagedIdentity | null> {
    const result = await this.database.query<ManagedIdentityRow>(
      `SELECT handle, display_name, source, github_login, github_rename_available
       FROM beeline_identity_handles
       WHERE community = $1 AND pubkey = $2`,
      [community, pubkey],
    );
    return result.rows[0] ? managedIdentityFromRow(result.rows[0]) : null;
  }

  /** Consume the single GitHub-handle rename offered after an in-place link. */
  async adoptGitHubHandle(
    community: string,
    pubkey: string,
    now: Date,
  ): Promise<{ status: 'renamed'; identity: ManagedIdentity } | { status: 'unavailable' }> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<ManagedIdentityRow>(
        `SELECT handle, display_name, source, github_login, github_rename_available
         FROM beeline_identity_handles
         WHERE community = $1 AND pubkey = $2
           AND github_login IS NOT NULL
           AND github_rename_available = TRUE
         FOR UPDATE`,
        [community, pubkey],
      );
      const current = selected.rows[0];
      if (!current?.github_login) return { status: 'unavailable' };

      await transaction.query(
        `DELETE FROM beeline_nip05_names
         WHERE name = $1 AND pubkey = $2`,
        [current.handle, pubkey],
      );
      const updated = await transaction.query<ManagedIdentityRow>(
        `UPDATE beeline_identity_handles SET
           handle = github_login,
           source = 'github',
           display_name = CASE WHEN display_name = handle THEN github_login ELSE display_name END,
           github_rename_available = FALSE,
           updated_at = $3
         WHERE community = $1 AND pubkey = $2
         RETURNING handle, display_name, source, github_login, github_rename_available`,
        [community, pubkey, now],
      );
      return updated.rows[0]
        ? { status: 'renamed', identity: managedIdentityFromRow(updated.rows[0]) }
        : { status: 'unavailable' };
    });
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
