import { type QueryResultRow } from 'pg';
import { AuthStore, SqlExecutor, IdentityLink, asDate, GitHubInstallFlow, GITHUB_INSTALL_FLOW_RETENTION_MS, GitHubInstallFlowLookup, GitHubInstallation, StoredGitHubRepository, GitHubRepositoryAccessRow, GitHubRepositoryAccess, GitHubRoomLinkRequest } from './store.js';



  export async function authStoreLinksForPubkey(ctx: AuthStore, community: string, pubkey: string): Promise<IdentityLink[]> {
    const result = await ctx.database.query<
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
  export async function authStoreResolveCurrentPubkey(ctx: AuthStore, community: string, pubkey: string): Promise<string> {
    let current = pubkey;
    const visited = new Set<string>([current]);
    for (;;) {
      const result = await ctx.database.query<QueryResultRow & { new_pubkey: string }>(
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
  export async function authStoreSameIdentity(ctx: AuthStore, community: string, a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const [resolvedA, resolvedB] = await Promise.all([
      ctx.resolveCurrentPubkey(community, a),
      ctx.resolveCurrentPubkey(community, b),
    ]);
    return resolvedA === resolvedB;
  }


  /**
   * The keys that previously held THIS key's identity, oldest first — the
   * chain a successor client walks to rediscover its predecessor's Workspaces.
   * Only ever served to the key itself (the route checks the NIP-98 signer).
   */
  export async function authStoreSuccessionPredecessors(ctx: AuthStore, community: string, pubkey: string): Promise<string[]> {
    const predecessors: string[] = [];
    const visited = new Set<string>([pubkey]);
    let current = pubkey;
    for (;;) {
      const result = await ctx.database.query<QueryResultRow & { old_pubkey: string }>(
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


  export async function authStoreGithubSubjectForPubkey(ctx: AuthStore, community: string, pubkey: string): Promise<string | null> {
    const result = await ctx.database.query<QueryResultRow & { subject: string }>(
      `SELECT subject FROM beeline_identity_links
       WHERE community = $1 AND pubkey = $2 AND issuer = 'https://github.com'
       ORDER BY created_at DESC LIMIT 1`,
      [community, pubkey],
    );
    return result.rows[0]?.subject ?? null;
  }


  export async function authStoreCreateGitHubInstallFlow(ctx: AuthStore, stateHash: string, flow: GitHubInstallFlow): Promise<void> {
    // Prune only rows nobody can classify any more: a recently expired flow
    // must survive long enough that a late callback (an owner-approved org
    // install can return days later) is told it expired rather than read as a
    // forged link.
    await ctx.database.query(`DELETE FROM beeline_github_install_flows WHERE expires_at < $1`, [
      new Date(flow.createdAt.getTime() - GITHUB_INSTALL_FLOW_RETENTION_MS),
    ]);
    await ctx.database.query(
      `INSERT INTO beeline_github_install_flows
        (state_hash, community, pubkey, redirect_uri, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [stateHash, flow.community, flow.pubkey, flow.redirectUri, flow.createdAt, flow.expiresAt],
    );
  }


  /**
   * Read the flow behind a callback state WITHOUT spending it, classifying a
   * miss as expired, already used, or never issued. One query used to answer
   * all four, so a used link and an expired link were one indistinguishable
   * miss and the page had to guess between them.
   */
  export async function authStorePeekGitHubInstallFlow(ctx: AuthStore, stateHash: string, now: Date): Promise<GitHubInstallFlowLookup> {
    const result = await ctx.database.query<
      QueryResultRow & {
        community: string;
        pubkey: string;
        redirect_uri: string;
        created_at: unknown;
        expires_at: unknown;
        consumed_at: unknown;
      }
    >(
      `SELECT community, pubkey, redirect_uri, created_at, expires_at, consumed_at
       FROM beeline_github_install_flows WHERE state_hash = $1`,
      [stateHash],
    );
    const row = result.rows[0];
    if (!row) return { status: 'missing' };
    // Consumption wins the tie: a spent link is "already used" even after its
    // window has since closed, because that is the fact that prevents reuse.
    if (row.consumed_at !== null && row.consumed_at !== undefined) return { status: 'used' };
    if (asDate(row.expires_at).getTime() < now.getTime()) return { status: 'expired' };
    return {
      status: 'ok',
      flow: {
        community: row.community,
        pubkey: row.pubkey,
        redirectUri: row.redirect_uri,
        createdAt: asDate(row.created_at),
        expiresAt: asDate(row.expires_at),
      },
    };
  }


  /**
   * Spend a flow atomically. Kept as the success-path authority: only an
   * unconsumed, unexpired state can complete an installation, and it can do so
   * exactly once. Classification of a miss goes through
   * `peekGitHubInstallFlow` so the caller can say which miss it was.
   */
  export async function authStoreConsumeGitHubInstallFlow(ctx: AuthStore, stateHash: string, now: Date): Promise<GitHubInstallFlow | null> {
    const result = await ctx.database.query<
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


  export async function authStoreSaveGitHubInstallation(ctx: AuthStore, installation: GitHubInstallation, now: Date): Promise<boolean> {
    return ctx.upsertGitHubInstallation(ctx.database, installation, now);
  }


  export async function authStoreUpsertGitHubInstallation(ctx: AuthStore,
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


  /** Whether any ACTIVE recorded installation in the Workspace covers an account login. */
  export async function authStoreGithubActiveInstallationCoversAccount(ctx: AuthStore, community: string, login: string): Promise<boolean> {
    const result = await ctx.database.query<QueryResultRow>(
      `SELECT 1 AS covered FROM beeline_github_installations
       WHERE community = $1 AND lower(account_login) = lower($2) AND status = 'active'
       LIMIT 1`,
      [community, login],
    );
    return result.rows.length > 0;
  }


  export async function authStoreGithubInstallationForPubkey(ctx: AuthStore,
    community: string,
    pubkey: string,
  ): Promise<GitHubInstallation | null> {
    return (await ctx.githubInstallationsForPubkey(community, pubkey))[0] ?? null;
  }


  export async function authStoreReplaceGitHubRepositories(ctx: AuthStore,
    community: string,
    installationId: number,
    repositories: readonly StoredGitHubRepository[],
    now: Date,
  ): Promise<void> {
    await ctx.database.transaction(async (transaction) => {
      await ctx.replaceGitHubRepositoriesInTransaction(
        transaction,
        community,
        installationId,
        repositories,
        now,
      );
    });
  }


  export async function authStoreReplaceGitHubInstallationSnapshot(ctx: AuthStore,
    installation: GitHubInstallation,
    repositories: readonly StoredGitHubRepository[],
    now: Date,
  ): Promise<boolean> {
    return ctx.database.transaction(async (transaction) => {
      if (!(await ctx.upsertGitHubInstallation(transaction, installation, now))) return false;
      await ctx.replaceGitHubRepositoriesInTransaction(
        transaction,
        installation.community,
        installation.installationId,
        repositories,
        now,
      );
      return true;
    });
  }


  export async function authStoreReplaceGitHubRepositoriesInTransaction(ctx: AuthStore,
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
      await ctx.upsertGitHubRepository(transaction, community, repository, now);
    }
    await transaction.query(
      `UPDATE beeline_github_installations
       SET repository_count = $3, status = 'active', updated_at = $4
       WHERE community = $1 AND installation_id = $2`,
      [community, installationId, repositories.length, now],
    );
  }


  export async function authStoreUpsertGitHubRepository(ctx: AuthStore,
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


  export async function authStoreApplyGitHubRepositoryChanges(ctx: AuthStore,
    installationId: number,
    added: readonly StoredGitHubRepository[],
    removedIds: readonly number[],
    now: Date,
  ): Promise<void> {
    const installations = await ctx.database.query<QueryResultRow & { community: string }>(
      `SELECT community FROM beeline_github_installations WHERE installation_id = $1`,
      [installationId],
    );
    for (const { community } of installations.rows) {
      await ctx.database.transaction(async (transaction) => {
        for (const repository of added) {
          await ctx.upsertGitHubRepository(transaction, community, repository, now);
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


  export async function authStoreMarkGitHubInstallationStatus(ctx: AuthStore,
    installationId: number,
    status: 'active' | 'revoked' | 'suspended',
    now: Date,
  ): Promise<void> {
    await ctx.database.transaction(async (transaction) => {
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


  export async function authStoreGithubRepositoriesForPubkey(ctx: AuthStore,
    community: string,
    pubkey: string,
  ): Promise<StoredGitHubRepository[]> {
    const result = await ctx.database.query<
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
  export async function authStoreGithubRepositoryAlias(ctx: AuthStore, community: string, alias: string): Promise<string | null> {
    const result = await ctx.database.query<QueryResultRow & { full_name: string }>(
      `SELECT full_name FROM beeline_github_repository_aliases
       WHERE community = $1 AND lower(alias_full_name) = lower($2)`,
      [community, alias],
    );
    return result.rows[0]?.full_name ?? null;
  }


  export async function authStoreSaveGitHubRepositoryAlias(ctx: AuthStore,
    community: string,
    alias: string,
    fullName: string,
    now: Date,
  ): Promise<void> {
    if (alias.toLowerCase() === fullName.toLowerCase()) return;
    await ctx.database.query(
      `INSERT INTO beeline_github_repository_aliases
        (community, alias_full_name, full_name, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community, lower(alias_full_name)) DO UPDATE SET
         full_name = EXCLUDED.full_name, updated_at = EXCLUDED.updated_at`,
      [community, alias, fullName, now],
    );
  }


  /** The repository id a (possibly stale) full_name was last listed under, active or not. */
  export async function authStoreStoredGitHubRepositoryIdForName(ctx: AuthStore,
    community: string,
    fullName: string,
  ): Promise<number | undefined> {
    const result = await ctx.database.query<QueryResultRow & { repository_id: string | number }>(
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
  export async function authStoreGitHubRepositoryAccessRow(ctx: AuthStore,
    condition: string,
    values: unknown[],
  ): Promise<GitHubRepositoryAccessRow | null> {
    const result = await ctx.database.query<
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


  export async function authStoreGithubRepositoryAccess(ctx: AuthStore,
    community: string,
    pubkey: string,
    fullName: string,
  ): Promise<GitHubRepositoryAccess> {
    const exact = await ctx.gitHubRepositoryAccessRow(
      `AND lower(r.full_name) = lower($3)
       AND lower(split_part($3, '/', 1)) = lower(i.account_login)`,
      [community, pubkey, fullName],
    );
    if (exact?.accessible || exact?.reason === 'revoked') return exact;
    // A transferred or renamed repository keeps its immutable GitHub id, and
    // the installation snapshot deactivates stale full_name rows instead of
    // deleting them — so a Room binding that predates a transfer still
    // resolves onto the repository's current name without re-binding.
    const priorId = await ctx.storedGitHubRepositoryIdForName(community, fullName);
    if (priorId !== undefined) {
      const healed = await ctx.gitHubRepositoryAccessRow(`AND r.repository_id = $3::bigint`, [
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
  export async function authStoreRecordGitHubRoomLinkRequest(ctx: AuthStore,
    community: string,
    roomId: string,
    fullName: string,
    requestedBy: string,
    now: Date,
  ): Promise<void> {
    if (!roomId || roomId.length > 200) return;
    await ctx.database.query(
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
  export async function authStoreActivateGitHubRoomLinks(ctx: AuthStore,
    community: string,
    fullNames: readonly string[],
    now: Date,
  ): Promise<GitHubRoomLinkRequest[]> {
    const normalized = [...new Set(fullNames.map((name) => name.toLowerCase()))].filter(Boolean);
    if (normalized.length === 0) return [];
    const result = await ctx.database.query<
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


  export async function authStoreClaimGitHubWebhookDelivery(ctx: AuthStore, deliveryId: string, now: Date): Promise<boolean> {
    const result = await ctx.database.query(
      `INSERT INTO beeline_github_webhook_deliveries (delivery_id, received_at)
       VALUES ($1, $2) ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, now],
    );
    return result.rowCount === 1;
  }
