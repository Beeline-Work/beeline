# T7 compatibility evidence and remaining gates

The router remains capability-off. Only F26 is closed in the [closure ledger](closure-ledger.md).
These proofs exercise current source and retained historical native evidence;
they do not authorize activation or establish a deployed rollback image.

## Durable command migration and policy rollback

`apps/server/src/phone-socket.integration.test.ts` passes all 21 cases with
`NODE_OPTIONS=--max-old-space-size=4096`, `--maxWorkers=2 --minWorkers=1`.
The four additional P10 cases establish:

- A real WebSocket on one server advertises `commandDedupV1` and commits a
  reaction. After that server stops, a second server with no router policy
  replays the same identity over actual HTTP and a new WebSocket. The original
  receipt survives; the reaction stays set and no second change is published.
- Running the complete current `migrate()` twice preserves every durable
  command column, including the digest, authority coverage and original expiry.
  Changed arguments return HTTP 409 without another effect.
- Pending, unknown and result-expired command rows survive a complete migration
  unchanged. Both HTTP and WebSocket return the exact outcome without private
  expired results, reaction effects, notices or changes to the ledger row.

The existing P10 case also runs legacy reads and sends through policy-off,
policy-on and policy-off servers. These are **current-image policy transitions**,
not an old image rollout. PGlite serializes the database; this suite establishes
no two-pool PostgreSQL contention or failover timing claim.

The existing mobile `command-owner.integration.test.ts` also passes all ten
cases, including an unknown intent staying parked when the next server does
not advertise deduplication, then reusing its original identity after a later
capable generation. The bundle regression suite passes all three consumer
gates. Server typechecking passes on the same source.

`router-mobile-transport.integration.test.ts` additionally bundles the actual
mobile `LiveConnection` and connects it to two real local server instances.
One advertises snapshots and command deduplication; the other has no router
policy. The proof passes with one initial count snapshot, a committed reaction
whose reply is dropped at the socket boundary, exactly one incident replacement,
and no command or stale snapshot request sent on the incapable replacement.
An explicit recovery opens the third socket and reuses the original command
identity. The reaction stays set, the ledger has one committed row, and HTTP
fallback calls remain zero. The retained snapshot executor cannot cross into
the replacement socket. This test changes no transport or admission behavior.

This is a Node-hosted transport proof with explicit platform/UI/auth seams and
a supplied owner bridge. It does not exercise native APIs, production navigation
admission, persistent phone storage or a pre-router server image. The server
database is isolated PGlite, and every client socket is restricted to the two
loopback fixture origins.

The second transport case uses a legacy wire fixture that ignores negotiation
and returns only main `f43bd3f86`'s `sync-ok` acknowledgement for workspace sync.
Both transport cases pass. This covers absence of a capability frame, separately
from a modern server's explicit disabled capabilities. The legacy fixture has
no application operation handler and is not a historical server build; the
test asserts that no command or stale snapshot reaches it. Its first failed
run acknowledged only the short sync frame; the fixture was corrected to
match the historical workspace-cursor sync path before retaining the result.

### Additive schema readiness and image recovery

The main source at `f43bd3f86e4c7a30aa75378df82fcbda10027c72` requires
marker 46. The initial candidate wrote marker 61; the negative proof committed
at `6fa313f65` showed that swapping back to the historical image then fails boot.
Rewinding the marker failed the candidate instead. That source arrangement
could not support the existing image-only canary auto-revert.

Instruction041 changes the release plan to **expand, then switch**. The candidate
now preserves `beeline_schema_state.version=46` and records completed router
migrations separately in additive `beeline_router_schema_state.version=61`.
`markSchemaCurrent` writes both in the final migration call. Candidate boot
requires both exact versions in one read; the historical boot function still
reads its unchanged marker. No capability flag bypasses readiness, no range of
unknown versions is accepted, and missing/incomplete router migrations refuse
candidate boot. Old migrations cannot erase the separate router marker by
rewriting their own marker.

`router-schema-rollback.test.ts` executes the verbatim historical marker/boot
functions in `fixtures/schema46-readiness.source.txt` alongside the candidate
functions on isolated PGlite. The fixture records its source commit and complete
historical file hash; any historical connection-error/retry path fails the test.
The proof covers old boot before/after expansion, current boot only after both
markers, a historical marker rewrite, incomplete/missing router markers and a
wrong base marker. It is not a historical server image or complete DDL proof.

