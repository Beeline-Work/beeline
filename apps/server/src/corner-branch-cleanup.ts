import { GitHubHttpError, type GitHubAppClient } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import { cornerFeatureBranch, cornerFeatureBranchSql } from './corner-branch.js';

export interface CornerBranchCleanupResult {
  cornerId: string;
  branch: string;
  status: 'deleted_or_already_absent' | 'kept' | 'failed';
  reason?: string;
}

/** Called once by an archival caller after commit, or explicitly by maintenance. */
export async function deleteArchivedCornerBranch(
  database: SqlDatabase,
  app: GitHubAppClient,
  cornerId: string,
  requireContainment = false,
): Promise<CornerBranchCleanupResult> {
  const branch = cornerFeatureBranch(cornerId);
  const kept = (reason: string): CornerBranchCleanupResult => {
    console.info(`[server] branch cleanup kept ${branch}: ${reason}`);
    return { cornerId, branch, status: 'kept', reason };
  };
  try {
    const target = (await database.query<{
      repository_id: string | null; installation_id: string | null; full_name: string | null;
      archived_at: unknown; merged: boolean; merged_head: string | null; merged_at: string | null;
    }>(
      `SELECT repository.repository_id,repository.installation_id,repository.full_name,corner.archived_at,
         fact.workflow_state='landed' merged,
         fact.lifecycle->'pr'->>'headSha' merged_head,fact.lifecycle->'pr'->>'mergedAt' merged_at
       FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
         AND repository.active AND (parent.repository_key='github:'||repository.repository_id::text
           OR lower(repository.full_name)=lower(regexp_replace(regexp_replace(
             COALESCE(parent.repository_remote,parent.repository_key,''),
             '^(git://|https://)github.com/','','i'), '\\.git$','','i')))
       WHERE corner.id=$1`, [cornerId],
    )).rows[0];
    if (!target?.archived_at) return kept('corner is not archived');
    if (!target.repository_id || !target.installation_id || !target.full_name)
      return kept('GitHub repository is unavailable');
    if (/^(main|master|releases?(?:[\/_.-].*)?)$/i.test(branch)) return kept('reserved or release branch');
    const token = await app.installationToken(Number(target.installation_id), {
      repositoryIds: [Number(target.repository_id)],
    });
    const safety = await app.branchDeletionSafety(token.token, target.full_name, branch);
    if (safety) {
      if (safety.protected || safety.defaultBranch === branch) return kept('default or protected branch');
      if (safety.openBasePullRequest
        || (await app.openPullRequestsForBranch(token.token, target.full_name, branch)).length)
        return kept('branch is used by an open pull request');
      if (safety.aheadBy !== 0 && (requireContainment || !target.merged)) {
        // Squash merges do not contain their original commits. Maintenance may
        // remove only the exact merged head, never later unpublished commits.
        const exactMergedHead = target.merged && target.merged_at && target.merged_head
          && await app.readBranchHead(token.token, target.full_name, branch) === target.merged_head;
        if (!exactMergedHead) return kept('branch has commits absent from the default branch');
      }
      const shared = await database.query(
        `SELECT 1 FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
         JOIN rooms parent ON parent.id=corner.parent_id
         WHERE ${cornerFeatureBranchSql('corner')}=$1 AND corner.archived_at IS NULL
           AND parent.github_installation_id=$4
           AND (parent.repository_key='github:'||$3::text OR lower(regexp_replace(regexp_replace(
             COALESCE(parent.repository_remote,parent.repository_key,''),
             '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2))
         LIMIT 1`, [branch, target.full_name, String(target.repository_id), target.installation_id],
      );
      if (shared.rowCount) return kept('branch is used by an unarchived corner');
      try {
        await app.deleteBranch(Number(target.installation_id), Number(target.repository_id), target.full_name, branch);
      } catch (error) {
        if (!(error instanceof GitHubHttpError && (error.status === 404 || error.status === 422))) throw error;
      }
    }
    return { cornerId, branch, status: 'deleted_or_already_absent' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[server] branch cleanup failed for ${branch}: ${reason}`);
    return { cornerId, branch, status: 'failed', reason };
  }
}

/** Missing GitHub configuration and provider failures never undo archival. */
export async function deleteCornerBranchBestEffort(
  cornerId: string,
  deleteBranch?: (cornerId: string) => Promise<unknown>,
): Promise<void> {
  try {
    if (!deleteBranch) throw new Error('GitHub is not configured on this server');
    await deleteBranch(cornerId);
  } catch (error) {
    console.error(`[server] could not delete branch for archived corner ${cornerId}:`, error);
  }
}
