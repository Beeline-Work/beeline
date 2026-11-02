# Archived corner GitHub cleanup

Closing a corner attempts to close its unmerged PR once through `GitHubOperations.closeCornerPullRequest` (`closeCornerPullRequestBestEffort`). A provider failure is logged and never blocks archival; `close_corner_pr` repairs a PR left open. There is no retry queue: in production it never held a row. Closing a PR refuses merged PRs and branches used as the base of an open PR. Closing a corner never merges a PR; archival releases its active merge holds.

The archival caller makes one best-effort branch deletion attempt after its transaction commits. Confirmed merge archival uses the same guarded deletion path; a locked corner stays open and skips deletion. There is no branch-deletion queue, lease, retry timer or background scan. Provider failures are logged and never block archival. Repeated close or merge events do not repeat the deletion attempt.

Branches derive from the corner ID: `feature/corner-<first 12 hex characters with dashes removed>`. Cleanup rechecks GitHub's live default branch, protection, open head/base PRs and all unarchived corners in that repository before deleting. Reserved and release branches remain retained. An unmerged corner retains a branch with commits absent from the default branch. Missing refs (404/422) count as done. Ordinary confirmed merge cleanup handles squash merges as before.

Historical cleanup is an explicit maintenance operation, separate from migrations. With `MIGRATION_DATABASE_URL` supplied through the established secret environment, inspect or apply:

```sh
node --import tsx apps/server/src/corner-cleanup-cli.ts
node --import tsx apps/server/src/corner-cleanup-cli.ts --apply
```

The command checks schema compatibility. Inspection lists archived corners and their derived branches without contacting GitHub. Apply also requires the established `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` environment configuration; it never prints those values. It scans archived corners itself on every explicit invocation, making guarded branch deletion attempts directly. There is no branch-deletion queue, and it never pushes commits.

Historical deletion requires containment for every branch, including merged corners. A squash-merged branch may be removed only when its live tip equals that corner's recorded merged PR head; later unpublished commits remain protected. Results report `deleted_or_already_absent`, `kept` with a reason, or `failed`. Missing repository mappings retain the branch with an explicit reason. Temporary blockers and provider failures are reconsidered only when an operator explicitly runs maintenance again.

The service-level regressions in `corner-lifecycle.test.ts` exercise historical scans, unpublished commit retention and deletion after an explicitly rechecked blocker clears. `BRANCH-DERIVED` also checks one post-commit deletion with no queue row and no repeated attempt. The isolated database and mocked GitHub boundary do not prove production cleanup completed.
