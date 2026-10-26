# Private operator dashboard

`GET /v1/admin/dashboard` is authenticated with `BEELINE_DASHBOARD_SECRET`.
The private frontend and same-origin Cloudflare Pages proxy live in
`Beeline-Work/beeline-dashboard`. The browser never holds the bearer secret.
Existing Cloudflare Access protects `dashboard.usebeeline.app`.

The additive `finances` block provides service dependencies, provider balances,
sourced spending, projections and durable daily snapshots. See the
[finances contract, inventory and credential gaps](operator-services.md).

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
  90 Eastern dates (America/New_York); rolling WAU starts after the first six dates so its whole seven-day
  window is observed. Successful empty dates are zero; failed metrics have no
  array. Weekly buckets are trailing seven-day groups ending on the measurement
  date, not calendar weeks. Counts sum; DAU becomes a daily mean; WAU uses the
  bucket-ending rolling distinct count. The earliest weekly bucket can be partial.
- `overview.timeZone` is `America/New_York` for Usage series. Each local day
  starts at Eastern midnight, including DST changes. Other sections retain their
  existing UTC windows. Frontends may fall back to Eastern when the additive field
  is absent.
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
for that install are excluded retroactively. The raw account identifier is not saved in either funnel table. Authenticated sign-in now stores a domain-separated SHA-256 account hash on the install row so server-observed onboarding steps can find the same attempt. This is pseudonymous correlation, not unlinkable anonymous data; the mapping follows the raw install ledger; onboarding milestones and their sign-in context remain for the all-time cohort. Review launch links and
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

Onboarding extends the existing ledger. Its milestone rows and minimal signup /
signed-in context survive the ordinary 90-day sign-in-detail compaction so the
`all` cohort does not shrink and repeat installs do not become new people.
Other sign-in detail keeps the existing retention policy. No raw identity IDs
appear in the funnel tables or dashboard response.

### Pinned API contract: `onboardingFunnel`
Both PRs must state this contract verbatim. Any change needs a brief revision in both corners.

**Placement.** Additive key on each existing period entry: `periods["24h"|"7d"|"28d"|"all"].onboardingFunnel`. Same window rules as the period object (end exclusive at `measuredAt`).

**Cohort.** Eligible humans (team accounts excluded, as today) whose welcome card was first shown inside the window. Every later step counts only those people, at any time up to `measuredAt`.

**Shape.**
```json
{
  "cohort": "welcome_shown_in_window",
  "steps": [Step],
  "paths": {"task": [Step], "game": [Step], "invite": [Step]},
  "byOption": {"task": {"steps": [Step]}, "game": {...}, "invite": {...}, "special": {...}},
  "biggestDrop": "step_key" | null
}
```
`Step = {"key": string, "count": int, "eligible": int|null, "medianSecondsFromPrevious": int|null, "samples": int}`

**Step keys, in order.**
- `steps` (all users): `welcome_shown`, `option_picked`, `answered_after_pick`, `return_1d`, `return_7d`.
- `paths.task`: `task_first_answer`, `task_second_opinion`, `task_final_answer`. Previous step for the first entry is `option_picked`.
- `paths.game`: `game_posted`, `game_viewer_opened`, `game_closed`. The `game_closed` median is time in viewer.
- `paths.invite`: `invite_link_created`, `invite_shared`, `invite_opened`, `invite_friend_signed_up`, `invite_friend_messaged`.
- `byOption.<option>.steps`: the five `steps` keys, limited to users whose first pick was that option. Options: `task`=A, `game`=B, `invite`=C, `special`=D.

