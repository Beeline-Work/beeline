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
IDs of confirmed Review, Firstmate Proof, Empty screen test and operator team
Workspaces are migrated to `workspaces.internal`. Both the dashboard cohort and
service review exclude that flag. Internal-only members are excluded; people with
external memberships remain eligible. Internal Rooms do not contribute replies or
corners. Mark new internal/proof Workspaces explicitly; never infer classification
from a customer's Workspace name.

The daily walk reserves opted-in external Workspaces with unread messages or
turns. `service_review_visits` persists each window. The maximum completed
`read_through` is the per-Workspace cursor; a first reservation starts 24 hours
back, and retries retain that initial lower bound. Only an atomic, complete set
of validated receipts advances cursors. Unread backlog remains eligible even
without fresh human activity. Readers recheck internal classification and opt-out
and paginate the entire frozen window. Legacy reservations without bounds use
24 hours ending at their reservation timestamp, never unbounded history.

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

## Store downloads and signup comparison

The additive `downloads` stage precedes Signup in the frontend. Keep the original
`usage.people` / `usage.agents` stages and lifetime definitions unchanged; use
`downloads.comparison.signups`, never the lifetime Signup count, for this transition.
This is a feature, not a defect report.

- `downloads` has `stage: downloads`, `nextStage: signup`, a label, explanatory
  `note`, `from` / `through` dates, `count`, `perPlatform`, `comparison`, and `series`.
  Render **Downloads (store installs) → Signup → Workspace → …**. Show
  `comparison.dropOffCount` and `comparison.dropOffRate` (fraction, not percent).
  Per-platform comparisons are under `comparison.perPlatform`. Counts and rates
  are null when coverage is missing; a zero denominator has a null rate. Signed
  negative drop-off remains visible because installs and signups are different
  populations; do not clamp it to imply a measured conversion cohort.
- The window starts 89 UTC dates before the request. It ends two dates before the
  request when Android is selected, otherwise one date before. Every mobile slice
  and the deduplicated mobile signup total use those same dates. Web and desktop
  have `not_measured`, null counts, and no store calls. The total includes only
  selected mobile platforms; it never treats unmeasured platforms as zero.
- `series.daily` / `series.weekly` contain nullable download points; a weekly bucket
  is null if any day is missing. `series.signups` supplies the matching signup
  series. `overview.series.downloads` also exposes the download series alongside
  the existing signup series, with explicit window dates. Use the matching series
  for comparisons: the existing overview signup series still includes recent days.
- `measured`, `stale`, and `missing` distinguish complete observations, cached
  observations after a failed/provisional refresh, and incomplete coverage.
  Each mobile platform includes its source, latest successful `fetchedAt` and
  `lastCompleteDay`. Missing days stay null even when other days have data.
- The endpoint claims missing or provisional days atomically in
  `store_download_days`, at most once per hour across server processes. Store
  requests have an eight-second budget per platform and at most three concurrent
  fetches. There is no scheduled collector. Successful days three or more dates
  old become final; newer days refresh on a subsequent eligible dashboard read.
  Failed attempts retain cached values and the hourly claim.

Configuration (new Fly secrets, stage only after the required passkey approval):
`BEELINE_PLAY_SERVICE_ACCOUNT_JSON`, `BEELINE_PLAY_REPORTS_BUCKET`,
`BEELINE_PLAY_PACKAGE`, `BEELINE_ASC_ISSUER`, `BEELINE_ASC_KEY_ID`,
`BEELINE_ASC_PRIVATE_KEY`, `BEELINE_ASC_VENDOR_NUMBER`, `BEELINE_ASC_APP_ID`.
The Apple app ID is required to prevent vendor-wide reports counting other apps.
The Play service account needs Play report access (View app information and
Download bulk reports) and `storage.objects.get` on the reports bucket; the OAuth
scope is `devstorage.read_only`. Apple requires a Sales or Finance role for daily
sales reports. Never log provider response bodies or credentials.

Play uses **Daily User Installs**, not device installs: it is the closest provided
user acquisition count to first-time downloads. Blank cells and absent dates are
missing, not zero. CSV is decoded as UTF-16LE when its BOM is present. Apple reads
only this app's Apple Identifier and product types **1, 1F, 1T**; exact allowlisting
excludes updates (7*) and re-downloads (3*). Successful empty sales reports are
measured zero; unavailable reports are missing. Store report calendar dates are
compared with UTC signup dates, so this is an estimate, not person-level attribution.

Required UI note: “Downloads count store installs, not people. Reinstalls and
several devices per person mean the drop-off is an estimate.” Desktop release-asset
counts are deliberately omitted: repeat requests and automated downloads would add
a different, noisy measure rather than comparable first-time installers.

