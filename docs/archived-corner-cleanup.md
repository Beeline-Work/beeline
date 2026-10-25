# Archived corner GitHub cleanup

Closing a corner commits PR-close intent in `corner_pr_closures` alongside archival. The background leader leases pending closures, calls the existing `GitHubOperations.closeCornerPullRequest` path, and retries provider failures hourly without discarding intent. Closing a PR refuses merged PRs and branches used as the base of an open PR. Closing a corner never merges a PR or releases a hold.

Branch cleanup rechecks the live default branch, protection, open head/base PRs, commit containment and active corners before deleting. Historical jobs and unmerged corners retain branches with commits absent from the default branch, with a recorded reason. Ordinary confirmed merge cleanup keeps its existing behavior, including squash merges; the historical backfill explicitly requires containment even for merged corners. Temporary open-PR and active-corner blockers remain pending and are checked daily. Provider errors retain the existing bounded exponential retry policy. Reserved/default/protected branches remain retained.

Historical reconciliation is an explicit maintenance operation, separate from migrations. **Wait until all serving workers run the containment guard before applying it.** Enqueueing history during a rolling deployment could expose it to an older deletion worker.

With `MIGRATION_DATABASE_URL` supplied through the established secret environment, inspect or apply:

```sh
node --import tsx apps/server/src/corner-cleanup-cli.ts
node --import tsx apps/server/src/corner-cleanup-cli.ts --apply
```

The command checks schema compatibility. Apply runs the idempotent `archived-corner-github-cleanup-v1` backfill, queues historical PR closures and branch deletions, and requeues legacy temporary blockers. Missing repository mappings become completed retention records instead of disappearing from coverage. It never pushes commits. The existing background leader performs provider calls after commit, under its normal guards. Repeat the read-only command after jobs drain to get counts and the retained-branch list. `deleted_or_already_absent` includes missing remote refs; `kept_with_reason` includes temporarily blocked jobs, so it can overlap `pending`.

For Reproduction CLEANUP-GIT-1, compare all open PR heads to archived `corner_facts.feature_branch` values in the same repository. Recheck every recorded historical PR against GitHub as well, since older code may have cleared its association. The approved throwaway CI drafts have no corresponding corner records and require a separately authorized direct PR-close route; do not fabricate a corner association.

The service-level regression in `corner-lifecycle.test.ts` exercises phone close during a GitHub outage, durable retry, historical backfill, retention of unpublished commits, and deletion after temporary blockers clear. The isolated database and mocked GitHub boundary are the stand-in for a production deployment; they do not prove production reconciliation completed.
