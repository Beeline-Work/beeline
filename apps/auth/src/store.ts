import { authStoreRelayCommunityIdForRoom, authStoreMigrate, authStoreCreateFlow, authStoreContinueFlow, authStoreInsertFlow, authStoreConsumeFlow, authStoreIdentityLinkForSubject, authStoreLatestWorkspaceForMember, authStoreCreateAgentConnectDevice, authStoreFindAgentConnectDeviceByUserCode, authStoreFindAgentConnectDevice, authStoreApproveAgentConnectDevice, authStoreConsumeAgentConnectDevice, authStoreCreateTicket, authStoreCreateRecoveryTicket, authStoreCancelRecoveryTicket, authStoreFindTicket, authStoreRecordFailedTicketAttempt, authStoreConsumeTicketForPhone, authStoreConsumeTicketAndLink, authStoreRecoverConsumedTicketLink, authStoreClaimNip98Event } from './store-relay-community-id-for-room.js';
import { authStoreLinksForPubkey, authStoreResolveCurrentPubkey, authStoreSameIdentity, authStoreSuccessionPredecessors, authStoreGithubSubjectForPubkey, authStoreCreateGitHubInstallFlow, authStorePeekGitHubInstallFlow, authStoreConsumeGitHubInstallFlow, authStoreSaveGitHubInstallation, authStoreUpsertGitHubInstallation, authStoreGithubActiveInstallationCoversAccount, authStoreGithubInstallationForPubkey, authStoreReplaceGitHubRepositories, authStoreReplaceGitHubInstallationSnapshot, authStoreReplaceGitHubRepositoriesInTransaction, authStoreUpsertGitHubRepository, authStoreApplyGitHubRepositoryChanges, authStoreMarkGitHubInstallationStatus, authStoreGithubRepositoriesForPubkey, authStoreGithubRepositoryAlias, authStoreSaveGitHubRepositoryAlias, authStoreStoredGitHubRepositoryIdForName, authStoreGitHubRepositoryAccessRow, authStoreGithubRepositoryAccess, authStoreRecordGitHubRoomLinkRequest, authStoreActivateGitHubRoomLinks, authStoreClaimGitHubWebhookDelivery } from './store-links-for-pubkey.js';
import { authStoreReleaseGitHubWebhookDelivery, authStoreSaveGitHubRepoEvents, authStoreGithubRepoEvents, authStoreLatestGitHubRepoEventId, authStoreSaveGitHubUserToken, authStoreGithubUserCredential, authStoreGithubUserToken, authStoreMarkGitHubUserTokenStale, authStoreClearGitHubUserTokenStale, authStoreGithubUserTokenStaleAt, authStoreClaimGitHubInstallationReconciliation, authStoreProvisionGitHubIdentity, authStoreManagedIdentity, authStoreAdoptGitHubHandle, authStoreClose } from './store-release-git-hub-webhook-delivery.js';
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

export const MIGRATIONS = [
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
  `ALTER TABLE beeline_oidc_flows ADD COLUMN IF NOT EXISTS app_recovery_hash CHAR(64)`,
  `ALTER TABLE beeline_oidc_flows ADD COLUMN IF NOT EXISTS native_cancelled_at TIMESTAMPTZ`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS beeline_oidc_flows_app_recovery_idx
    ON beeline_oidc_flows (app_recovery_hash) WHERE app_recovery_hash IS NOT NULL`,
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
  `ALTER TABLE beeline_bind_tickets ADD COLUMN IF NOT EXISTS provider_avatar TEXT`,
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_identity_links_pubkey_idx
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_key_successions_new_idx
    ON beeline_key_successions (community, new_pubkey)`,
  `CREATE TABLE IF NOT EXISTS beeline_nip98_replays (
    event_id CHAR(64) PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_oidc_flows_expiry_idx ON beeline_oidc_flows (expires_at)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_bind_tickets_expiry_idx ON beeline_bind_tickets (expires_at)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_nip98_replays_expiry_idx ON beeline_nip98_replays (expires_at)`,
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_agent_connect_devices_expiry_idx
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_identity_handles_handle_idx
    ON beeline_identity_handles (community, handle)`,
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
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_installations_owner_idx
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_repositories_name_idx
    ON beeline_github_repositories (community, lower(full_name))`,
  `CREATE TABLE IF NOT EXISTS beeline_github_repository_aliases (
    community TEXT NOT NULL,
    alias_full_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_repository_aliases_idx
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
  `ALTER TABLE beeline_github_user_tokens ADD COLUMN IF NOT EXISTS encrypted_refresh_token TEXT`,
  `ALTER TABLE beeline_github_user_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS beeline_github_installation_reconciliations (
    community TEXT NOT NULL,
    subject TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community, subject)
  )`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_install_flows_expiry_idx
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_repo_events_name_idx
    ON beeline_github_repo_events (full_name, id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_repo_events_received_idx
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
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS beeline_github_room_link_requests_name_idx
    ON beeline_github_room_link_requests (community, lower(full_name))
    WHERE activated_at IS NULL`,
] as const;

