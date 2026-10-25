# Transcript list experiment

Measurement only; no shipped list migration. This is not a defect report.
The step 1 fixture, server stimulus and capture drivers remain the user path.
Android uses one leased Android release/Hermes emulator for every candidate.
Desktop web uses Chromium at 1440 × 844. iOS is excluded by owner decision.

## Build selection

Run `node scripts/transcript-speed/prepare-list-engines.mjs` after
`npm run corner:prepare`. This extracts the pinned LegendList 3.6.0 registry
archive to an ignored benchmark-only alias, verifies its SHA-256, and runs no
package scripts. It changes neither manifest nor lockfile. The originally
installed 2.0.0-beta.3 crashes on web because its React Native batching export
is absent from the installed React Native Web. Retain that compatibility result,
but use stable 3.6.0 for the comparison. FlashList remains the lockfile's 2.3.2.

Set `BEELINE_TRANSCRIPT_MEASURE=1`, `BEELINE_TRANSCRIPT_ENGINE` and
`EXPO_PUBLIC_TRANSCRIPT_ENGINE` to the same engine: `flatlist`, `flashlist` or
`legendlist`. Clear Metro between engines. The existing measurement Babel plugin
substitutes the benchmark adapter and selects the list path on web. Ordinary
builds do not import the adapter or alter the desktop DOM transcript. Build
metadata records the engine and rejects mismatched selections.

Tuned FlatList uses eight initial rows, batches of eight, a seven-viewport
window and a 16 ms batching period. FlashList uses its v2 defaults and native
inversion. LegendList explicitly enables recycling and visible-position
maintenance with a 200 px initial size estimate. Its installed version lacks
inversion: the adapter flips the list and each cell/header/footer. All candidates
use the same newest-first data, row renderer, key extractor, scroll controller
and row-layout acknowledgement. Recycling candidates keep that acknowledgement
in a row wrapper because their cell contracts differ from FlatList's.

The adapter sits outside the app's Unistyles Babel boundary. It resolves the
fixture's common flex layout and theme padding explicitly, preserving the
parent's plain tail-padding override. LegendList's DOM web entry additionally
needs a constrained viewport wrapper, DOM padding values, a real viewport test
ID and a content-size bridge; RN transform arrays are applied by its surrounding
RN View. Run `inspect-web.mjs` before counting a build: its viewport must remain
inside the application window and the screenshot must show upright content.

This measures a minimal integration, not each library's theoretical ceiling.
In particular, it does not replace the transcript controller with LegendList's
preferred chronological chat model. Any correctness failure belongs in the
result; do not remove a failed scenario to improve a candidate's numbers.

## Fixture isolation and captures

Use a fresh loopback `beeline_latency_rig_transcript_*` database and unoccupied
ports. `TRANSCRIPT_WEB_ORIGIN`, `TRANSCRIPT_WEB_PORT` and
`TRANSCRIPT_CONTROL_PORT` allow private listeners. Compile the app's monolith
and control URLs to those same ports. Set `TRANSCRIPT_IMAGE_ORIGIN` when seeding;
reverse the image port on the owned Android emulator. Existing rig instructions
cover the fixture server, local review sign-in and release build.

For desktop web set `TRANSCRIPT_WEB_WIDTH=1440`. The capture driver targets the
transcript viewport for wheel input, rather than the sidebar. Capture Room open,
scroll/fling, older history, incoming messages, settled send, concurrent streams
and typing. Preserve fixture assertions, APK identity checks and raw captures.

Set `TRANSCRIPT_REPEAT_COUNT=1` for an alternating block. Repeat complete blocks
in `flatlist, flashlist, legendlist`, then `legendlist, flashlist, flatlist`,
then `flatlist, flashlist, legendlist` order on each platform. Stop this
experiment's builds before timing. Preserve all trials, spread and host load.
Run opens separately with the same ordering and count. The default remains three
trials for existing callers.

For this comparison, `TRANSCRIPT_EXPERIMENT_KEEP_FAILURES=1` retains a failed
web history proof or Android two-stream visibility precheck as an explicit
`pathFailures` entry and continues the other scenarios. The default still aborts
on those failures. A completed driver with
path failures is a failed candidate, not a correctness pass; its timings must
never justify selecting a list that leaves the transcript blank.
History proof requires a row older than the initial fixture window (970–999),
not just an extra mounted row from that window. The report recomputes this
criterion from recorded row indices, including earlier trials whose old proof
could mistake recycler mounting for a successfully loaded older page.
If a strict trial aborts before this option is enabled, preserve that partial
trial and its screenshot, then record it in `observed-failures.json` beside the
platform capture directories. A replacement complete trial does not erase the
observed correctness failure. Report partial timing observations separately.

Start a fresh disposable fixture **process** before each engine trial, retaining
the same fixture database and network settings. The multi-engine batch otherwise
exhausts the review sign-in attempt window while repeatedly creating cold browser
contexts. Restart only the owned local fixture, wait for its proxy health check,
then reset generated traffic and capture. This setup runs outside timing windows
and requires no change to the server's normal sign-in limits.

If the documented Node 20 runtime cannot execute the Beeline Git wrapper,
`TRANSCRIPT_GIT=/usr/bin/git` selects the native Git binary **only for read-only
build metadata**. Repository writes retain their existing authentication path.

## Interpretation

Report JS animation-frame interval p50/p95, worst interval and missed JS frame
opportunities. These are scheduling/rendering intervals, not JS execution time
or compositor dropped frames. Android HWUI supplies separate janky-frame counts
and UI percentiles. Missing browser compositor metrics stay unmeasured.
Open settling includes the harness's quiet confirmation window. Memory reports
must name JS heap versus process PSS; short growth does not prove a leak.
Visual sampling must state its coverage and cannot prove an absence of transient
blank cells between samples. Retain keyboard, inverted order and history anchor
evidence. Explain recycling results against the step 3 React/Fabric and native
ShadowTree commit/layout/mount attribution.

Both candidates are JS-only: FlashList v2 requires New Architecture;
LegendList does not add a native module. Both library names already occur in the
mobile manifest; the stable LegendList alias is an isolated experiment upgrade.
This experiment changes no shipped dependency or native runtime pin.