**Rules.**
- `option_picked` uses the first pick only. Its median is time to first tap.
- `return_1d`: a retained message 24h or more after `welcome_shown`. `return_7d`: 168h or more. `eligible` = cohort users whose welcome is at least 24h / 168h before `measuredAt`. `eligible` is null on all other steps.
- Medians: integer seconds, from the previous step in the same list, over users who reached both. `samples` = that user count. Fewer than 5 samples gives `medianSecondsFromPrevious: null`.
- First entry of each list has `medianSecondsFromPrevious: null`.
- `biggestDrop`: over `steps` only, same rule as the people funnel.
- Empty cohort: every key present, counts 0, medians null. Failed read: the existing unavailable-section shape, never zeros.



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
compaction replaces ordinary sign-in detail older than the 90-calendar-day window with daily
anonymous counts and removes expired auth correlations. Onboarding milestones and their minimal authenticated context are retained as described above. No timer runs. If there
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

## Free-agent activation and repository linking

The people funnel inserts `free_agent_messaged`, `free_agent_replied`, and
`repository_linked` immediately after `workspace`. The agent funnel and original
stage counts/timings remain unchanged. Each new stage is a distinct-person
milestone over the same eligible human cohort and platform observations as Signup.
Their denominator/`previousStage` is Workspace; they are parallel milestones,
not a claim that linking requires a free-agent reply or that paired helpers require
linking. In particular, do not interpret adjacent bars as conditional conversion.

- `free_agent_messaged`: retained ordinary human source messages addressed by an
  input command to a `free_agents` row owned by their author. This includes DM,
  tagged and solo-agent Room dispatches, including pending commands. It excludes
  messages to another person's agent, owned helpers not provisioned by the free-agent
  service, system/card messages, deleted messages and fixture Workspaces.
- `free_agent_replied`: those conversations with a complete command whose result
  is a retained ordinary message from that person's free agent in a production
  Room. Drafts, working/cancelled commands and completions without a result message
  do not count. Free-agent removal does not erase a retained milestone, subject to
  the existing hidden-identity cohort exclusions. These lifetime reconstructions
  depend on retained message and command history.
- `repository_linked`: distinct eligible humans in `repository_link_successes`,
  restricted to production Workspaces. The record retains only human ID, Workspace
  ID and first-success timestamp per human/Workspace. Workspace scope prevents a
  fixture's first success masking the person's later production success. Repeated
  links and multiple Workspaces count each human once. Unlinking does not undo a
  success; Workspace deletion cascades its records. No content or repository name
  is stored or returned.

Successful installed-GitHub bindings through `setRoomRepository`, repository-card
link/create (which calls that same path), and `createRoom` with a repository write
this record atomically with the binding. Failed authorization, inventory refresh,
local/unverified bindings and inherited corner bindings do not record successes.
There is **no historical backfill**. The migration saves the collection start in
`operator_metric_epochs` once; later migrations preserve it. The stage's `label`
is **Linked a repository (since YYYY-MM-DD)** using that UTC deployment date.
Before deployment there is no measured historical linker count, not a measured
zero. Both free-agent labels and this dated label are supplied in the response;
new stages have null/unmeasured timing until a timing definition is approved.

Server-only delivery precedes the frontend change in `Beeline-Work/beeline-dashboard`.
The frontend must render these labels and stages with its existing bar style once
repository App access is granted; that change and its screenshot are separate work.

## X advertising attribution

This is a feature, not a defect report. `xAds` is additive and uses the existing
private dashboard authentication. It is independent of `signinFunnel`, its
anonymous tables, and the selected platform filter. Its scope is **web signups
only**. Store installs drop the click context; no mobile install attribution is
claimed.

The landing page and web app capture `twclid` and numeric or opaque entity IDs in
`utm_campaign` (campaign), `utm_content` (promoted-tweet/ad ID), and `utm_term`
(line-item/ad-group ID). Use actual X entity IDs in the ad destination URLs;
free-text campaign names do not join API entities. `utm_source=x` also marks an
X visit, but without `twclid` there is no server conversion to X. The cookie is
first-party, shared across usebeeline.app and web.usebeeline.app, and expires
after 30 days. No other UTM fields or arbitrary query data are retained.

