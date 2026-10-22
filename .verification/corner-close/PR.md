Closing a corner now attempts to close its open, unmerged pull request through the existing GitHub path, then archives the corner. GitHub failures are logged and archival still succeeds. Phone and agent close paths retain their authority checks; no mobile copy, confirmation, merge-hold, branch-cleanup, or release changes.

## Reproduced

R1: production on 2026-10-22 at 02:05 UTC, closing settings-flow-prototype with PR #2741 open returned HTTP 409: `close the corner pull request with close_corner_pr before closing the corner`. The owner's active merge hold was unrelated to that refusal.

## Demonstrated

R1 stand-in: a built server and isolated database exercise authenticated HTTP `requestCornerClose` and `archiveCorner`, with an open PR and active merge hold. Both close the PR through `GitHubOperations.closeCornerPullRequest` (mocked GitHub), archive the corner, and preserve the hold. Repeating both requests with GitHub throwing still archives the corner and logs the failure. Phone returns HTTP 204; agent returns HTTP 200. Reproduction script and results: [.verification/corner-close](https://github.com/Beeline-Work/beeline/tree/feature/corner-ae8a92ce7cf9/.verification/corner-close).

Regression suites pass (247 tests); root typecheck and dead-code pass, baseline unchanged. Merged locked corners retain their PR association.

Production browser proof is **pending**. Squire opened web.usebeeline.app and found an existing owner session. Loading the stored reviewer bypass via `operate_login(load_saved)` returned `POST /v1/vault/browser-fill → 400 unsupported_credential_type`. A live browser card is open in the corner for reviewer sign-in and handback. No production corner was closed, and no real GitHub PR-close result is claimed. This branch has not been released; the brief excludes releases.

The previous DEAD CODE failure was dependency installation timing out (`timeout 5m npm ci`, exit 124), before analysis: [failed run](https://github.com/Beeline-Work/beeline/actions/runs/39711369519). Fresh CI after the implementation push remains pending. The timeout has not been changed.
