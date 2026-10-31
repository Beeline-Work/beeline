# Production release pipeline

`Unified production release` is the only workflow that releases current
`main`. It is manually dispatched; merges do not trigger a production release.

## Release policy (consent gates)

- **OTA is the default delivery.** A routine release promotes mobile OTA
  updates only. It never publishes to the App Store or Play Store and never
  requires the emulator device proof.
- **Store publishing is explicit and consent-gated.** `store_track` stays
  `none` unless the project owner explicitly dispatches with a track
  (`internal`, `beta`, or `production`). A runtime-pin change does not change
  this: the release still finishes, the OTA goes to every runtime live in the
  stores today, and the new runtime waits for a store release the owner
  chooses. Planning prints a notice; it never fails and never adds a store leg.
- **iOS production includes App Review.** After Apple confirms the exact uploaded
  build is VALID, `store_track=production` attaches it to the matching App Store
  version, sets release notes from the committed store metadata, and submits it
  for review with automatic release after approval. `internal` and `beta` stop
  at TestFlight. Apple API or submission-state errors fail the native job;
  successful evidence includes the review submission ID. See the
  [store runbook](../apps/mobile/docs/store-submission.md) for retry constraints.
- **The device proof is opt-in.** `run_release_proof=true` runs the emulator
  release proof before OTA promotion; the default is `false`. An OTA promoted
  without a proof is recorded as UNPROVEN in the release record. Request the
  proof when a release changes signing, install, or cold-start behavior; skip
  it for ordinary OTA-only JS changes.

## Routine release

Firstmate calls the first-party `dispatch_release` agent tool with `{}`, without
creating a release worker or requesting a command grant. This path creates no
command-approval card.

Pass no inputs. Run inside an authenticated Beeline agent turn citing a human
release command from a workspace owner or admin. The tool uses the existing
repository workflow dispatch path on the server. The server derives
agent id and handle, place, and the root human command message from the active
turn, and commits a Room message before requesting the dispatch. That message
is the durable audit receipt and is readable through the ordinary Room read.
A receipt says "requested"; it does not prove GitHub accepted the request.
No credentials, tokens or recovery input values are stored in the receipt.

The server passes `dispatched_by` with these fields and the audit message id.
The workflow requires that attribution and shows it in its run name and
summary. Anonymous agent dispatches are refused.
Recovery operators cannot override the server-supplied attribution.

An explicitly human-commanded recurring release may use the same tool on each
scheduled turn. Creating or updating the schedule in that human-rooted turn
stores the authorizing human command message id on the schedule. The scheduler carries the original human command into
the release turn; the audit receipt cites that command. Agent-only edits clear
the authorization. Schedules created before this support need a human-rooted
update to record the command before they can dispatch releases. The original
human must still be a workspace owner or admin at dispatch time.

The dispatch tool refuses while any production release is
queued, waiting, or in progress, and stops if the GitHub listing fails. Recovery
operators pass the recovery fields in the tool’s optional `inputs` object. This
check is advisory against simultaneous callers: workflow concurrency serializes
those races with `cancel-in-progress: false`. GitHub keeps at most one pending
run in a concurrency group, so use this tool to avoid stacking dispatches.
Direct GitHub recovery dispatches also require `dispatched_by` and still
serialize behind the running release. Use the audited tool for agent work.
The legacy
`scripts/dispatch-production-release.mjs` remains available for operator
compatibility in an authenticated agent turn; shell invocation still follows
the ordinary command-grant rules.

A person can cancel a stuck run in GitHub Actions → Unified production release
→ the run → Cancel workflow, or run `gh-axi run cancel <run-id>`. Wait for
cancellation to finish before dispatching recovery.

`initialize` reserves each identity as a draft GitHub release at once. A
draft is an attempt that has not published. A later dispatch of the same commit
resumes that draft's version, so every leg sees what the attempt already
shipped; a dispatch of another commit skips the draft's version and is never
blocked by it. A successful release deletes the drafts below its version.

The workflow pins current `main`, includes every merge at that
HEAD, keeps automatic component selection, uses the established `store_track=none`
policy, promotes the OTA without a device proof (recorded UNPROVEN unless
`run_release_proof=true`), publishes one release record, runs component checks,
and reports the result in the workflow summary. The operator-selected workflow inputs are
recovery- and consent-only (the server supplies attribution): operators use them to continue an existing identity,
explicitly request the device proof, or make a deliberate store submission -
never for a routine release.