The additive review found a write window in the staged Saved metadata DDL:
`bookmark_id NOT NULL` preceded installation of its old-writer identity trigger.
The migration now installs a UUID default before backfill/NOT NULL so an old
writer can insert between every release statement, including trigger replacement
on rerun. The Saved-window test interleaves legacy inserts with every actual
DDL statement twice and requires unique, non-null final identities. Existing
old columns and wire fields remain. This module is staged/uninstalled; changing
it does not establish that the complete migration graph is backward-compatible.

### Historical-source expansion smoke

`scripts/prove-router-expansion-source.mjs` passes on isolated PostgreSQL16 and
actual loopback WebSockets. It checks all621 archived `apps/server` files against
Git blobs at `f43bd3f86e4c7a30aa75378df82fcbda10027c72` before loading historical
migration/PhoneService/live/server modules. The [result artifact](t7-expansion-source-proof.json)
records entry hashes, the installed dependency lock and production base head.

After historical migration and a synthetic Room fixture, the current migration
preserves all1,508 existing catalog columns (name, type and nullability) and adds
54 catalog columns. The already-running old handler returns the identical Room
DTO after expansion and commits a reaction. Stopping/recreating that old socket
server still works; its Room wire equals the current policy-off handler's wire.
A current-handler reaction removes the reaction once. Repeating migration
preserves the complete then-current old DTO and both exact readiness checks.

This is a **historical-source smoke with current installed dependencies**.
Auth is synthetic, the server startup/background lifecycle is not executed,
auth-service migrations and every old operation/cohort are not covered, and
catalog comparison does not prove all constraints/index semantics. It is not a
historical container image, canary deployment or complete rollback proof. The
first run's final assertion compared against revision0 from before two intended
reaction writes; it was corrected to assert revision2 before repeated migration
and compare that exact current DTO afterwards. No production behavior/assertion
budget was changed to obtain the passing result.

Reproduce from this checkout with an isolated loopback URL in
`BEELINE_COMMAND_TEST_POSTGRES_URL`:

```sh
mkdir -p .beeline-proof/historical-server46
git archive f43bd3f86e4c7a30aa75378df82fcbda10027c72 apps/server package.json tsconfig.base.json | tar -x -C .beeline-proof/historical-server46
ln -s "$PWD/node_modules" .beeline-proof/historical-server46/node_modules
NODE_OPTIONS=--max-old-space-size=4096 node --import tsx scripts/prove-router-expansion-source.mjs .beeline-proof/historical-server46
```

### Required release sequence

1. **Expansion release, router off.** Cut the prerequisite release from the
   supported main image with additive router schema plus boot and durable-outcome
   compatibility code. Preserve old tables, columns, write defaults, endpoint
   formats and the base marker 46. Install new tables/nullable or defaulted
   columns, backfills and compatible source capture without removing old paths.
   Runtime behavior outside that prerequisite scope stays at the supported
   release. Do not deploy the entire combined draft as a schema-only release.
   Run the old application's read/write corpus against the expanded database,
   including writes interleaved with migration statements; build both exact
   images and prove restart/boot plus the real canary auto-revert path in an
   isolated environment. The original image remains a valid rollback target
   during this release because no router-selected commands exist yet.
2. **Establish the image floor.** Complete the normal two-machine canary sequence
   with the expansion image and router still off. Record its immutable image
   reference and release record as the supported recovery floor. Both machines
   must interpret retained command identities, pending/unknown/expired outcomes,
   generation ownership and legacy wire before any router activation. Merely
   retaining tables or passing the old boot check is insufficient. This is an
   owner-operated release prerequisite; no production state was inspected or
   changed by these proofs.
3. **Switch release.** Only after F01–F26 and the remaining T7 cohort/budget
   proofs close, select the unified router using the existing rollout setting.
   Its migration must leave the expansion image's base and router markers valid;
   no destructive DDL or old-wire removal belongs here. The release planner
   already remembers each machine's prior image: canary auto-revert now targets
   the ledger-aware expansion image, not the pre-router source. Prove selected
   command/unknown outcomes, both serving machines and old/new clients through
   that actual image transition without duplicate effects or blanket reads.
4. **Removal follows stability.** Delete obsolete implementations only after
   supported wire ingress, runtime40 and mixed-cohort proofs pass. Preserve the
   expansion recovery floor and durable outcomes throughout the rollback window.
   Any eventual contraction needs its own compatibility boundary; it is not
   bundled into the switch migration.