On a new Google/GitHub identity INSERT, the account transaction saves one
`x_ad_signups` row. Existing-account sign-ins and linked identities never acquire
new attribution. Account deletion cascades the row. The browser receives only
the event ID and opaque conversion ID; X receives the click ID, signup time,
event ID and conversion ID, never Beeline identity IDs, names, email, phone or
Room content. Ordinary visits load no X script; credential-bearing OAuth/review
URLs cannot load the pixel. The anonymous sign-in funnel is unchanged.

The server outbox leases up to 20 rows, retries after five minutes (at most ten
attempts within two days), and requires `conversions_processed: 1` before marking
delivery. A crash after provider acceptance can repeat the HTTP request; every
retry and the browser pixel use the same `conversion_id` for X deduplication.
This guarantees one account record and one logical conversion, not exactly one
HTTP request under a network failure. Blocked pixels do not prevent server
delivery. Missing credentials leave pending rows, not successful deliveries.

The confirmed pixel is `rhefr`; its code-triggered Sign Up event is
`tw-rhefr-rhym5` (Beeline web signup). The token was obtained in X Events Manager,
stored directly in Squire under `x-conversions` / `Beeline signup`, and verified
with an empty request: HTTP 200, `conversions_processed: 0`, no conversion sent.
The active X account is Beeline (`usebeelineapp`), ads account `18ce55ws4zb`.
This does not establish ownership of the earlier account display name.

Release configuration, after privacy approval, uses the existing secret
provisioning route; do not expose the vault value in chat or source:

- `BEELINE_X_PIXEL_TOKEN`: vaulted X-Pixel-Token value, server only.
- `BEELINE_X_SIGNUP_EVENT_ID`: optional override of the confirmed event above.
- `BEELINE_X_AD_ACCOUNT_ID`: the ads account ID.
- `BEELINE_X_CONSUMER_KEY`, `BEELINE_X_CONSUMER_SECRET`,
  `BEELINE_X_ACCESS_TOKEN`, `BEELINE_X_ACCESS_SECRET`: OAuth 1.0 user-context
  credentials for an Ads API approved app. These are separate from the pixel token.

The leader starts bounded external jobs without awaiting their network requests
in the push/schedule loop. The daily reporting job paginates inventory and queries
campaigns, line items and promoted tweets in batches of 20 for each placement.
Hourly metrics roll into UTC days, avoiding account timezone/DST ambiguity. It
refreshes the last seven complete days; later billing corrections outside that
window are not reconstructed. Spend remains provisional. A failed fetch leaves
the previous complete snapshot and a stale/unavailable state; it never fills
unobserved API data with zero. Provider null metric arrays mean measured zero.

`xAds.rows` contains daily `campaign`, `ad_group` and `ad` rows, with currency,
spend (major units), impressions, link clicks, local account signups, cost per
click and cost per signup (null for a zero denominator). Do not sum across levels.
Signup dates are creation dates, not X click dates, so X Ads Manager's reporting
windows can differ. `coverage` reports new eligible people over the last 90 days,
people with captured X context, and `unattributedShare` (null with no people).
`signups` also preserves aggregate attributed rows that lack matching API entity
IDs, so those signups remain visible. No click IDs or account IDs leave this API.

Live analytics and the frontend remain pending: the corner's GitHub App cannot
resolve `Beeline-Work/beeline-dashboard`. The X developer onboarding succeeded
and exposed company app `33573631`, but the Ads API access form requires verified
contact name/title, city/state, email and phone before it can be submitted. The
existing discovery bearer is not an Ads API OAuth1 credential. No reporting
credential was obtained and no live daily X reporting is claimed.

Proof: `npm run prove:x-attribution` exercises the **built** loopback signup HTTP
service and authenticated dashboard with isolated PGlite and X provider fixtures,
writing `.scratch/x-ads/service-proof.json`. `x-ads.test.ts` covers signup retries,
both providers, returning accounts and dashboard joins; the shared browser tests
cover cross-origin cookie reuse and pixel deduplication. `npm run build:x-attribution`
regenerates the committed landing script. Privacy changes retain the October 18
archive and require the owner's approval before merge.

