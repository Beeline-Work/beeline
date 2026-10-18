# Automatic OTA retention proof

This is an automation feature, not a defect report. Reproduction
OTA-PIN-PLUS-TWO compares the release command before and after the change.
No release, promotion, rollback, or store submission was dispatched.

## Reproduced

On main `6e51856d5c76b1ba1c0df948c0aaf10e2f0ba6fb` (after #2582),
run from `apps/mobile`:

```sh
node scripts/ota-release.mjs publish --dry-run --sha 6e51856d --ref main --ledger /tmp/ota-before.json
```

The plan contained 15 targets: Android 39, 31, 32, 33, 34, 35, 36, 38 and
iOS 29, 31, 32, 33, 34, 35, 36. That exceeds the owner's six-target limit.

## Demonstrated

`production-history.json` contains the newest row for each platform/runtime
from a read-only EAS production branch query on 2026-10-18 at 18:32 UTC
(project `58f1e94e-5ce5-475e-9dde-3eaa9e36699c`, newest 50 updates).
The original ordering and actual group IDs are preserved; duplicate older
rows for the same platform/runtime are omitted. No synthetic runtime is added.

With the same app config and pins, run:

```sh
OTA_EMBEDDED_ANCHOR_PLATFORMS=android,ios node scripts/ota-release.mjs publish \
  --dry-run --production-history evidence/ota-pin-plus-two/production-history.json \
  --sha 6e51856d --ref main --ledger /tmp/ota-after.json
```

Reproduction OTA-PIN-PLUS-TWO now prints:

```text
release_plan_targets=android@39,android@38,android@36,ios@36,ios@35,ios@34
pin-plus-two rule: dropping older production runtimes android@31, android@32, android@33, android@34, android@35, ios@29, ios@31, ios@32, ios@33
```

There are six uploads and two bundles (one per platform). Android 37 remains
explicitly retired. The four compatibility targets have production group
anchors in the captured response. The current pins Android 39 and iOS 36 do
not yet have production updates in that response, so they require the existing
native-build embedded-anchor authorization. The dry run supplies that flag
only to demonstrate the existing fallback; it does not prove a native build
or authorize a release.

The CLI integration tests run actual publish and rollback commands with a
local EAS substitute: publish records exactly six candidate targets, resolves
four production anchors plus the two authorized embedded anchors, and fails
closed without the embedded-anchor flag. Embedded rollback computes all six
targets from its production response. Missing selected targets, unreadable
history and incomplete candidate responses remain failures. Real publication
is outside this corner's scope; the substitute exercises the release path
without mutating EAS.

Historical promotion/rollback fixtures freeze their prior computed target set;
the new tests separately exercise current target computation and the CLI path.
Offline dry runs without a snapshot use only the committed shipped-native
ledger and label that limitation explicitly.

Validation: 83 mobile OTA tests and 49 unified-release tests passed, as did
root `npm run typecheck` and `npm run lint:workflow-paths`.
