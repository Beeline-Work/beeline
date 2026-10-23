# Corner call-site states

Feature request, not a defect report. The approved line uses the existing gold
branch glyph, then Opened, Merged or Closed and the bare corner name. Only
Merged has a PR link. The line opens the corner; its PR link opens GitHub.
The name can truncate while the PR link stays visible and keeps its own
Android accessibility bounds.

Several corners from one requesting message each retain a visible line; they
do not collapse into a grouped disclosure.

The original marker retains its message id, source id and timestamp through
completion. Merge and close update source cards inside the archival transaction,
so the live message invalidation reaches the originating Room, DM or corner.
The phone projects current state for parent-Room cards. It omits source-free
opening subscription records. Off-Room requests receive one Room completion
card only at merge; Room requests use their existing marker. A partial concurrent
index on daemon-fact corner ids bounds settlement to the affected corner.

`corner-callsite.integration.test.ts` drives DaemonService.createCorner,
PhoneService.readRoom, the GitHub merge webhook and the phone close action in
an isolated PGlite database. It checks all source kinds, unchanged ids and
positions, idempotent webhook delivery, Room completion placement and private
source isolation. Component tests verify state changes on the same mounted row,
review staying Opened, numeric/slashed names and separate navigation targets.
Existing title tests preserve full #room/corner headers and bare unknown-Room
fallbacks; sidebar tests preserve the corner glyph without a # prefix.

## Rendered proof

The screenshot gallery and original-image archive are posted in the corner.
They cover phone and web, Bone and Obsidian, Room/DM/parent corner, and every
Opened/Merged/Closed state (36 screenshots). The archive includes Android
UIAutomator XML and callback receipts for both platforms.

This is a local service-to-UI proof. The committed snapshot contains the actual
isolated phone read responses. The built Android app and Chrome render them
through production anchoring, lifecycle folding, CornerOpenedMarkers and
NotificationLifecycleCard, with production fonts and theme tokens. No signed-in
production session or production write is used. The harness supplies the source
message and surrounding pane labels; it does not replace the tested rows.

The web proof substitutes device APIs and the Unistyles runtime and uses the
production Ledger marginalia width. Android uses the real native runtime.
Its PR Text target is a sibling of the truncating name so Android reports the
correct bounds even on a narrow phone.

## Repeat

Export fresh service responses with:

```sh
BEELINE_CORNER_CALLSITE_PROOF_OUTPUT="$PWD/apps/mobile/scripts/corner-line-proof-snapshot.json" \
  npm test -w @beeline/server -- src/corner-callsite.integration.test.ts \
  --maxWorkers=1 --minWorkers=1
node --import tsx apps/mobile/scripts/capture-corner-line-web.mjs
```

For Android, run Expo prebuild locally, point the generated app build.gradle
entryFile at `../../scripts/corner-line-native-proof.tsx`, and disable Expo
Updates in the generated manifest. Build assembleRelease for x86_64 with two
workers and a 4 GiB Gradle heap. The generated Android tree stays ignored.
Install the APK on a `beeline emulator` lease, then capture and verify:

```sh
python3 apps/mobile/scripts/capture-corner-line-android.py \
  --serial emulator-<leased-port> --out .verification/corner-line
```

The receipt files beside this README record the platform, exact callback
destinations and successful scenes. `android-build.json` identifies the APK.
