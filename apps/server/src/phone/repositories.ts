import { type PushLevel } from '@beeline/api-contract/phone';
import type { PhoneContext } from './context.js';
import { Input, RoomRow } from './types.js';
import { phoneRequireRoomWorkspaceManager, phoneRequireIdentity } from './access.js';
import { unix } from './values.js';


  export async function phoneSetRepository(ctx: PhoneContext, input: Input<'setRoomRepository'>, viewerId: string) {
    await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId);
    await ctx.database.transaction(async (db) => {
      if (input.githubInstallationId !== undefined) {
        const repositoryId = input.key.match(/^github:(\d+)$/)?.[1];
        const fullName = input.remote.match(/^git:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/i)?.[1];
        if (!repositoryId || !fullName || input.name.toLowerCase() !== fullName.toLowerCase())
          throw new Error('GitHub repository binding is invalid');
        const access = await db.query(
          `SELECT 1 FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE r.repository_id=$1 AND r.installation_id=$2 AND lower(r.full_name)=lower($3) AND r.active AND i.owner_id=$4 AND i.status='active'`,
          [repositoryId, input.githubInstallationId, fullName, viewerId],
        );
        if (!access.rowCount) throw new Error('GitHub repository access denied');
      }
      await db.query(
        `UPDATE rooms SET repository_key=$2,repository_name=$3,repository_remote=$4,repository_target_branch=$5,github_installation_id=$6,repository_updated_at=now(),repository_resolution='repository',updated_at=now() WHERE id=$1`,
        [
          input.roomId,
          input.key,
          input.name,
          input.remote,
          input.targetBranch,
          input.githubInstallationId ?? null,
        ],
      );
      if (input.githubInstallationId !== undefined) {
        await db.query(
          `INSERT INTO repository_link_successes(identity_id,workspace_id)
         SELECT $2,workspace_id FROM rooms WHERE id=$1
         ON CONFLICT DO NOTHING`,
          [input.roomId, viewerId],
        );
      }
    });
    return phoneRoomRepository(ctx, input.roomId);
  }

  /**
   * Sever the Room→repository association: the Room becomes chat-only.
   *
   * This clears only the binding columns on the Room row. The repository
   * itself, the Room, its messages, and its history are untouched, and any
   * corner already opened from this Room keeps its own copy of the binding
   * (corners carry their repository columns independently of the parent).
   * Deliberately idempotent: unassigning an already chat-only Room is a
   * quiet no-op, so a retried call succeeds.
   */
  export async function phoneRemoveRepositoryBinding(ctx: PhoneContext, input: Input<'removeRoomRepository'>, viewerId: string) {
    await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId);
    await ctx.database.query(
      `UPDATE rooms
       SET repository_key=NULL,repository_name=NULL,repository_remote=NULL,
           repository_target_branch='main',github_installation_id=NULL,
           repository_resolution='none',
           repository_updated_at=now(),updated_at=now()
       WHERE id=$1`,
      [input.roomId],
    );
  }

  export async function phoneRoomRepository(ctx: PhoneContext, roomId: string) {
    const row = (await ctx.database.query<RoomRow>(`SELECT rooms.* FROM rooms WHERE id=$1`, [roomId]))
      .rows[0];
    if (!row?.repository_key || !row.repository_remote)
      throw new Error('room repository not configured');
    return {
      channelId: roomId,
      binding: {
        key: row.repository_key,
        name: row.repository_name ?? row.repository_key,
        remote: row.repository_remote,
        localOnly: false as const,
        ...(row.github_installation_id
          ? { githubInstallationId: Number(row.github_installation_id) }
          : {}),
      },
      targetBranch: row.repository_target_branch,
      updatedAt: unix(row.repository_updated_at ?? row.updated_at),
      githubEventsEnabled: true,
      source: 'config' as const,
    };
  }

  export async function phoneSetTargetBranch(ctx: PhoneContext, input: Input<'setRoomTargetBranch'>, viewerId: string) {
    await phoneRequireRoomWorkspaceManager(ctx, input.roomId, viewerId);
    const decider = await phoneRequireIdentity(ctx, viewerId);
    await ctx.database.transaction(async database => {
      const updated = await database.query(
        `UPDATE rooms SET repository_target_branch=$2,repository_updated_at=now(),updated_at=now() WHERE id=$1 AND repository_key IS NOT NULL AND repository_remote IS NOT NULL`,
        [input.roomId, input.targetBranch],
      );
      if (!updated.rowCount) throw new Error('room repository not configured');
      await database.query(`UPDATE messages SET card=card || $3::jsonb WHERE room_id=$1 AND card_type='target-branch' AND card->>'to'=$2 AND card->>'status' IS NULL`,
        [input.roomId, input.targetBranch, JSON.stringify({ status: 'allowed', decidedBy: decider, decidedAt: Math.floor(Date.now()/1000) })]);
    });
    return phoneRoomRepository(ctx, input.roomId);
  }

  export async function phoneManagedIdentity(ctx: PhoneContext, viewerId: string) {
    const id = await phoneRequireIdentity(ctx, viewerId);
    const preferences = (
      await ctx.database.query<{ push_level: import('@beeline/api-contract/phone').PushLevel; speaking_speed: number }>(
        `SELECT push_level,speaking_speed FROM identities WHERE id=$1`,
        [viewerId],
      )
    ).rows[0];
    const links = await ctx.database.query<{
      provider: 'google' | 'github';
      provider_login: string | null;
      reconnect: boolean;
    }>(
      `SELECT link.provider,link.provider_login,
         (link.provider='github' AND (token.subject IS NULL OR token.stale_at IS NOT NULL)) AS reconnect
       FROM identity_external_links link LEFT JOIN github_user_tokens token
         ON link.provider='github' AND token.subject=link.subject
       WHERE link.identity_id=$1 AND link.provider IN ('google','github') ORDER BY link.provider`,
      [viewerId],
    );
    return {
      providers: links.rows.map((link) => ({
        provider: link.provider,
        reconnect: link.reconnect,
        ...(link.provider_login ? { login: link.provider_login } : {}),
      })),
      personId: id.pubkey,
      name: id.name,
      ...(id.handle ? { handle: id.handle } : {}),
      ...(id.avatar ? { avatar: id.avatar } : {}),
      ...(id.face ? { face: id.face } : {}),
      pushLevel: preferences?.push_level ?? 'attention',
      speakingSpeed: preferences?.speaking_speed === 1.3 ? 1.3 as const : preferences?.speaking_speed === 1.5 ? 1.5 as const : 1.15 as const,
    };
  }

  export async function phoneClaimManagedHandle(ctx: PhoneContext, viewerId: string, handle: string) {
    if (['channel', 'system', 'play-review', 'review', 'scheduler'].includes(handle))
      throw new Error('invalid reserved handle');
    await ctx.database.transaction(async (database) => {
      const claimed = await database.query(
        `WITH target AS MATERIALIZED (SELECT id FROM identities WHERE id=$1 FOR UPDATE),
         chosen AS MATERIALIZED (SELECT beeline_identity_handle($1,$2,true) handle FROM target)
         UPDATE identities SET handle=chosen.handle,updated_at=now() FROM chosen
         WHERE identities.id=$1 AND chosen.handle=$2`,[viewerId,handle]);
      if (claimed.rowCount === 0) throw new Error('managed handle is already claimed');
    });
  }

  export async function phoneAdoptGitHubHandle(ctx: PhoneContext, viewerId: string) {
    const link = (
      await ctx.database.query<{ provider_login: string | null }>(
        `SELECT provider_login FROM identity_external_links
         WHERE provider='github' AND identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (!link?.provider_login) throw new Error('GitHub handle is not available');
    await phoneClaimManagedHandle(ctx, viewerId, link.provider_login.toLowerCase());
    return phoneManagedIdentity(ctx, viewerId);
  }

  export async function phoneIdentityRecovery(ctx: PhoneContext, viewerId: string) {
    const rows = await ctx.database.query<{ id: string; handle: string | null }>(
      `WITH RECURSIVE predecessors(id) AS (SELECT old_identity_id FROM identity_successions WHERE new_identity_id=$1 UNION ALL SELECT s.old_identity_id FROM identity_successions s JOIN predecessors p ON s.new_identity_id=p.id) SELECT i.id,i.handle FROM predecessors p JOIN identities i ON i.id=p.id`,
      [viewerId],
    );
    return {
      candidates: rows.rows.map((row) => ({
        personId: row.id,
        ...(row.handle ? { handle: row.handle } : {}),
      })),
    };
  }

  export async function phoneListRepositories(ctx: PhoneContext, viewerId: string) {
    const installations = await ctx.database.query<{
      installation_id: string;
      account_id: string | null;
      account_login: string;
      account_type: 'User' | 'Organization';
      account_avatar_url: string | null;
      repository_selection: 'all' | 'selected';
      status: 'active' | 'revoked' | 'suspended';
      repository_count: string;
    }>(
      `SELECT i.*,count(r.repository_id) FILTER (WHERE r.active)::text repository_count FROM github_installations i LEFT JOIN github_repositories r USING(installation_id) WHERE i.owner_id=$1 GROUP BY i.installation_id ORDER BY lower(i.account_login),i.installation_id`,
      [viewerId],
    );
    const rows = await ctx.database.query<{
      repository_id: string;
      full_name: string;
      installation_id: string;
      default_branch: string;
      private: boolean | null;
    }>(
      `SELECT r.* FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE i.owner_id=$1 AND i.status='active' AND r.active`,
      [viewerId],
    );
    return {
      installed: installations.rows.some((row) => row.status === 'active'),
      installations: installations.rows.map((row) => ({
        installationId: Number(row.installation_id),
        // Pre-cutover imports did not retain GitHub's numeric account id. The
        // login is still a stable, non-empty display grouping until the next
        // refresh backfills the authoritative id from GitHub.
        accountId: row.account_id ?? row.account_login,
        accountLogin: row.account_login,
        accountType: row.account_type,
        ...(row.account_avatar_url ? { accountAvatarUrl: row.account_avatar_url } : {}),
        repositorySelection: row.repository_selection,
        status: row.status,
        repositoryCount: Number(row.repository_count),
        manageUrl:
          row.account_type === 'Organization'
            ? `https://github.com/organizations/${encodeURIComponent(row.account_login)}/settings/installations/${row.installation_id}`
            : `https://github.com/settings/installations/${row.installation_id}`,
      })),
      repositories: rows.rows.map((row) => ({
        id: Number(row.repository_id),
        fullName: row.full_name,
        installationId: Number(row.installation_id),
        defaultBranch: row.default_branch,
        // Rows stored before GitHub's flag was recorded read as private until
        // the next installation refresh backfills it.
        private: row.private !== false,
      })),
    };
  }

  export async function phoneRepositoryAccess(ctx: PhoneContext, fullName: string, viewerId: string) {
    const row = await ctx.database.query(
      `SELECT 1 FROM github_repositories r JOIN github_installations i USING(installation_id) WHERE lower(r.full_name)=lower($1) AND i.owner_id=$2 AND r.active`,
      [fullName, viewerId],
    );
    return {
      accessible: row.rowCount > 0,
      ...(!row.rowCount ? { reason: 'repository_not_installed' } : {}),
    };
  }
