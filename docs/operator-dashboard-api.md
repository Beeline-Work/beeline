# Private operator dashboard

`GET /v1/admin/dashboard` is authenticated with `BEELINE_DASHBOARD_SECRET`.
The private frontend and same-origin Cloudflare Pages proxy live in
`Beeline-Work/beeline-dashboard`. The browser never holds the bearer secret.
Existing Cloudflare Access protects `dashboard.usebeeline.app`.

`apps/server/src/operator-dashboard.ts` owns the aggregate queries;
`operator-dashboard.test.ts` covers authentication, cohort counts, platform
selection, fixture exclusion, and partial failures. No content or identity IDs
are returned.

Usage accepts an optional comma-separated `platforms` selection: `ios`, `android`,
`web`, `macos`, `windows`, `linux`. Coverage lists platforms actually observed in
push registrations or device update receipts. The selection identifies people
with an observation on any selected platform; their owned agents form the agent
cohort. It does not filter by the helper host OS. Distinct Workspace counts use
active membership of the selected people. All-platform counts include people
without a platform observation and deduplicate multi-platform users.

Counts are exact, including measured zero, for this private operator surface.
Hidden identities and the fixed Play Review identity are excluded. The immutable
IDs of confirmed Review, Firstmate Proof, and Empty screen test Workspaces are
listed in `FIXTURE_WORKSPACE_IDS`. Fixture-only members are excluded; people with
real memberships remain eligible. Fixture Rooms do not contribute replies or
corners. Extend the explicit fixture list when adding a production proof fixture;
do not infer test status from a customer's Workspace name.

Health and Ops cover all platforms regardless of the Usage selection. Phone reach
counts only explicit iOS/Android receipts within 30 days. Receipts with missing
platform cannot establish phone use; missing build versions are counted separately
and excluded from the latest-build share. A configured latest version and runtime
thresholds are required for their respective release metrics.

Memory repeat corrections are counted from the correction event ledger, excluding
fixture Workspaces. Token attribution is omitted: prompt bytes and total input
tokens do not measure memory's token consumption. The frontend renders only metrics
with a measured value and health verdicts supported by sufficient observations.
Failed reads clear affected figures rather than rendering zeros or placeholders.