Provider contracts: [X web conversions](https://docs.x.com/x-ads-api/measurement/web-conversions),
[X analytics](https://docs.x.com/x-ads-api/analytics). The current Events Manager
installation instructions additionally specify `X-Pixel-Token` authentication.

## Period-scoped people dashboard

The additive `periods` object has `24h`, `7d`, `28d`, and `all` entries, independent
of the legacy selected-platform filter. Headline activity counts distinct eligible
humans and their retained ordinary messages in production Rooms. Growth counts
eligible human signups and production Workspaces created in the window (including
Workspaces without a current eligible human owner). It does not sum daily counts.

Each entry supplies `active {people, messages, unit, series}`, `growth {newPeople,
workspaces, series}`, and `funnel {steps, biggestDrop}`. Series points are
`{start, value}`; activity values count distinct people in each bucket, while growth
values count new people. The last 24 hours use UTC hour starts; rolling 168- and
672-hour windows use Eastern day starts; all time starts at the earliest eligible
signup and uses Eastern calendar weeks. Boundary buckets can be partial and zero
buckets are included. Window ends are exclusive at `measuredAt`.

The signup-window funnel is conditional: `signed_up`, `joined_workspace` (current
active production Workspace membership), `first_message`, `agent_reply` (an owned
agent's retained production-Room message strictly after the person's first such
message), then `active_7d`. Milestones use retained history through measurement,
with recent activity in the trailing 168 hours. Hidden or retired owned agents can
still establish the person's reply milestone. Biggest drop uses the destination
step key, prefers the later step on equal losses, and is null without any loss.

`platformBreakdown {basis: "last_device", counts}` assigns every eligible human
once to the latest push registration update or device update receipt. Unknown or
missing platforms become `unknown`; exact observation-time ties use a stable
source/device key. The original `platforms` array is unchanged. Failed period or
platform reads return the existing unavailable-section shape rather than zeros.

### Screen-read X Ads ingestion

`POST /v1/admin/dashboard/x-ads/screen` uses the same dashboard bearer secret.
Agents submit Ads Manager readings through this route; they never write the
production database directly. The write scope is only `x_ad_daily` and `x_ad_sync`.

```json
{"day":"2026-10-24","currency":"USD","rows":[{"level":"campaign","entityId":"actual-x-campaign-id","name":"Launch","spend":10.25,"impressions":1000,"linkClicks":20}]}
```

Use `campaign`, `ad_group`, or `ad` for `level`; optional `campaignId` and
`adGroupId` link rows to their parents. Send actual X entity IDs, never names
as invented IDs: signup joins depend on those IDs. IDs must be nonblank and at
most 200 characters; names must be nonblank and at most 500 characters.
`day` must be a real YYYY-MM-DD date no later than today in UTC. Currency is
three uppercase letters. Supply exactly one of numeric `spend` (currency units,
at most six decimal places) or `spendMicros` (integer millionths). All integer
metrics must be nonnegative safe integers. Unknown fields, duplicate level/ID
pairs, and more than 500 rows are rejected. Invalid JSON or any invalid row
returns 400 without writing anything; missing/wrong authentication returns 403.

Each successful request atomically replaces that day's screen rows (an empty
array clears them), skips existing API rows, marks sync completed and clears
its failure without postponing the API retry schedule. API sync replaces its
reporting window, including screen rows. Success returns
`{"written":1,"skipped":0}`. Repeating a snapshot is idempotent. The existing
36-hour freshness rule applies to screen ingests too. Request bodies are not logged.

Ads Manager account days may use a local time zone while signup joins use UTC
dates; accept the resulting few-hour offset when comparing cost per signup.