The initializer compares the pinned main SHA with every component's own source
SHA in the newest published GitHub Release's `release.json` (see *Release
memory* below) and writes `release-plan.json`. Its explicit path map is
`COMPONENT_PATH_RULES` in `scripts/unified-release.mjs`. The plan selects
`server`, `helper`, `mobile-ota`, `mobile-native`, `desktop`, and `website`
independently. `selection=all` is a recovery-only, deliberate full-release
override. A
non-`none` store track always selects `mobile-native`. Automatic selection with
`store_track=none` never builds native binaries, even when native inputs changed.
Explicit recovery selection (`all` or `mobile-native`) can still build binaries
without submitting them to a store.

On pull requests, NATIVE FINGERPRINT also compares the committed runtime pins
against the PR base with `scripts/pr-store-build.mjs`. A changed pin adds a
warning annotation and a Store build required job summary naming the affected
platforms. This notice is informational and does not block merge; it brings
the store-track decision into PR review before release planning.

The per-platform native runtime pins no longer gate an OTA release. When
`apps/mobile/native-fingerprint.json` changes a runtime pin and `store_track`
is `none`, the plan ships the OTA to the runtimes live in the stores and prints
a notice; the new runtime gets OTAs once a store release puts it live. With an
explicit store track, native builds run only for the platforms whose pins
changed. The `allow_pin_restore` input is accepted and ignored.

iOS store binaries build locally on the self-hosted `macbook-pro-7` Mac runner
and are submitted to TestFlight from its generated IPA. The iOS leg inspects the
IPA's bundle, version, build number, runtime and required photo purpose string
(`scripts/ios-build-evidence.py`), then verifies the exact Apple delivery UUID
and a new `VALID` build under App Store app `6803948500`
(`scripts/ios-store-build.mjs`). Apple processing errors fail immediately;
missing or unfinished builds fail after 20 minutes. The native build evidence keeps
the delivery UUID and App Store build ID. Transport success alone does not
authorize the native component or OTA promotion. Android store binaries
build locally on the Linux runner and use the existing Google Play authentication
and upload path. The helper `darwin-x64` bundle builds on GitHub's hosted
`macos-15-intel` image, so it never queues behind an iOS store build.

Selected jobs build immutable artifacts named with both release version and
source SHA, promote them, and run bounded checks. A component job that succeeds
checks its component: `release_result` turns the job results into checkpoints
(`unified-release.mjs job-checkpoints`) and writes the one release record.
Unselected entries retain the prior release's version, SHA, and artifact
reference; an older component SHA is correct when none of that component's
inputs changed. All selected component jobs run concurrently. Shared protocol
and UI changes select every real consumer, while their deploy contracts stay
independently backward-compatible; no fleet-convergence or artificial
cross-component gate serializes them.

Two path rules keep releases small. Editing the release workflow or
`scripts/unified-release.mjs` selects only the fast legs (server, mobile OTA,
website), never the helper or desktop. Shared UI and protocol edits
(`apps/mobile/sources/`, `apps/mobile/assets/`, `packages/api-contract/`,
`packages/buzz-client/`, `packages/nostr/`) ship by OTA and the website at
once. The desktop app bundles the web export, so it rebuilds for its own shell
and package inputs, for an explicit `selection`, or once its bundled UI is a
week behind (`DESKTOP_UI_REFRESH_SECONDS`, measured between the commit desktop
last shipped and the release commit).

Planning and the release record run on GitHub-hosted runners. Jobs that need
production host tools run on the `beeline-prod-host` pool, which has two
runners (`beeline-production`, `beeline-production-squire-2`), so the server
and the mobile OTA run side by side. `mobile_ota` starts as soon as the plan
exists; only an explicitly requested device proof routes the OTA through
`mobile_ota_after_proof`, which publishes nothing unless the proof passed.
Every self-hosted job first checks its runner has the tools it needs
(`.github/actions/require-tools`) and fails with one clear line if not.

Each job sets up Node 22 once and installs once with `scripts/npm-ci-timed.sh`,
which prints the install's wall time, cache misses, and slowest registry
fetches. The pinned eas-cli installs from `tools/eas-cli`'s lockfile. Helper
builds cache `buzz-agent` and `buzz-dev-mcp` per pinned block/buzz commit,
rustc, and platform. Typecheck and tests ran in CI and do not rerun inside the
release.

