import { GitHubCredentialRejectedError } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import { GitHubOperations } from './github-operations.js';


  export async function gitHubOperationsUserCredential(ctx: GitHubOperations,
    viewerId: string,
    database: SqlDatabase,
  ): Promise<
    { subject: string; token?: string; refreshToken?: string; reconnectNeeded?: true } | undefined
  > {
    const credential = (
      await database.query<{
        subject: string;
        stale_at: string | Date | null;
        encrypted_token: string | null;
        encrypted_refresh_token: string | null;
        expires_at: string | Date | null;
      }>(
        `SELECT l.subject,t.encrypted_token,t.encrypted_refresh_token,t.expires_at,t.stale_at FROM identity_external_links l LEFT JOIN github_user_tokens t ON t.subject=l.subject WHERE l.provider='github' AND l.identity_id=$1`,
        [viewerId],
      )
    ).rows[0];
    if (!credential) return undefined;
    const sealed =
      credential.encrypted_token ?? (await ctx.resolveSealedUserToken?.(credential.subject));
    if (!sealed) return { subject: credential.subject };
    const refreshToken = credential.encrypted_refresh_token
      ? ctx.open(credential.encrypted_refresh_token)
      : undefined;
    if (credential.stale_at && !refreshToken) return { subject: credential.subject };
    const token = ctx.open(sealed);
    const expiresAt = credential.expires_at ? new Date(credential.expires_at).getTime() : undefined;
    if (
      refreshToken &&
      (credential.stale_at || (expiresAt !== undefined && expiresAt - Date.now() < 60_000))
    ) {
      const rotated = await ctx.rotateUserCredential(
        { subject: credential.subject, refreshToken },
        database,
      );
      // Do not reuse the consumed refresh grant after proactive rotation.
      return rotated
        ? { subject: credential.subject, token: rotated }
        : { subject: credential.subject };
    }
    return {
      subject: credential.subject,
      token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(!refreshToken && expiresAt !== undefined && expiresAt <= Date.now()
        ? { reconnectNeeded: true as const }
        : {}),
    };
  }

  export async function gitHubOperationsRotateUserCredential(ctx: GitHubOperations,
    credential: { subject: string; refreshToken?: string },
    database: SqlDatabase,
  ): Promise<string | undefined> {
    if (!credential.refreshToken) return undefined;
    return database.transaction(async (database) => {
      // Serialize one-use refresh grants with each other and fresh reconnects.
      const row = (
        await database.query<{
          encrypted_token: string;
          encrypted_refresh_token: string | null;
          stale_at: Date | null;
        }>(
          `SELECT encrypted_token,encrypted_refresh_token,stale_at FROM github_user_tokens WHERE subject=$1 FOR UPDATE`,
          [credential.subject],
        )
      ).rows[0];
      if (!row) return undefined;
      if (
        !row.encrypted_refresh_token ||
        ctx.open(row.encrypted_refresh_token) !== credential.refreshToken
      ) {
        return ctx.open(row.encrypted_token);
      }
      try {
        const refreshed = await ctx.oauth.refreshUserToken(credential.refreshToken);
        await database.query(
          `UPDATE github_user_tokens SET encrypted_token=$2,encrypted_refresh_token=COALESCE($3,encrypted_refresh_token),expires_at=$4,stale_at=NULL,updated_at=now() WHERE subject=$1`,
          [
            credential.subject,
            ctx.seal(refreshed.accessToken),
            refreshed.refreshToken ? ctx.seal(refreshed.refreshToken) : null,
            refreshed.tokenExpiresIn
              ? new Date(Date.now() + refreshed.tokenExpiresIn * 1000)
              : null,
          ],
        );
        return refreshed.accessToken;
      } catch (error) {
        if (!(error instanceof GitHubCredentialRejectedError)) throw error;
        await database.query(
          `UPDATE github_user_tokens SET encrypted_refresh_token=NULL,stale_at=now(),updated_at=now() WHERE subject=$1`,
          [credential.subject],
        );
        return undefined;
      }
    });
  }

  export async function gitHubOperationsStoreRepository(ctx: GitHubOperations,
    repository: {
      id: number;
      installationId: number;
      fullName: string;
      defaultBranch: string;
      private: boolean;
      allowAutoMerge: boolean;
    },
    database: SqlDatabase,
  ) {
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,private,allow_auto_merge) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(repository_id) DO UPDATE SET installation_id=EXCLUDED.installation_id,full_name=EXCLUDED.full_name,default_branch=EXCLUDED.default_branch,private=EXCLUDED.private,allow_auto_merge=EXCLUDED.allow_auto_merge,active=true,updated_at=now()
       WHERE (github_repositories.installation_id,github_repositories.full_name,github_repositories.default_branch,github_repositories.private,github_repositories.allow_auto_merge,github_repositories.active)
         IS DISTINCT FROM (EXCLUDED.installation_id,EXCLUDED.full_name,EXCLUDED.default_branch,EXCLUDED.private,EXCLUDED.allow_auto_merge,true)`,
      [
        repository.id,
        repository.installationId,
        repository.fullName,
        repository.defaultBranch,
        repository.private,
        repository.allowAutoMerge,
      ],
    );
  }