Provider references: [Play monthly reports](https://support.google.com/googleplay/android-developer/answer/6135870),
[Apple sales reports](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports),
[Apple product types](https://developer.apple.com/help/app-store-connect/reference/reporting/product-type-identifiers/).

## Anonymous pre-sign-in funnel (brief revision 2)

`POST /v1/funnel/events` accepts only the shared schema in
`packages/api-contract/src/signin-funnel.ts`, at most 1 KiB. Unknown fields,
non-UUID-v4 IDs, unknown providers/outcomes, arbitrary error strings and non-version
build labels are refused. The timestamp is validated but grouping uses server
receipt time. IP addresses exist only in a bounded, request-driven in-memory rate
limit (60/minute); the event ledger has no IP or account column. `signed_in`
requires phone-session authentication. Production-only data is retained; dev,
preview, lab, review and known preview version labels are ignored.

The app stores a random install UUID and a 30-minute attempt UUID in local
storage. A launch/foreground action records app opened when signed out (and on the
first measured launch); the sign-in screen records its appearance once per open.
A provider press creates an attempt. A persisted step ledger prevents duplicate
callback and signed-in sends across callback remounts. Transmission is best effort,
with a short timeout and no retries or background collector. No network send is
awaited by the sign-in UI. Corrupted persisted contexts with extra fields are
rejected before being sent. Web and Tauri use the same controller.

OAuth start URLs carry only that strict context. The auth service records the
state-bound start and verified callback outcome via a server hook; it sends no
OAuth code, token, subject, cookie or login to the funnel. Server observations
replace matching client reports. Successful GitHub and Google session exchanges record
signed-in authoritatively; the authenticated client event supplies the same
install/attempt for all providers. Google browser opening forwards the same
anonymous context through OIDC start and session exchange, including callback
recovery. Its existing preview and account-linking gates remain in force.

Authenticated events mark an install internal if its identity is hidden, fixture
only, the fixed Play reviewer, or one of the explicitly confirmed operator
handles (`lunchboxfortwo`, `bananaman614305`, `moonscannerai`). All earlier events
for that install are excluded retroactively. The account identifier is used only
for this check and transient new-account classification and is not saved in either funnel table. Review launch links and
review sessions are suppressed on the client as well. Ordinary customer Workspace
owners are not classified as staff.

`signinFunnel` is an additive response alongside `downloads`. Its `through` matches the download comparison; store lag applies to the whole
journey. Its `from` is the later of the requested start and first event collection
date. `requestedFrom` preserves the original window, and `signinFunnel.downloads`
recounts cached downloads over that common window. Render that Downloads count
for the expanded journey; the top-level `downloads` remains backward compatible.
Render its six install stages after Downloads, ending in an additive `signup`
completion stage, with
`perPlatform` entries for `all` and each selected platform. Each stage has a
count, denominator, signed drop-off count and fractional rate. Counts are distinct
installs across retries and providers, never sums of platform slices.
`providers` supplies GitHub / Google starts, completions, completion rates,
callback outcome branches, and daily/weekly series. The platform-level `series`
also supplies every stage including install-based Signup. Weekly counts deduplicate installs across
the full seven-day bucket. Outcome branches can overlap if one install retries.
A zero start denominator yields a null completion rate. If the window predates
collection, `state` is `not_measured` and stage counts are null. Consult
`coverageStart`; this release cannot reconstruct earlier sign-in attempts.

Downloads-to-open comparisons are available per measured mobile platform and for
an exclusively mobile selection. An all-platform selection also contains web and
desktop opens, whose downloads are unmeasured, so that transition's denominator
is null. Later steps remain comparable within the selected platform window.
The final `stages` entry, `signup`, counts distinct installs whose authenticated
account was created between the same install/attempt/provider's recorded
`provider_tapped` and `signed_in` events. The server derives this completion;
clients cannot submit `signup`. Returning-account sign-ins remain `signed_in`
without becoming new Signup completions. Multiple devices for one account are
counted only when they participated in the account-creation attempt. Missing
attempt starts cannot prove signup and do not count. Signup has the preceding
signed-in install count as its denominator, plus `dropOffCount` and
`dropOffRate`; daily, weekly and provider series use the same window and platform
selection. No account ID is retained with the completion. The transition measures
new-account completion among signed-in installs; returning accounts explain some
of that difference, so it is not exclusively abandoned signups.

Each platform also retains its separate `signup` count of production identities over the common
window, explicitly marked as people rather than installs. The original
`usage.people` stages still count people over their original lifetime, and the
legacy download comparison still supplies its original dated account signups; do
not silently use either as an install count.

On dashboard reads and the first event of each UTC day, request-triggered
compaction replaces raw events older than the 90-calendar-day window with daily
anonymous counts and removes expired auth correlations. No timer runs. If there
is no activity, compaction resumes on the next request. The current dashboard
window uses raw distinct install counts; retained older daily aggregates contain
no install IDs and cannot reconstruct cross-day unique installs. Internal status
learned after raw records expire cannot revise those anonymous historical counts.

Privacy disclosures changed in `web/privacy/index.html`, both checked-in Android
full descriptions (`store/listing` and `fastlane/metadata`), and
`store/questionnaires/google-play-data-safety.md`. Store-console declaration
submission remains release-owned. The implementation uses existing JavaScript
and native dependencies, changes no runtime pin and needs no new store binary;
mobile delivery can use the normal OTA release path. The private dashboard
frontend and production screenshot require its separately accessible repository
and approved store configuration.