### Server migration, canary, and rollback

Server boot never runs migrations or backfills. The release job builds the
server packages and runs `npm run migrate -w @beeline/server` once with the
owner-scoped `MIGRATION_DATABASE_URL`, before either Fly Machine is changed.
The migration writes `beeline_schema_state` only after both the server and auth
schemas and all backfills finish. Normal boot uses `DATABASE_URL` only to read
that marker and exits with an explicit release-migration error when the schema
is absent or stale. A Machine restart therefore cannot rerun or queue a
migration behind live traffic.

The promotion records the two current Machine image refs, builds and pushes one
tagged Fly image (the image that ships; there is no separate build), and
chooses the lexically first Machine as the canary. The Dockerfile stamps the
release identity after the dependency layers, so a new version reuses the
cached `npm ci`. The promotion updates only the canary, pinning probes to it
with `fly-force-instance-id`. Seven samples, 15 seconds apart (90 seconds),
require `/health`, the exact `/version`, and an authenticated read of
`SERVER_CANARY_ROOM_ID`. Immediately before the watch,
the action redeems the repository secret `SERVER_CANARY_REVIEW_SECRET` once at
`/v1/auth/review/exchange`, masks the returned access token, and uses that fresh
token for every Room read. The repository secret `SERVER_CANARY_PHONE_TOKEN` is
the legacy fallback only when the review secret is unset; at least one of these
two secrets must be configured. The self-protection pool snapshot (`size`, `inUse`,
`waiting`, and `oldestActiveQueryAgeMs`) is mandatory and validated on every
sample; missing or malformed metrics and any nonzero waiter count fail the
canary before the second Machine can update.

The server job has a fifteen-minute timeout. Free starter image publishing runs
in its own `Free starter agent image` workflow after a successful release that
shipped the server. It is best effort and never holds the release open.

Only a clean window permits the second Machine update. Each Machine must then
answer `/readyz` and serve this exact `/version` before the job succeeds; no
second smoke check or convergence wait repeats that proof. A failed Machine
update gets one retry. Any failed update or sample restores the canary to the
exact `previousImageRef` and fails the release. A fleet left split by an
interrupted release converges on the new image the same way, and on failure
each Machine returns to the image it ran before. A rerun whose Machines all
already run this release's image deploys nothing. The release record keeps the
image and the image it replaced. The `Server image rollback recovery` workflow
reads the Machines' current images from Fly and the newest published release
record: if that release is live it returns to the image before it; if the
Machines run an image from a later attempt that never published, it returns to
the newest published release. An explicit `image_ref` overrides both. It
defaults to `dry_run=true` and shares the release's concurrency group.

The canary ordering and rollback plan are covered without production by:

```sh
node --test scripts/unified-release.test.mjs
```

A failed attempt stores nothing. The release never redispatches itself. A
rerun (same commit, routine or with `release_version`/`release_sha`) plans the
same legs and each leg asks its own system what already shipped: the server
asks Fly which image each Machine runs, the helper asks Pages which version
its manifest serves and npm whether the package exists, the phone OTA asks EAS
which runtimes the release branch already holds and where each channel points,
and `release_result` reuses the draft release. Nothing is published twice.
Missing identities, unknown selections, missing carried references, and absent
selected outputs fail closed. Helper fleet uptake is recorded once as
post-release observability; installed-helper convergence never gates delivery.

A repeat routine dispatch at an already-delivered HEAD succeeds as a no-op. It
does not rebuild components, replace the release record, upload release assets,
or send a duplicate client notification.

The desktop leg signs the app, notarizes and staples the macOS disk image once
(that one submission covers the app inside it), and strictly verifies both
whenever the complete credential set is available. The release keeps only the
stable installer names, not the whole bundle folder. Until the Developer
ID certificate is provisioned, it preserves the existing unsigned release path
and marks both reports **macOS artifact UNSIGNED: signing secrets absent**.
Trusted in-repo preview builds exercise the same signed verification path.
One-time certificate and App Store Connect setup is documented in [macOS
desktop signing and notarization](./macos-desktop-signing.md).

