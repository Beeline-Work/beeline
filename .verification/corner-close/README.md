# R1 corner close proof

Production reproduction (recorded in brief revision 4): the owner closed settings-flow-prototype with PR 2741 open and a merge hold active on 2026-10-22 at 02:05 UTC. The phone operation returned HTTP 409 asking for `close_corner_pr` first.

## Built service demonstration

Run `npm run build -w @beeline/server`, then `node --import tsx .verification/corner-close/prove.mjs`.

The script runs the built HTTP server against a disposable PGlite database. It sends authenticated phone and agent close requests, calls the existing GitHubOperations close path with mocked GitHub, and asserts that the corner archives and its merge hold remains active. Both requests are repeated with GitHub throwing. All four paths pass; see [results.txt](results.txt). No production data or PR is changed by this stand-in.

Validation: full lifecycle/refusal suites (247 tests), root typecheck and dead-code pass. After adding the merged-PR exclusion, the affected R1 and lock tests pass (23 tests). Dead-code baseline is unchanged.

## Browser proof pending

Trusty Squire opened web.usebeeline.app in session `289ff28b-1285-4068-81eb-48a4fce4182e` and found an existing lunchboxfortwo session. Secure loading of the vaulted reviewer bypass (`operate_login`, `load_saved`, field `value`) failed: `POST /v1/vault/browser-fill → 400 unsupported_credential_type`. The live browser card in this corner is awaiting reviewer sign-in and handback. No disposable production corner was closed and no real GitHub close was demonstrated. This branch has not been released; releases are excluded by the brief.

Updating the PR description through the connected personal GitHub route failed: HTTP 403 `Resource not accessible by personal access token` (requires `pull_requests=write`). [PR.md](PR.md) contains the replacement description pending connection repair. No alternate identity was used to bypass that refusal.
