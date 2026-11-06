import type { QueryResultRow } from 'pg';
import { AuthStore, GITHUB_REPO_EVENT_RETENTION_MS, ManagedIdentity, ManagedIdentityRow, SqlResult, managedIdentityFromRow } from './store.js';



  export async function authStoreReleaseGitHubWebhookDelivery(ctx: AuthStore, deliveryId: string): Promise<void> {
    await ctx.database.query(
      `DELETE FROM beeline_github_webhook_deliveries WHERE delivery_id = $1`,
      [deliveryId],
    );
  }


  /** Store extracted repository-activity events; a repeated delivery is a no-op. */
  export async function authStoreSaveGitHubRepoEvents(ctx: AuthStore,
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
      await ctx.database.query(
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
    await ctx.database.query(`DELETE FROM beeline_github_repo_events WHERE received_at < $1`, [
      new Date(now.getTime() - GITHUB_REPO_EVENT_RETENTION_MS),
    ]);
  }


  /** The stored activity for one repository newer than `sinceId`, oldest first. */
  export async function authStoreGithubRepoEvents(ctx: AuthStore,
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
    const result = await ctx.database.query<
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
  export async function authStoreLatestGitHubRepoEventId(ctx: AuthStore, fullName: string): Promise<number> {
    const result = await ctx.database.query<QueryResultRow & { id: string | number }>(
      `SELECT MAX(id) AS id FROM beeline_github_repo_events WHERE full_name = $1`,
      [fullName],
    );
    const value = result.rows[0]?.id;
    return value === null || value === undefined ? 0 : Number(value);
  }


  export async function authStoreSaveGitHubUserToken(ctx: AuthStore,
    community: string,
    subject: string,
    encryptedToken: string,
    now: Date,
    credential: { encryptedRefreshToken?: string; expiresAt?: Date } = {},
  ): Promise<void> {
    await ctx.database.query(
      `INSERT INTO beeline_github_user_tokens (community, subject, encrypted_token, updated_at, stale_at, encrypted_refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6)
       ON CONFLICT (community, subject) DO UPDATE SET
         encrypted_token = EXCLUDED.encrypted_token, updated_at = EXCLUDED.updated_at,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, expires_at = EXCLUDED.expires_at,
         stale_at = NULL`,
      [
        community,
        subject,
        encryptedToken,
        now,
        credential.encryptedRefreshToken ?? null,
        credential.expiresAt ?? null,
      ],
    );
  }


  export async function authStoreGithubUserCredential(ctx: AuthStore, community: string, subject: string) {
    const result = await ctx.database.query<
      QueryResultRow & {
        encryptedToken: string;
        encryptedRefreshToken: string | null;
        expiresAt: Date | null;
      }
    >(
      `SELECT encrypted_token AS "encryptedToken", encrypted_refresh_token AS "encryptedRefreshToken",
              expires_at AS "expiresAt" FROM beeline_github_user_tokens
       WHERE community=$1 AND subject=$2 AND stale_at IS NULL`,
      [community, subject],
    );
    return result.rows[0];
  }


  export async function authStoreGithubUserToken(ctx: AuthStore, community: string, subject: string): Promise<string | null> {
    const result = await ctx.database.query<QueryResultRow & { encrypted_token: string }>(
      `SELECT encrypted_token FROM beeline_github_user_tokens
       WHERE community = $1 AND subject = $2`,
      [community, subject],
    );
    return result.rows[0]?.encrypted_token ?? null;
  }


  /** A stored user token GitHub answered 401/403 with — the app can silently re-auth. */
  export async function authStoreMarkGitHubUserTokenStale(ctx: AuthStore, community: string, subject: string, now: Date): Promise<void> {
    // Only the FIRST observation is interesting; a newer credential that has
    // not been replaced yet keeps its original stale-since stamp.
    await ctx.database.query(
      `UPDATE beeline_github_user_tokens SET stale_at = COALESCE(stale_at, $3)
       WHERE community = $1 AND subject = $2`,
      [community, subject, now],
    );
  }


  export async function authStoreClearGitHubUserTokenStale(ctx: AuthStore, community: string, subject: string): Promise<void> {
    await ctx.database.query(
      `UPDATE beeline_github_user_tokens SET stale_at = NULL
       WHERE community = $1 AND subject = $2 AND stale_at IS NOT NULL`,
      [community, subject],
    );
  }


  export async function authStoreGithubUserTokenStaleAt(ctx: AuthStore, community: string, subject: string): Promise<Date | null> {
    const result = await ctx.database.query<QueryResultRow & { stale_at: string | Date | null }>(
      `SELECT stale_at FROM beeline_github_user_tokens
       WHERE community = $1 AND subject = $2`,
      [community, subject],
    );
    const raw = result.rows[0]?.stale_at;
    if (!raw) return null;
    const date = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }


  export async function authStoreClaimGitHubInstallationReconciliation(ctx: AuthStore,
    community: string,
    subject: string,
    now: Date,
    retryAfter: Date,
  ): Promise<boolean> {
    const result = await ctx.database.query<QueryResultRow>(
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


  /** Reconcile a verified GitHub login onto the already-bound device key. */
  export async function authStoreProvisionGitHubIdentity(ctx: AuthStore,
    community: string,
    subject: string,
    pubkey: string,
    login: string,
    displayName: string,
    now: Date,
  ): Promise<ManagedIdentity> {
    return ctx.database.transaction(async (transaction) => {
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


  export async function authStoreManagedIdentity(ctx: AuthStore, community: string, pubkey: string): Promise<ManagedIdentity | null> {
    const result = await ctx.database.query<ManagedIdentityRow>(
      `SELECT handle, display_name, source, github_login, github_rename_available
       FROM beeline_identity_handles
       WHERE community = $1 AND pubkey = $2`,
      [community, pubkey],
    );
    return result.rows[0] ? managedIdentityFromRow(result.rows[0]) : null;
  }


  /** Consume the single GitHub-handle rename offered after an in-place link. */
  export async function authStoreAdoptGitHubHandle(ctx: AuthStore,
    community: string,
    pubkey: string,
    now: Date,
  ): Promise<{ status: 'renamed'; identity: ManagedIdentity } | { status: 'unavailable' }> {
    return ctx.database.transaction(async (transaction) => {
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


  export async function authStoreClose(ctx: AuthStore): Promise<void> {
    await ctx.database.close();
  }