A release that shipped every selected component is a success, however long it
took. Duration never fails an attempt. The summary reports the fix-to-phone time
(dispatch to the `mobile_ota` completion checkpoint, or the whole run when no
OTA completion checkpoint exists) and the whole-run time. A whole run over the
45-minute soft limit is marked **slow** in the summary; it still publishes the
release record. Component jobs have explicit timeouts and network smoke checks
have second-scale limits. The release record records outcome, duration,
selected/carried components, and, for a failed attempt, the unfinished
component list as its failure class.

Review the planner without deploying by running:

```sh
node --test scripts/unified-release.test.mjs
```

Those fixtures cover canary ordering and window verdicts, rollback selection,
no-input defaults, per-component published-input drift, shared-path fanout,
carry-forward, same-identity no-op and reruns, and completion/publication
checks. `scripts/release-record.test.mjs` covers identity, migration, the
record's facts and both rollback targets; `scripts/ota-release.test.mjs` covers
the phone OTA against a stand-in eas-cli.

## Release memory

The permanent GitHub Release is the pipeline's only memory. Each published
release carries one `release.json`, uploaded before the release is published:
per-component version and source commit, the server image and the image it
replaced, the phone OTA branch, its targets and the branch before it, the
desktop updater counter, and the store builds this pipeline uploaded.
`scripts/release-record.mjs` reads the newest published release; a release
published before `release.json` existed is read as a migration record whose
OTA branch is the legacy `production` branch.

Jobs hand facts to each other only through job outputs. Public JSON metadata
uses the `b64:` transport in `scripts/release-job-output.mjs`; it carries no
credentials. Raw JSON punctuation can match masked lines of a multiline secret,
which makes GitHub drop the whole output. The result job validates its state,
identity and required previous record before applying checkpoints. Missing or
invalid metadata reports `release-state:missing`, `release-state:invalid`,
`previous-record:missing` or `previous-record:invalid` and blocks publication.

A component-complete attempt whose result job failed has not published a
release record. The next dispatch reads the newest **published** release,
ignores that attempt's draft as a baseline, and reserves its version. It may
select work that already shipped; each component's existing idempotence checks
handle that. A recovery dispatch at the same commit reuses the draft identity.
Rerunning an old Actions run still uses its old workflow and checked-out scripts; it does
not pick up a later pipeline fix.
Do not promote an empty draft or infer a delivered record from Actions success:
the permanent record must include validated component and rollback facts.

No Actions artifact, cache or run lookup carries state between jobs or runs. Artifacts carry build
outputs only: Mac helper binaries, the Android AAB for the emulator proof,
desktop installers, the R8 mapping, and proof evidence.
`scripts/release-artifact-allowlist.mjs` parses every release workflow and the
local actions they use, and CI fails on any other upload, download, cache,
cross-run download or Actions-artifact lookup.

## Release bookkeeping

Delivery bookkeeping lives in the Loops/insights data store, not in the
release path. After each attempt, the `bookkeeping` job runs
`scripts/release-bookkeeping.mjs`. It writes one file,
`Beeline-Work/beeline-insights` `releases/<version>.json`, which records:

- the commits since the previous release;
- the phone OTA branch and runtimes, and the time from trigger to phone;
- whether the owner's physical phone reported this exact release
  (`/update-receipts`);
- each job's duration and result.

A rerun replaces the file. Nothing in the release reads it back. A missing
`BEELINE_INSIGHTS_TOKEN` secret, an unreachable receipt server or a failed
GitHub write only logs a warning. The job also has `continue-on-error`, so
bookkeeping never fails a release. This replaces the old cumulative
`mobile-ota-delivery-index` artifact (4.2 MB), owner-receipt confirmation and
stage-timing files.

## Phone OTA by channel pointer

Each release publishes to its own EAS branch, `release-<version>`, one update
per runtime live in the stores, and points the `beta` channel at it. Promotion
points the `production` channel at the same branch
(`eas channel:edit production --branch release-<version>`), so production
serves the exact bundles beta got, on every live runtime at once. Every live
runtime must be on the branch before any channel moves. A rerun publishes only
the runtimes the branch lacks and skips a channel that already points at it; a
branch never mixes two source commits.

`Mobile OTA rollback recovery` points `production` back: to the branch before
the newest published release if that release is live, or to the newest
published release if production serves a later attempt that never published.
Runtimes the current branch serves but the rollback branch lacks first get a
roll-back-to-embedded directive on the rollback branch, so no phone keeps the
bad update. The first release on this scheme records `production` (the old
fixed branch) as its rollback branch. The rollback shares the release's
concurrency group and has a `dry_run` mode.