export function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('database returned invalid timestamp');
  return date;
}

export interface FlowRow extends QueryResultRow {
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
  app_recovery_hash: string | null;
  created_at: unknown;
  expires_at: unknown;
}

export interface OidcFlow {
  stateHash?: string;
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
  appRecoveryHash?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface TicketRow extends QueryResultRow {
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
  provider_avatar: string | null;
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
  providerAvatar?: string | null;
}

export interface ManagedIdentity {
  handle: string;
  displayName: string;
  source: 'key' | 'github';
  githubLogin?: string;
  githubRenameAvailable: boolean;
}

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

export interface AgentConnectDeviceRow extends QueryResultRow {
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

export function agentConnectDeviceFromRow(row: AgentConnectDeviceRow): AgentConnectDevice {
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

export interface GitHubInstallFlow {
  community: string;
  pubkey: string;
  redirectUri: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Why a GitHub install callback could not be matched to a live flow. The
 * three misses are distinct facts for the person reading the page: a flow
 * that was spent (the connection is already made), a flow that ran out of
 * time (start again), and a state nobody ever issued (a bad link).
 */
export type GitHubInstallFlowLookup =
  | { status: 'ok'; flow: GitHubInstallFlow }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'used' };

/**
 * How long a spent or expired install flow is kept so a late callback can be
 * told WHY it missed. Deleting the row at expiry would turn every miss into
 * an indistinguishable "invalid".
 */
export const GITHUB_INSTALL_FLOW_RETENTION_MS = 90 * 24 * 60 * 60_000;

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

export interface GitHubRepositoryAccessRow extends GitHubRepositoryAccess {
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

export function flowFromRow(row: FlowRow): OidcFlow {
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
    appRecoveryHash: row.app_recovery_hash,
    createdAt: asDate(row.created_at),
    expiresAt: asDate(row.expires_at),
  };
}

export function ticketFromRow(row: TicketRow): BindTicket {
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
    providerAvatar: row.provider_avatar,
  };
}

export interface ManagedIdentityRow extends QueryResultRow {
  handle: string;
  display_name: string;
  source: 'key' | 'github';
  github_login: string | null;
  github_rename_available: boolean;
}

export function managedIdentityFromRow(row: ManagedIdentityRow): ManagedIdentity {
  return {
    handle: row.handle,
    displayName: row.display_name,
    source: row.source,
    ...(row.github_login ? { githubLogin: row.github_login } : {}),
    githubRenameAvailable: row.github_rename_available,
  };
}

export class AuthStore {
  constructor(readonly database: TransactionalDatabase) {}
  /** * Resolve the relay's authoritative tenant stamp for a Room. * * The similarly named `community` tag on kind:9007 is client-authored * application metadata. Buzz stamps `channels.community_id` from the * request Host and treats that SQL column as the tenancy boundary. */ async relayCommunityIdForRoom(roomId: string): Promise<string | null> { return authStoreRelayCommunityIdForRoom(this, roomId); }
  async migrate(): Promise<void> { return authStoreMigrate(this); }
  async createFlow(stateHash: string, flow: OidcFlow): Promise<void> { return authStoreCreateFlow(this, stateHash, flow); }
  /** * Replace a consumed flow with a continuation flow. The native recovery hash * moves to the new row in one transaction, so exactly one row holds it. */ async continueFlow(previousStateHash: string, stateHash: string, flow: OidcFlow): Promise<void> { return authStoreContinueFlow(this, previousStateHash, stateHash, flow); }
  async insertFlow(executor: SqlExecutor, stateHash: string, flow: OidcFlow, nativeCancelledAt: unknown): Promise<void> { return authStoreInsertFlow(this, executor, stateHash, flow, nativeCancelledAt); }
  async consumeFlow(stateHash: string, browserSessionHash: string, now: Date): Promise<OidcFlow | null> { return authStoreConsumeFlow(this, stateHash, browserSessionHash, now); }
  async identityLinkForSubject(community: string, issuer: string, audience: string, subject: string): Promise<IdentityLink | null> { return authStoreIdentityLinkForSubject(this, community, issuer, audience, subject); }
  async latestWorkspaceForMember(memberPubkey: string, relayCommunityIds: readonly string[]): Promise<{ workspaceId: string; name: string; } | null> { return authStoreLatestWorkspaceForMember(this, memberPubkey, relayCommunityIds); }
  async createAgentConnectDevice(device: AgentConnectDevice): Promise<void> { return authStoreCreateAgentConnectDevice(this, device); }
  async findAgentConnectDeviceByUserCode(userCode: string): Promise<AgentConnectDevice | null> { return authStoreFindAgentConnectDeviceByUserCode(this, userCode); }
  async findAgentConnectDevice(deviceCodeHash: string): Promise<AgentConnectDevice | null> { return authStoreFindAgentConnectDevice(this, deviceCodeHash); }
  async approveAgentConnectDevice(input: { deviceCodeHash: string; workspaceId: string; pairedBy: string; agentPubkey: string; pairingTokenHash: string; sealedCredentials: string; now: Date; }): Promise<boolean> { return authStoreApproveAgentConnectDevice(this, input); }
  async consumeAgentConnectDevice(deviceCodeHash: string, now: Date): Promise<AgentConnectDevice | null> { return authStoreConsumeAgentConnectDevice(this, deviceCodeHash, now); }
  async createTicket(ticketHash: string, ticket: BindTicket): Promise<void> { return authStoreCreateTicket(this, ticketHash, ticket); }
  /** Finalize a native recovery transaction only while its initiating app still owns it. */ async createRecoveryTicket(recoveryHash: string, ticket: BindTicket, now: Date): Promise<boolean> { return authStoreCreateRecoveryTicket(this, recoveryHash, ticket, now); }
  /** Cancel pending or completed recovery without revealing whether the token existed. */ async cancelRecoveryTicket(recoveryHash: string, now: Date): Promise<void> { return authStoreCancelRecoveryTicket(this, recoveryHash, now); }
  async findTicket(ticketHash: string): Promise<BindTicket | null> { return authStoreFindTicket(this, ticketHash); }
  async recordFailedTicketAttempt(ticketHash: string, now: Date): Promise<number | null> { return authStoreRecordFailedTicketAttempt(this, ticketHash, now); }
  /** Atomically consume the same short-lived GitHub proof used by the legacy key bind. */ async consumeTicketForPhone(ticketHash: string, community: string, now: Date, issuer = 'https://github.com'): Promise<PhoneTicketExchangeResult> { return authStoreConsumeTicketForPhone(this, ticketHash, community, now, issuer); }
  async consumeTicketAndLink(ticketHash: string, pubkey: string, now: Date): Promise<BindResult> { return authStoreConsumeTicketAndLink(this, ticketHash, pubkey, now); }
  /** * Replace a conflicting link only after the normal bind path has consumed * this exact OAuth-backed ticket for this exact candidate key. */ async recoverConsumedTicketLink(ticketHash: string, pubkey: string, now: Date): Promise<RecoverBindResult> { return authStoreRecoverConsumedTicketLink(this, ticketHash, pubkey, now); }
  async claimNip98Event(eventId: string, expiresAt: Date, now: Date): Promise<boolean> { return authStoreClaimNip98Event(this, eventId, expiresAt, now); }
  async linksForPubkey(community: string, pubkey: string): Promise<IdentityLink[]> { return authStoreLinksForPubkey(this, community, pubkey); }
  /** * Walk the succession chain forward from `pubkey` to the CURRENT key of its * identity. A key with no recorded succession resolves to itself. Cycle- * safe (a chain can only grow by replacing the current link key, so cycles * are not reachable through the recovery flow, but the walk refuses to * loop forever on corrupt data). */ async resolveCurrentPubkey(community: string, pubkey: string): Promise<string> { return authStoreResolveCurrentPubkey(this, community, pubkey); }
  /** * The one succession-aware equality check: two pubkeys name the same * Beeline identity when they resolve to the same current key. Every * "is this pubkey the authorized owner" comparison goes through here (or * through {@link resolveCurrentPubkey}) so succession semantics live in * exactly one place. */ async sameIdentity(community: string, a: string, b: string): Promise<boolean> { return authStoreSameIdentity(this, community, a, b); }
  /** * The keys that previously held THIS key's identity, oldest first — the * chain a successor client walks to rediscover its predecessor's Workspaces. * Only ever served to the key itself (the route checks the NIP-98 signer). */ async successionPredecessors(community: string, pubkey: string): Promise<string[]> { return authStoreSuccessionPredecessors(this, community, pubkey); }
  async githubSubjectForPubkey(community: string, pubkey: string): Promise<string | null> { return authStoreGithubSubjectForPubkey(this, community, pubkey); }
  async createGitHubInstallFlow(stateHash: string, flow: GitHubInstallFlow): Promise<void> { return authStoreCreateGitHubInstallFlow(this, stateHash, flow); }
  /** * Read the flow behind a callback state WITHOUT spending it, classifying a * miss as expired, already used, or never issued. One query used to answer * all four, so a used link and an expired link were one indistinguishable * miss and the page had to guess between them. */ async peekGitHubInstallFlow(stateHash: string, now: Date): Promise<GitHubInstallFlowLookup> { return authStorePeekGitHubInstallFlow(this, stateHash, now); }
  /** * Spend a flow atomically. Kept as the success-path authority: only an * unconsumed, unexpired state can complete an installation, and it can do so * exactly once. Classification of a miss goes through * `peekGitHubInstallFlow` so the caller can say which miss it was. */ async consumeGitHubInstallFlow(stateHash: string, now: Date): Promise<GitHubInstallFlow | null> { return authStoreConsumeGitHubInstallFlow(this, stateHash, now); }
  async saveGitHubInstallation(installation: GitHubInstallation, now: Date): Promise<boolean> { return authStoreSaveGitHubInstallation(this, installation, now); }
  async upsertGitHubInstallation(executor: SqlExecutor, installation: GitHubInstallation, now: Date): Promise<boolean> { return authStoreUpsertGitHubInstallation(this, executor, installation, now); }

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
  /** Whether any ACTIVE recorded installation in the Workspace covers an account login. */ async githubActiveInstallationCoversAccount(community: string, login: string): Promise<boolean> { return authStoreGithubActiveInstallationCoversAccount(this, community, login); }
  async githubInstallationForPubkey(community: string, pubkey: string): Promise<GitHubInstallation | null> { return authStoreGithubInstallationForPubkey(this, community, pubkey); }
  async replaceGitHubRepositories(community: string, installationId: number, repositories: readonly StoredGitHubRepository[], now: Date): Promise<void> { return authStoreReplaceGitHubRepositories(this, community, installationId, repositories, now); }
  async replaceGitHubInstallationSnapshot(installation: GitHubInstallation, repositories: readonly StoredGitHubRepository[], now: Date): Promise<boolean> { return authStoreReplaceGitHubInstallationSnapshot(this, installation, repositories, now); }
  async replaceGitHubRepositoriesInTransaction(transaction: SqlExecutor, community: string, installationId: number, repositories: readonly StoredGitHubRepository[], now: Date): Promise<void> { return authStoreReplaceGitHubRepositoriesInTransaction(this, transaction, community, installationId, repositories, now); }
  async upsertGitHubRepository(executor: SqlExecutor, community: string, repository: StoredGitHubRepository, now: Date): Promise<void> { return authStoreUpsertGitHubRepository(this, executor, community, repository, now); }
  async applyGitHubRepositoryChanges(installationId: number, added: readonly StoredGitHubRepository[], removedIds: readonly number[], now: Date): Promise<void> { return authStoreApplyGitHubRepositoryChanges(this, installationId, added, removedIds, now); }
  async markGitHubInstallationStatus(installationId: number, status: 'active' | 'revoked' | 'suspended', now: Date): Promise<void> { return authStoreMarkGitHubInstallationStatus(this, installationId, status, now); }
  async githubRepositoriesForPubkey(community: string, pubkey: string): Promise<StoredGitHubRepository[]> { return authStoreGithubRepositoriesForPubkey(this, community, pubkey); }
  /** A stored alias maps a Room binding's pre-transfer owner/repo to its current location. */ async githubRepositoryAlias(community: string, alias: string): Promise<string | null> { return authStoreGithubRepositoryAlias(this, community, alias); }
  async saveGitHubRepositoryAlias(community: string, alias: string, fullName: string, now: Date): Promise<void> { return authStoreSaveGitHubRepositoryAlias(this, community, alias, fullName, now); }
  /** The repository id a (possibly stale) full_name was last listed under, active or not. */ async storedGitHubRepositoryIdForName(community: string, fullName: string): Promise<number | undefined> { return authStoreStoredGitHubRepositoryIdForName(this, community, fullName); }
  /** One installation-joined repository lookup; `condition`/`values` select the repository. */ async gitHubRepositoryAccessRow(condition: string, values: unknown[]): Promise<GitHubRepositoryAccessRow | null> { return authStoreGitHubRepositoryAccessRow(this, condition, values); }
  async githubRepositoryAccess(community: string, pubkey: string, fullName: string): Promise<GitHubRepositoryAccess> { return authStoreGithubRepositoryAccess(this, community, pubkey, fullName); }
  /** * Record that a Room's admin-authored repository binding names a repository * the GitHub App does not cover yet, so the link can complete automatically * once the repository owner grants access. * * A Room binds exactly one repository, so (community, room_id) is the whole * key: re-recording updates the pending row in place, and an already-ACTIVE * row is never resurrected — a later refusal for a different repository * after activation must not flip a completed link back to pending. */ async recordGitHubRoomLinkRequest(community: string, roomId: string, fullName: string, requestedBy: string, now: Date): Promise<void> { return authStoreRecordGitHubRoomLinkRequest(this, community, roomId, fullName, requestedBy, now); }
  /** * Activate every still-pending Room link whose repository is now covered by * one of the given (lowercased) full names, returning ONLY the requests this * call flipped — so duplicate grants (a webhook delivery and a reconcile * racing, or two webhooks for the same installation) are idempotent and each * completion is announced at most once. */ async activateGitHubRoomLinks(community: string, fullNames: readonly string[], now: Date): Promise<GitHubRoomLinkRequest[]> { return authStoreActivateGitHubRoomLinks(this, community, fullNames, now); }
  async claimGitHubWebhookDelivery(deliveryId: string, now: Date): Promise<boolean> { return authStoreClaimGitHubWebhookDelivery(this, deliveryId, now); }
  async releaseGitHubWebhookDelivery(deliveryId: string): Promise<void> { return authStoreReleaseGitHubWebhookDelivery(this, deliveryId); }
  /** Store extracted repository-activity events; a repeated delivery is a no-op. */ async saveGitHubRepoEvents(events: Array<{ fullName: string; deliveryId: string; eventType: string; action: string; actor: string; number?: number; title?: string; url?: string; summary: string; }>, now: Date): Promise<void> { return authStoreSaveGitHubRepoEvents(this, events, now); }
  /** The stored activity for one repository newer than `sinceId`, oldest first. */ async githubRepoEvents(fullName: string, sinceId: number, limit: number): Promise<Array<{ id: number; fullName: string; eventType: string; action: string; actor: string; number?: number; title?: string; url?: string; summary: string; receivedAt: string; }>> { return authStoreGithubRepoEvents(this, fullName, sinceId, limit); }
  /** The newest stored event id for a repository (0 when none) — the bootstrap cursor. */ async latestGitHubRepoEventId(fullName: string): Promise<number> { return authStoreLatestGitHubRepoEventId(this, fullName); }
  async saveGitHubUserToken(community: string, subject: string, encryptedToken: string, now: Date, credential: { encryptedRefreshToken?: string; expiresAt?: Date; } = {}): Promise<void> { return authStoreSaveGitHubUserToken(this, community, subject, encryptedToken, now, credential); }
  async githubUserCredential(community: string, subject: string) { return authStoreGithubUserCredential(this, community, subject); }
  async githubUserToken(community: string, subject: string): Promise<string | null> { return authStoreGithubUserToken(this, community, subject); }
  /** A stored user token GitHub answered 401/403 with — the app can silently re-auth. */ async markGitHubUserTokenStale(community: string, subject: string, now: Date): Promise<void> { return authStoreMarkGitHubUserTokenStale(this, community, subject, now); }
  async clearGitHubUserTokenStale(community: string, subject: string): Promise<void> { return authStoreClearGitHubUserTokenStale(this, community, subject); }
  async githubUserTokenStaleAt(community: string, subject: string): Promise<Date | null> { return authStoreGithubUserTokenStaleAt(this, community, subject); }
  async claimGitHubInstallationReconciliation(community: string, subject: string, now: Date, retryAfter: Date): Promise<boolean> { return authStoreClaimGitHubInstallationReconciliation(this, community, subject, now, retryAfter); }
  /** Reconcile a verified GitHub login onto the already-bound device key. */ async provisionGitHubIdentity(community: string, subject: string, pubkey: string, login: string, displayName: string, now: Date): Promise<ManagedIdentity> { return authStoreProvisionGitHubIdentity(this, community, subject, pubkey, login, displayName, now); }
  async managedIdentity(community: string, pubkey: string): Promise<ManagedIdentity | null> { return authStoreManagedIdentity(this, community, pubkey); }
  /** Consume the single GitHub-handle rename offered after an in-place link. */ async adoptGitHubHandle(community: string, pubkey: string, now: Date): Promise<{ status: 'renamed'; identity: ManagedIdentity; } | { status: 'unavailable'; }> { return authStoreAdoptGitHubHandle(this, community, pubkey, now); }
  async close(): Promise<void> { return authStoreClose(this); }
}
