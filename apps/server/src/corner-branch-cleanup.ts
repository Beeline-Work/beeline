import { GitHubHttpError, type GitHubAppClient } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';

const MAX_ATTEMPTS = 8;

/** Persist intent with archival, so a crash cannot lose the cleanup. */
export async function enqueueCornerBranchDeletion(database: SqlDatabase, cornerId?: string, historical = false) {
  await database.query(
    `INSERT INTO corner_branch_deletions(corner_id,branch,installation_id,repository_id,repository,finished_at,last_error,require_containment)
     SELECT fact.corner_id,fact.feature_branch,repository.installation_id,repository.repository_id,repository.full_name,
       CASE WHEN repository.repository_id IS NULL THEN now() END,
       CASE WHEN repository.repository_id IS NULL THEN 'GitHub repository is unavailable; branch retained' END,$2
     FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
     JOIN rooms parent ON parent.id=corner.parent_id
     LEFT JOIN github_repositories repository ON repository.installation_id=parent.github_installation_id
       AND repository.active AND (parent.repository_key='github:'||repository.repository_id::text
         OR lower(repository.full_name)=lower(regexp_replace(regexp_replace(
           COALESCE(parent.repository_remote,parent.repository_key,''),
           '^(git://|https://)github.com/','','i'), '\\.git$','','i')))
     WHERE ($1::uuid IS NULL OR fact.corner_id=$1) AND fact.feature_branch IS NOT NULL
       AND corner.archived_at IS NOT NULL
     ON CONFLICT (corner_id) DO NOTHING`, [cornerId ?? null, historical],
  );
}

/** Called by the background leader, after archival transactions have committed. */
export async function retryCornerBranchDeletions(database: SqlDatabase, app: GitHubAppClient, cornerId?: string) {
  const due = await database.query<{ corner_id: string }>(
    `SELECT corner_id FROM corner_branch_deletions
     WHERE finished_at IS NULL AND next_attempt_at<=now()
       AND ($1::uuid IS NULL OR corner_id=$1)
     ORDER BY next_attempt_at LIMIT 10`, [cornerId ?? null],
  );
  for (const { corner_id: cornerId } of due.rows) {
    // A bounded lease also recovers a process that died during a provider call.
    const claimed = await database.query<{ branch: string; attempts: number; require_containment: boolean }>(
      `UPDATE corner_branch_deletions SET attempts=attempts+1,
         next_attempt_at=now()+interval '5 minutes'
       WHERE corner_id=$1 AND finished_at IS NULL AND next_attempt_at<=now()
       RETURNING branch,attempts,require_containment`, [cornerId],
    );
    const job = claimed.rows[0];
    if (!job) continue;
    let reason: string | undefined;
    try {
      if (job.attempts > MAX_ATTEMPTS) throw new Error('cleanup lease expired on final attempt');
      const target = (await database.query<{
        repository_id: string; installation_id: string; full_name: string; archived_at: unknown; merged: boolean;
      }>(
        `SELECT job.repository_id,job.installation_id,job.repository full_name,corner.archived_at,
           fact.workflow_state='landed' merged
         FROM corner_branch_deletions job JOIN rooms corner ON corner.id=job.corner_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         JOIN github_repositories repository ON repository.repository_id=job.repository_id
           AND repository.installation_id=job.installation_id AND repository.active
         WHERE job.corner_id=$1`, [cornerId],
      )).rows[0];
      if (!target) throw new Error('GitHub repository is unavailable');
      if (!target.archived_at) throw new Error('corner is not archived yet');
      if (/^(main|master|releases?(?:[\/_.-].*)?)$/i.test(job.branch)) {
        reason = 'reserved or release branch';
      } else {
        const token = await app.installationToken(Number(target.installation_id), {
          repositoryIds: [Number(target.repository_id)],
        });
        const safety = await app.branchDeletionSafety(token.token, target.full_name, job.branch);
        if (!safety) {
          // GitHub already removed this branch.
        } else if (safety.protected || safety.defaultBranch === job.branch) {
          reason = 'default or protected branch';
        } else if (safety.openBasePullRequest
          || (await app.openPullRequestsForBranch(token.token, target.full_name, job.branch)).length) {
          reason = 'branch is used by an open pull request';
        } else if (safety.aheadBy !== 0 && (job.require_containment || !target.merged)) {
          reason = 'branch has commits absent from the default branch';
        } else {
          // Recheck every live corner immediately before the destructive call.
          const shared = await database.query(
            `SELECT 1 FROM corner_facts fact
             JOIN rooms corner ON corner.id=fact.corner_id
             JOIN rooms parent ON parent.id=corner.parent_id
             WHERE fact.feature_branch=$1 AND corner.archived_at IS NULL
               AND (parent.repository_key='github:'||$3::text OR lower(regexp_replace(regexp_replace(
                 COALESCE(parent.repository_remote,parent.repository_key,''),
                 '^(git://|https://)github.com/','','i'), '\\.git$','','i'))=lower($2))
             LIMIT 1`, [job.branch, target.full_name, String(target.repository_id)],
          );
          if (shared.rowCount) reason = 'branch is used by an unarchived corner';
          else {
            try {
              await app.deleteBranch(Number(target.installation_id), Number(target.repository_id),
                target.full_name, job.branch);
            } catch (error) {
              if (!(error instanceof GitHubHttpError && (error.status === 404 || error.status === 422))) throw error;
            }
          }
        }
      }
      await database.query(
        `UPDATE corner_branch_deletions SET
           finished_at=CASE WHEN $3 THEN NULL ELSE now() END,last_error=$2,
           next_attempt_at=now()+interval '1 day',
           attempts=CASE WHEN $3 THEN 0 ELSE attempts END WHERE corner_id=$1`,
        [cornerId, reason ?? null, reason === 'branch is used by an open pull request'
          || reason === 'branch is used by an unarchived corner'],
      );
      if (reason) console.info(`[server] branch cleanup kept ${job.branch}: ${reason}`);
    } catch (error) {
      const exhausted = job.attempts >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : String(error);
      await database.query(
        `UPDATE corner_branch_deletions
         SET finished_at=CASE WHEN $2 THEN now() ELSE NULL END,last_error=$3,
             next_attempt_at=now()+($4 * interval '1 second') WHERE corner_id=$1`,
        [cornerId, exhausted, message,
          Math.min(86400, 60 * 2 ** (job.attempts - 1))],
      );
      console.error(`[server] branch cleanup ${exhausted ? 'gave up' : 'will retry'} ${job.branch}: ${message}`);
    }
  }
}
