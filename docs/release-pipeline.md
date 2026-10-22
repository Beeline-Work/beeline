# Production release pipeline

`Unified production release` is the only workflow that releases current
`main`. It is manually dispatched; merges do not trigger a production release.

## Release policy (consent gates)

- **OTA is the default delivery.** A routine release promotes mobile OTA
  updates only. It never publishes to the App Store or Play Store and never
  requires the emulator device proof.
- **Store publishing is explicit and consent-gated.** `store_track` stays
  `none` unless the project owner explicitly dispatches with a track
  (`internal`, `beta`, or `production`). The one exception the planner enforces
  is a runtime-pin change: a new runtime needs a new store binary as its
  anchor, so planning refuses until a store track is named - and naming it is
  still an explicit operator decision.
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

Keep the v0.1.90–v0.1.94 draft releases and their assets intact. They represent
partially shipped attempts, not verified successful releases. On an explicit
owner release command, use a fresh routine identity (allocation skips drafts),
or deliberately recover an existing identity after inspecting its checkpoints.
Do not publish a draft merely because a server or OTA leg completed.

The workflow pins current `main`, includes every merge at that
HEAD, keeps automatic component selection, uses the established `store_track=none`
policy, promotes the OTA without a device proof (recorded UNPROVEN unless
`run_release_proof=true`), publishes one release record, runs component checks,
and reports the result in the workflow summary. The operator-selected workflow inputs are
recovery- and consent-only (the server supplies attribution): operators use them to continue an existing identity,
explicitly request the device proof, or make a deliberate store submission -
never for a routine release.

The initializer compares the pinned main SHA with every component's own source
SHA in the last successful `unified-release-index` and writes
`release-plan.json`. Its explicit path map is
`COMPONENT_PATH_RULES` in `scripts/unified-release.mjs`. The plan selects
`server`, `helper`, `mobile-ota`, `mobile-native`, `desktop`, and `website`
independently. `selection=all` is a recovery-only, deliberate full-release
override. A
non-`none` store track always selects `mobile-native`. Automatic selection with
`store_track=none` never builds native binaries, even when native inputs changed.
Explicit recovery selection (`all` or `mobile-native`) can still build binaries
without submitting them to a store.

The per-platform native runtime pins couple OTA and store delivery: when
`apps/mobile/native-fingerprint.json` changes `android.runtimeVersion` or
`ios.runtimeVersion`, planning requires `mobile-native` plus a non-`none` store
track, records both platforms' old and new pins, and builds/submits only the
platforms whose pins changed. Legacy release records with one global
`runtimeVersion` still resolve that pin for both platforms. OTA promotion waits
until the selected store binaries have been submitted. A retry with the same
pinned release identity resumes both components from their saved stages.

Exception - pin RESTORE: a pin change that reverts to runtime versions whose
store binaries already exist needs no new store submission. Planning such a
release as OTA-only requires the explicit `allow_pin_restore` workflow input
(or `--allow-pin-restore`): it ships only `mobile-ota`, records
`plan.pinRestore: true`, and never builds or submits store binaries. It is a
deliberate consent gate, never inferred from pin direction.

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
and the mobile OTA run side by side. With an unchanged runtime pin and no
requested device proof, `mobile_ota` starts as soon as the plan exists;
`mobile_ota_after_native` waits for store binaries or the proof otherwise.

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
each Machine returns to the image it ran before. `server-image-ledger-<release>` retains the previous and candidate
image refs for 90 days. The `Server image rollback recovery` workflow can
redeploy an explicitly named `registry.fly.io` image, or the latest ledger's
predecessor; it defaults to `dry_run=true`.

The canary ordering and rollback plan are covered without production by:

```sh
node --test scripts/unified-release.test.mjs
```

A failed attempt stores its release state. The release never redispatches
itself. An explicit recovery dispatch with the same `release_version` and
`release_sha` skips checked components, reuses successful immutable build
artifacts, and reruns only unfinished component work. A mobile OTA whose
earlier attempt never started production promotion publishes its exact beta
candidate as a first attempt; one whose promotion started (recorded as
`promoted`) only recovers that exact promotion and refuses partial or
superseded production groups. When an earlier attempt at
this identity already merged the three-platform daemon artifact, `initialize`
resolves the run holding it once and the helper leg promotes those exact bytes,
so neither macOS bundle is rebuilt. When no reusable artifact resolves - it
expired, was deleted, or the lookup errored - the macOS legs rebuild instead of
dead-ending, and a fresh release identity has no such artifact and always builds
them. Missing identities, unknown selections, missing carried references, and
absent selected artifacts fail closed. Helper fleet uptake is recorded once as
post-release observability; installed-helper convergence never gates delivery.

Routine version allocation skips every version already held by a GitHub release
record, including unpublished drafts from failed or partially shipped
attempts. Those records and assets remain intact; the next routine dispatch
gets a fresh version without deleting a draft. Explicit recovery keeps the
existing identity. A release listing failure stops initialization before
anything ships.

A repeat routine dispatch at an already-delivered HEAD succeeds as a no-op. It
does not rebuild components, replace the release index, upload release assets,
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
have second-scale limits. The final index records outcome, duration,
selected/carried components, and, for a failed attempt, the unfinished
component list as its failure class.

Review the planner without deploying by running:

```sh
node --test scripts/unified-release.test.mjs
```

Those fixtures cover canary ordering and window verdicts, rollback selection,
the server image ledger, no-input defaults, per-component published-input drift,
shared-path fanout, carry-forward, same-identity no-op and recovery continuation,
missing artifacts, and completion/publication checks.

## Compatibility and signing invariants

- OTA targets are computed in `ota-release.mjs`: each platform's current pin
  from `apps/mobile/app.config.js` plus the two highest shipped runtimes below
  it, excluding `RETIRED_COMPAT_RUNTIMES` before filling the two slots (at most
  six targets). Shipped means present in EAS production history **or** the
  committed `SHIPPED_NATIVE_RUNTIMES` store ledger. Older production runtimes
  are logged as dropped under the pin-plus-two rule; missing selected targets
  and rollback anchors still fail closed. No compatibility-list edit is needed
  after a pin bump. Production queries EAS before computing targets; promotion
  and release proof consume the exact targets saved in the release ledger.
  Rollback computes from the production response it already queries.
- Offline `publish --dry-run` uses the committed store ledger only. For a
  deterministic plan matching production, save `eas update:list --branch
  production --limit 50 --json --non-interactive` and pass its JSON file as
  `--production-history <path>` with `--dry-run`. Live releases reject that
  override and always query EAS.
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
`mobile-native.sourceSha` in the last successful `unified-release-index`. It fails
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
