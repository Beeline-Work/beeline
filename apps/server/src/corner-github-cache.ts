import type { SqlDatabase } from './database.js';

/**
 * GitHub's display cache for a corner (`corner_github_cache`): PR, checks and
 * mergeability as GitHub and the helper last reported them. It is never corner
 * state; `github-operations.ts` and the helper reports below write it.
 */

/** The corner's cached `lifecycle` jsonb, read by primary key. */
export function cornerLifecycleSql(cornerId: string): string {
  return `(SELECT cache.lifecycle FROM corner_github_cache cache WHERE cache.corner_id=${cornerId})`;
}

/** Replace the cached lifecycle with one the caller computed under the corner lock. */
export async function writeCornerGithubCache(
  db: Pick<SqlDatabase, 'query'>, cornerId: string, lifecycle: object,
): Promise<void> {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [cornerId, JSON.stringify(lifecycle)]);
}

/**
 * A helper's remote-state heartbeat. A heartbeat never ends a corner, and it
 * is lower authority than GitHub's PR and check facts.
 */
export async function recordHelperRemoteState(
  db: Pick<SqlDatabase, 'query'>, cornerId: string, lifecycle: object,
): Promise<void> {
  await db.query(
    `INSERT INTO corner_github_cache(corner_id,lifecycle)
     VALUES($1,$2::jsonb)
     ON CONFLICT(corner_id) DO UPDATE SET
       lifecycle=CASE
         -- A helper's restart heartbeat is lower authority than GitHub's PR/check facts.
         -- Keep the complete webhook-owned lifecycle so it cannot lose the PR, mergeability,
         -- or check summary.
         WHEN EXCLUDED.lifecycle->>'lifecycle'='working' AND corner_github_cache.lifecycle ? 'pr'
           THEN corner_github_cache.lifecycle-'branch'
         ELSE (corner_github_cache.lifecycle-'branch') || EXCLUDED.lifecycle
       END`,
    [cornerId, JSON.stringify(lifecycle)],
  );
}