## Compatibility and signing invariants

- OTA targets include each platform's newest live store runtime and the two
  newest older runtimes confirmed live on that store. A current pin still in
  review gets no OTA target. OTA history, uploads and TestFlight do not count as store publication.
  Play uses `applications/app.usebeeline/tracks/production/releases` and its
  `PUBLISHED` lifecycle state (not edit-track `completed`, which can await review).
  ASC uses distributed iOS versions and their exact build identities. Build
  numbers map to runtime pins through the committed
  `apps/mobile/store/native-runtime-builds.json`, the store builds recorded in
  the previous release record, and EAS build metadata. Unknown binary
  identities or an unreadable store keep that platform's targets from the
  previous release record (or, on the first release of this scheme, the
  runtimes production serves now). The Play history seed is parsed from its
  captured production release history; an undated upload is excluded.
- For a deterministic offline target plan, run
  `node scripts/ota-release.mjs targets --store-status <stores.json>` from
  `apps/mobile`. The file holds `stores.android` and `stores.ios`, each with
  `status: "readable"` and `live` platform/runtime records.

- Store submission and signing: [mobile store runbook](../apps/mobile/docs/store-submission.md). The sideload keystore lives in `ANDROID_SIDELOAD_*` secrets and the Trusty Squire vault; see the [signing guide](../apps/mobile/android-signing/README.md) for rotation and recovery.

## Release preflight and failure triage

`Release preflight` runs at 05:30 UTC and on manual dispatch. PRs use the
preflight tests and actionlint without depending on live runner availability. It installs
Node from `.nvmrc` on the production, Android and Intel iOS release runner labels
and executes `node -v`. A hosted watchdog cancels unfinished probes after five
minutes, so offline or busy runners cannot leave a preflight queued indefinitely.
Its failure identifies queued/running probes for investigation.

The native leg runs the existing Expo fingerprint gate with the mobile Node 22
toolchain, then compares both platform fingerprints and runtime pins with the
`mobile-native.sourceSha` in the newest published release record. It fails
explicitly when no released baseline exists, fingerprints differ, or a platform
needs a new store build/verified pin restore. Scheduled and manual preflights
remain strict. No signing, promotion, deployment or
store submission runs in preflight.

Every shell-bearing self-hosted unified-release job installs Node 22 once
before commands or composite actions. The iOS signing/build steps preserve the
installed Node path while retaining the system rsync precedence required by
Xcode.

`Release failure triage` listens for completed unified-release and preflight runs,
including cancellations before initialization. It uses trusted default-branch
code on a hosted runner to file a GitHub issue labeled `release-failure`. A marker
keyed by run ID and serialized delivery prevent duplicates across redelivery,
reruns and closed issues. It never downloads or executes triggering artifacts.
The existing saved `feedback-triage-steps` procedure's pull step includes all open
issues with that label, without an age cutoff, alongside feedback and Sentry.
This is the GitHub issue intake path, not a new server endpoint.

Local proofs: `node --test scripts/release-preflight.test.mjs` covers forced
failure/redelivery producing one issue, cancellation, offline runner timeout,
per-platform released runtime comparisons and setup-before-command ordering.
A manually dispatched preflight proves the runner and native paths; failure triage activates
from the default branch after merge because GitHub requires `workflow_run`
listeners there. The failure/redelivery fixture is its pre-merge stand-in.

## Minimum supported store versions

The optional `mobile_store_minimum` workflow input writes platform policy only
after successful delivery. Leave it empty for routine and nightly OTA releases.
For an explicitly required store update, pass JSON such as
`{"android":{"minVersion":"0.2.24","reason":"This version can no longer sign in."}}`.
Only named platforms change; the database starts with no minimums. Use the same
input with a lower version to recover from an incorrect minimum. Never raise it
before the required version is available to affected people in the store.

The public `/v1/public/mobile-minimum` endpoint serves this policy without
sign-in. Mobile compares `expo-application.nativeApplicationVersion`, never
the OTA manifest version, runtime pin, update id or release identity. Unknown
versions, invalid responses and network failures fail open; web skips the read.
Builds without the gate cannot display it. The policy is checked on launch and
foreground, without delaying the first screen.
