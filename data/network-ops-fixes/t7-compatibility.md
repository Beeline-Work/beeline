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

The current main image at `f43bd3f86e4c7a30aa75378df82fcbda10027c72`
requires schema 46; this candidate requires schema 61. Both boot checks require
an exact marker. A previous image therefore cannot simply restart after the
candidate migration's final marker. The passing tests above must not be used as
evidence for that image rollback. Before activation, a ledger-preserving image
floor and compatible schema rollout must be established for both serving
machines and the release recovery path. Neither the native runtime number nor
the presence of the command table establishes that floor.

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
base head, manifest hashes and hashes of every bundled input. The test-only
change accompanying the snapshot does not change those inputs.

| Measurement | Observed | Hard limit / meaning |
| --- | --- | --- |
| Complete private phone owner | 82,592 raw / 23,589 gzip bytes | 90,112 / 24,576; passes |
| Phone shadow input entry | 27,146 raw / 5,838 gzip bytes | 32,768 / 8,192; passes |
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
