# Production release pipeline

`Unified production release` is the only workflow that releases current
`main`. It is manually dispatched; merges do not trigger a production release.

## Routine release

Firstmate runs one command directly, without creating a release worker:

```sh
gh-axi workflow run unified-release.yml --ref main
```

Pass no inputs. The workflow pins current `main`, includes every merge at that
HEAD, keeps automatic component selection, uses the established `store_track=none`
policy, publishes one release record, runs component checks, and reports the
result in the workflow summary. The visible workflow inputs are recovery-only:
operators use them to continue an existing identity or make a deliberate
exception, never for a routine release.

The initializer compares the pinned main SHA with every component's own source
SHA in the last successful `unified-release-index` and writes
`release-plan.json`. Its explicit path map is
`COMPONENT_PATH_RULES` in `scripts/unified-release.mjs`. The plan selects
`server`, `helper`, `mobile-ota`, `mobile-native`, `desktop`, and `website`
independently. `selection=all` is a recovery-only, deliberate full-release
override. A
non-`none` store track always selects `mobile-native`.

The per-platform native runtime pins couple OTA and store delivery: when
`apps/mobile/native-fingerprint.json` changes `android.runtimeVersion` or
`ios.runtimeVersion`, planning requires `mobile-native` plus a non-`none` store
track, records both platforms' old and new pins, and builds/submits only the
platforms whose pins changed. Legacy release records with one global
`runtimeVersion` still resolve that pin for both platforms. OTA promotion waits
until the selected store binaries have been submitted. A retry with the same
pinned release identity resumes both components from their saved stages.

iOS store binaries build locally on the self-hosted `macbook-pro-7` Mac runner
and are submitted to TestFlight from its generated IPA. Android store binaries
continue to build on EAS cloud and use the existing Google Play authentication
and upload path.

Selected jobs build immutable artifacts named with both release version and
source SHA, promote them, run bounded checks, and publish a component
checkpoint. Unselected entries retain the prior release's version, SHA, and
artifact reference; an older component SHA is correct when none of that
component's inputs changed. All selected component jobs run concurrently. Shared
protocol and UI changes select every real consumer, while their deploy
contracts stay independently backward-compatible; no fleet-convergence or
artificial cross-component gate serializes them.

### Server migration, canary, and rollback

Server boot never runs migrations or backfills. The release job builds the
server packages and runs `npm run migrate -w @beeline/server` once with the
owner-scoped `MIGRATION_DATABASE_URL`, before either Fly Machine is changed.
The migration writes `beeline_schema_state` only after both the server and auth
schemas and all backfills finish. Normal boot uses `DATABASE_URL` only to read
that marker and exits with an explicit release-migration error when the schema
is absent or stale. A Machine restart therefore cannot rerun or queue a
migration behind live traffic.

The promotion records the two current Machine image refs, builds one tagged
Fly image, and chooses the lexically first Machine as the canary. It updates
only that Machine, pinning probes to it with `fly-force-instance-id`. Every 15
seconds for five minutes it requires `/health`, the exact `/version`, and an
authenticated read of `SERVER_CANARY_ROOM_ID`. Immediately before the watch,
the action redeems the repository secret `SERVER_CANARY_REVIEW_SECRET` once at
`/v1/auth/review/exchange`, masks the returned access token, and uses that fresh
token for every Room read. The repository secret `SERVER_CANARY_PHONE_TOKEN` is
the legacy fallback only when the review secret is unset; at least one of these
two secrets must be configured. The self-protection pool snapshot (`size`, `inUse`,
`waiting`, and `oldestActiveQueryAgeMs`) is mandatory and validated on every
sample; missing or malformed metrics and any nonzero waiter count fail the
canary before the second Machine can update.

Only a clean window permits the second Machine update. Any failed update or
sample restores the canary to the exact `previousImageRef` and fails the
release. `server-image-ledger-<release>` retains the previous and candidate
image refs for 90 days. The `Server image rollback recovery` workflow can
redeploy an explicitly named `registry.fly.io` image, or the latest ledger's
predecessor; it defaults to `dry_run=true`.

For a production-free workflow proof, dispatch Unified production release with
`plan_only=true`. It prints both `migrate -> canary -> watch -> second` and
`canary failed -> previous image -> fail-release` using synthetic Machine refs;
all release jobs are skipped. The same local proof is covered by:

```sh
node --test scripts/unified-release.test.mjs
```

A failed attempt stores its release state. Up to two automatic retries use the
same version and SHA, skip checked components, reuse successful immutable build
artifacts, and rerun only unfinished component work. Missing identities,
unknown selections, missing carried references, and absent selected artifacts
fail closed. Helper fleet uptake is recorded once as post-release observability;
installed-helper convergence never gates delivery.

A repeat routine dispatch at an already-delivered HEAD succeeds as a no-op. It
does not rebuild components, replace the release index, upload release assets,
or send a duplicate client notification.

The desktop leg signs, notarizes, staples, and strictly verifies the macOS disk
image whenever the complete credential set is available. Until the Developer
ID certificate is provisioned, it preserves the existing unsigned release path
and marks both reports **macOS artifact UNSIGNED: signing secrets absent**.
Trusted in-repo preview builds exercise the same signed verification path.
One-time certificate and App Store Connect setup is documented in [macOS
desktop signing and notarization](./macos-desktop-signing.md).

Normal selective attempts have a 20-minute dispatch-to-result budget. Component
jobs have shorter explicit timeouts and network smoke checks have second-scale
limits. The final index records outcome, duration, selected/carried components,
and a failure class (`budget` or the unfinished component list).

## Reliability measurement

The workflow summary reports failed attempts over the latest 20 completed
manual `unified-release.yml` runs, using GitHub Actions run conclusions. It
surfaces the percentage only after at least 10 completed attempts; before that,
it reports the sample as insufficient. The target is fewer than 10% failed
attempts. This is an operating metric, not a claim that one change or one
successful release proves the target.

Review the planner without deploying by running:

```sh
node --test scripts/unified-release.test.mjs
```

Those fixtures cover canary ordering and window verdicts, rollback selection,
the server image ledger, no-input defaults, per-component published-input drift,
shared-path fanout, carry-forward, same-identity no-op and retry continuation,
missing artifacts, completion/publication checks, and the workflow time budget.
