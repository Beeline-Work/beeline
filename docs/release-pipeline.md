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

The native runtime pin couples OTA and store delivery: when
`apps/mobile/native-fingerprint.json` changes `runtimeVersion`, planning requires
`mobile-native` plus a non-`none` store track, records both pin values, and holds
OTA promotion until that release's store binaries have been submitted. A retry
with the same pinned release identity resumes both components from their saved
stages.

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
seconds for five minutes it requires `/healthz`, the exact `/version`, and an
authenticated read of `SERVER_CANARY_ROOM_ID` using
`SERVER_CANARY_PHONE_TOKEN`. When `/healthz` includes the self-protection lane's
pool snapshot, any nonzero waiter count fails the sample; until those fields
land, the gate records `poolMetricsAvailable=false` while still enforcing
health, image identity, and the real Room read. Follow-up: make the pool fields
mandatory after the self-protection change is merged.

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
