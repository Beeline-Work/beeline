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

## Bird's-eye overview (additive v1 contract)

`overview` adds the approved mobile dashboard without changing authentication,
platform selection or the original Usage / Health / Ops fields. Each read has
`{state: 'measured', measuredAt, data}` or `{state: 'unavailable', measuredAt: null}`.
An unavailable read never contains synthetic zeros or a previous successful value.
Independent failures leave other metrics readable. New database reads run
sequentially and only SELECT; schema migrations add concurrent date-leading
indexes for message history, turn history and invited-member joins.

- `series`: `signups`, `workspaces`, `firstReply`, `friendsJoined`, `dau`, `wau`.
  Each has `daily` and `weekly` arrays of `{date, value}`. Reads are bounded to
  90 UTC dates; rolling WAU starts after the first six dates so its whole seven-day
  window is observed. Successful empty dates are zero; failed metrics have no
  array. Weekly buckets are trailing seven-day groups ending on the measurement
  date, not calendar weeks. Counts sum; DAU becomes a daily mean; WAU uses the
  bucket-ending rolling distinct count. The earliest weekly bucket can be partial.
- New people means identity creation, not sign-in. Created Workspaces are
  attributed through owner membership, which can change. First reply means the
  earliest retained message in the 90-day window from an owned eligible agent,
  not proof of the first-ever reply. Friend joins count invited human members
  by join date, not sent invitations. DAU/WAU count humans posting retained,
  undeleted messages in production Rooms; passive usage is absent.
- `retention`: people created 28 through 8 UTC dates ago, with a retained human
  message exactly seven dates later. `rate` is null for an empty denominator.
  Deletions and mutable memberships limit all reconstructed historical cohorts.
- `failures`: daily failed / all created turns (including working and cancelled),
  globally and including fixtures. No-turn days have null rates, not 0% failures.
- `replyLatency`: all-platform median pairing-to-first-retained-reply for eligible
  agents paired in the 90-day window. Fewer than five samples suppress the median.
  This is onboarding time, not request latency.
- `helpers`: eligible paired agents with an unreleased connection on a server
  renewed within 90s. `share` is null for no eligible helpers. This is a snapshot,
  not historical uptime. `fleet` counts nonremoved free agents by persisted state
  in eligible production Workspaces.
- `spend`: recorded global free-agent budget charges, configured daily cap and
  sparse daily history. An absent today's ledger row has null spend; missing days
  are never filled with zeros. This is not total operating cost or provider credit.
- `capacity.database`: stored bytes, current connections, live server heartbeats.
  Heartbeats are not Fly readiness checks or a configured fleet denominator.
  `capacity.server`: Linux memory used share, total bytes and one-minute load
  for the **responding server only**; these are not fleet peaks or CPU percentage.
  Query p95 remains in `health.slow`, also scoped to the responding process.
- `releases`: explicit iOS/Android 30-day receipts grouped by build, with the same
  production exclusions as Ops. Devices are not downloads or unique people; the
  current receipt table cannot reconstruct historical release adoption.
- `sources`: explicit `not_connected` states name App Store Connect, Google Play
  Console, true sign-in events, Sentry/Telegram verification, provider balances,
  Neon/Fly capacity history and the configured latest mobile release target.
  `latestRelease` becomes `connected` when its target is configured; runtime
  compatibility still requires both store runtime thresholds in Ops.

The frontend projects only these known aggregates through its existing edge proxy.
A partial-coverage health verdict remains visible when observed client journeys
lack sufficient samples. Questions-to-watch use the funnel, failure history,
repeat-correction counts and observed telemetry coverage; no separate alert feed
or unverified notification delivery is implied. Sentry and Beeline errors belong
in Telegram.
