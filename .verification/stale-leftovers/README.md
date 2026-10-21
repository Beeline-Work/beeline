# Stale leftovers cleanup

This is maintenance, not a defect report. The standalone auth listener and
container are retired; production continues to mount the auth library through
`apps/server/src/monolith-auth.ts`. The standalone-only configuration reader and
PostgreSQL pool adapter are removed. AuthStore and the mounted database contract
remain. The GitHub App setup page now emits the monolith's `GITHUB_*` names.
`BEELINE_AUTH_SETUP_TOKEN` stays because the mounted service reads it.

## Staged unused secrets

On 2026-10-21 at 02:39:58 UTC, staged removal of exactly:

- AWS_REGION
- FISH_AUDIO_API_KEY
- BEELINE_GOOGLE_CLIENT_ID
- BEELINE_GOOGLE_CLIENT_SECRET
- BEELINE_GOOGLE_TOKEN_KEY

Scanned current main `06bf3a7c8998b8cb9841891152d0b2e15ef1a48a` and
Google sign-in branch `2ff17a0d86183c3ce3ff05a9523ab80988470a4e`: the five
names occur only in the historical environment audit, with no source readers.
Google sign-in reads `BEELINE_AUTH_OIDC_*` and `BEELINE_GOOGLE_SIGN_IN*`.
The Downloads corner had no PR and no remote feature branch at this check.

The Fly CLI is absent on this host. Used the connected owner's sealed Fly API
route and the same UpdateAppSecrets operation as `fly secrets unset --stage`:
POST `/v1/apps/beeline-server/secrets` with exactly those five names mapped to
null. No deployment operation was called. API returned version `126180774`.
A subsequent names-only list confirms exactly those five removals, no additions.
Both machine IDs, states and update times are unchanged; see `fly-stage.json`.

Implementation reference:
https://github.com/superfly/flyctl/blob/master/internal/command/secrets/unset.go
https://github.com/superfly/flyctl/blob/master/internal/appsecrets/secrets.go
https://github.com/superfly/fly-go/blob/main/flaps/flaps_secrets.go

## Branches

Re-listed remote heads. No branches deleted. The brief does not include the
original 29-branch list, and reading its source Room was denied. Need that
original list or restore artifact before checking eligibility, current SHAs,
protection, PR status and active corners. A newly chosen set would exceed the
brief's authority. Deleted: 0; deletion requests failed: 0; original 29 pending
identification. No restore file is claimed because no deletion occurred.

## Deferred auth secrets

All six `BEELINE_GITHUB_*` Fly names remain. Removal requires this PR to merge
and a release to deploy it, followed by a reader check at the deployed SHA.
No release, deploy, restart or production flag change was performed here.

## Demonstrated

Built auth and server modules served GET `/auth/capabilities` over a real local
HTTP listener using isolated PGlite and the existing test database adapter:
HTTP 200 with `{"github":false,"oidc":true}`. The fixture supplied OIDC endpoints
and no GitHub configuration. This proves mounting and routing; no production
OAuth exchange was attempted. The existing mounted-auth suite covers the
GitHub browser callback, bind ticket and phone-session exchange.

The monolith Docker image also builds successfully. Runtime imports of
`@beeline/auth/server`, `/environment` and `/store` pass as the image's node user;
`apps/auth/dist/index.js` is absent. This host's checkout files/directories are
600/700, so the disposable proof container normalized read/traverse permissions
before dropping to node. That is a local proof accommodation, not a repository
or production configuration change.

Validation completed so far: workspace build, root typecheck (including mobile
and scripts), auth suite (204 tests), dead-code gate (zero new findings), workflow
path lint, Docker build and runtime imports, and all 244 monolith integration
cases. The integration file retained about 29 GiB in one worker, so its cases
were enumerated with `vitest list --json` and run in fresh groups of 16 selected
by exact case-name patterns. All 16 batches passed; skipped cases in each batch
are covered by the other batches. Other server suites are recorded below when
complete.

Final server coverage: 195 files accounted for, 193 passed and two deliberately
environment-gated files skipped (`corner-person-state.production.test.ts` and
`wallet.live.test.ts`). Across the final per-file results: 3,274 tests passed,
12 skipped, zero failed. See `server-tests.json` for the per-file manifest.

The eight-worker run initially hit six timing assertions plus one setup hook
timeout across six files. Five files passed their first sequential rerun. The
corner-read file first measured 737ms against its unchanged 650ms limit, then a
matched baseline/candidate check passed all 18 tests on both: baseline commit
`06bf3a7c8998b8cb9841891152d0b2e15ef1a48a` measured 499ms; candidate measured
510ms. The detached baseline used unchanged server sources with the same local
installed dependencies/shared build outputs. No performance code, thresholds,
timeouts or tests were changed. Workflow syntax lint also passes.