`planServerCanaryDeployment` in `scripts/unified-release.mjs` runs migration
before replacing the first machine. Its auto-revert and the manual
`.github/workflows/server-rollback.yml` change images only. They must remain
usable with the sequence above; neither performs a destructive database rewind.
A pre-migration backup restore would lose newer writes and does not satisfy
retained-outcome rollback. The historical image remains a boot-compatible
**expansion** fallback, not a safe **post-switch** recovery floor: its dispatcher
has no router ledger interpretation. No exact built/deployed expansion image,
full DDL/old-application corpus, or complete image rollback has yet been proven.

## Native runtime 40

The [current candidate historical-source proof](../../apps/mobile/evidence/network-router-native40/current-candidate/README.md)
records the expired release artifact lookup, authorized locally built runtime40
APK, candidate hashes and seven successful launches. The
[admission-owner follow-up](../../apps/mobile/evidence/network-router-native40/admission-owner/README.md)
adds the actual byte admission owner, cancellation and authority-removal path.
Both explicitly use synthetic services/adapters in an isolated emulator.
They are not the Play-distributed binary, actual OTA delivery, authenticated
full-family integration, physical-phone latency, iOS or Tauri proofs.

## Bundle and boundary snapshot

[Machine-readable snapshot](t7-boundary-snapshot.json) records the production
head `73a6c477d`, manifest hashes and hashes of every bundled input after the
group draft integration. Bundle inputs differ from the earlier staged snapshot.

| Measurement | Observed | Hard limit / meaning |
| --- | --- | --- |
| Complete private phone owner | 83,222 raw / 23,714 gzip bytes | 90,112 / 24,576; passes |
| Phone shadow input entry | 27,388 raw / 5,872 gzip bytes | 32,768 / 8,192; passes |
| Router boundary inventory | 158 keys / 218 occurrences | All declared, but still legacy migration debt |
| Phone channel inventory | 72 keys / 89 occurrences | Matches the existing manifest; zero scanner errors |

Bundle measurements use esbuild with browser/ESM/bundle/minify and gzip defaults,
matching `scripts/network-codec-bundle.test.mjs`. These are shared consumer
entry measurements, not the complete application bundle. The original phone
network scanner and its manifest are unchanged. The router extraction still
includes network imports as well as calls; the count is not a request count.

The [router-only removal sweep](router-only-removal.md) is still nonempty.
The operation catalogue still constructs `legacy-only` entries, and the
declared migration boundaries still need real route ownership and executable
closure. Passing the inventory ratchet does not mean every boundary is owned.
Runtime SDK/native captures, all supported cohorts, equal-workload CPU/WAL/
wire budgets and the complete migration/rollback matrix remain required.

## Enforcement observations for owner disposition

The existing CI checks compare inventories against the trusted base but execute
the proposed scanner source. A changed scanner could therefore approve its own
relaxed policy. The read-only main-protection response observed during this
work has no required PR reviews and administrator enforcement disabled.

Per firstmate instruction039, these are observations only: no additional or
tightened enforcement gate is authorized. The added base-scanner driver was
reverted; the existing phone/router scanners and CI hooks remain as specified.
No live repository settings were changed. These observations do not establish
the specification's enforceable-review proof or close T7.

## Integrated verification checkpoint

On the composed group source: Group A's seven scoped PostgreSQL scenarios and
Group B's four background-composition PostgreSQL cases pass, using one suite at
a time on an isolated loopback PostgreSQL16 cluster in this worktree. Schema
readiness passes the historical-source marker proof plus all three existing
release-readiness cases; Saved-window tests pass all20 cases, including legacy
inserts between each DDL statement twice. Server types, all three existing
bundle gates and the unchanged inventory checks pass. These results do not
replace each group's outstanding strict closure/cohort obligations.

The integrated Group C payload script passes:200 tools produce zero initial
tool rows and a1,866-byte initial value; explicit pages recover all200 tools,
one requested output retains32,768 bytes, and revocation enqueues zero results.
Its four PostgreSQL completion cases also pass. The separate strict F13
statement/CPU/WAL workload obligation remains open.

The current trusted-base architecture check **fails** on five inherited
relaxations in `architecture/invariants.json`: `live.notify` owner additions,
`settings.server-env`60→61, `paths.server-parallel`18→20,
`paths.helper-parallel`29→30 and `paths.phone-parallel`19→24. No baseline or guard
was changed during integration to silence them. These are not a green
architecture result; the existing owner-only disposition/removal obligation
remains. Workflow-path validation passes132 references.

The integrated source also passes all21 phone socket/HTTP compatibility tests,
both actual mobile transport recovery cases, and the normal mobile typecheck.
