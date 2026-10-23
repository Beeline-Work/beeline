# R1: Android Room responsiveness

Back from a corner now keeps the mounted Room session and transcript. Room storage work waits for native transitions and JS interactions, with a background flush. Draft decoding rejects invalid, duplicate, stale and oversized updates before signature verification; accepted updates still require verification. Desktop keychain calls use `spawn_blocking`.

## Measured user path

On the same leased Android emulator, open Rig room 001 in Latency Rig 200, tap its rig-corner-001 card, and tap the corner header Back button. Repeat after one warmup. Then inject a growing agent draft through the local server's live-output lane and collect Android frame statistics. Type `jellybean-proof` in the returned Room without sending it.

| Observation | Before | After |
| --- | ---: | ---: |
| Back: median native visible Room frame | 279 ms | 114 ms |
| Back: slowest sampled frame | 288 ms | 119 ms |
| Corner open: median native visible corner frame | 234 ms | 188 ms |
| Corner open: slowest sampled frame | 243 ms | 240 ms |
| Streaming: Android janky frames / rendered frames | 180 / 293 | 75 / 545 |
| Streaming: Android janky percentage | 61.43% | 13.76% |
| Streaming: frame p50 / p95 | 65 / 150 ms | 29 / 53 ms |
| Returned Room accepts typing | Yes | Yes |

Navigation has five measured samples per direction per build, plus one excluded warmup. Streaming has one run per build: 100 cumulative snapshots at a nominal 100 ms cadence, growing to 14,013 characters. No builds or test suites ran during these captures.

The native probe starts on Android touch-up and ends at the frame commit containing the expected transcript text above the composer in the same native Screen. It measures visual readiness, rather than the first possible JavaScript interaction. The typing screenshots separately demonstrate an editable returned Room. Android `dumpsys gfxinfo` reports janky rendered frames; this is not a JS-FPS trace or a physical display drop counter.

This is an uncalibrated software-GPU emulator comparison, not a hardware performance guarantee. Android only; no iOS device proof or release was performed. Main advanced during the work: the baseline is `b5e800481295b6a6a164419583a76bca9331a66c`; fixed production sources are committed as `87dfd2bcfe5fdaa35ea8d6c5ee16a8fd061b9127`, based on `8021af7c3b4a5cb82ddd30f6eb1f2d2d0cbf4ba1`. Other main changes are therefore a confounder for attributing every millisecond to this patch. The deterministic red/green tests compare the fix with that newer main directly.

## Evidence and environment

[results.json](results.json) records every timed sample, exact source revisions, fixture dimensions and APK SHA-256 digests. Both APKs are release/Hermes/x86_64 builds with the same local fixture signing and native frame probe. The leased `se_api35` emulator used Android API 35, SwiftShader, four cores and 2,560 MiB. The local proxy used 100 ms RTT, zero jitter and 10 Mbps. Both builds used the same PostgreSQL fixture: 200 Rooms, 300 corners, a 30-message window, older activity and a 10 KiB answer.

The fixture preparation corrects legacy short message IDs to the current phone contract. Both final captures use that same corrected fixture. Earlier pilot captures are excluded from this table.

- [Before navigation](baseline-navigation.json), [after navigation](fixed-navigation.json), and their filtered [before](baseline-navigation-logcat.txt) / [after](fixed-navigation-logcat.txt) device logs.
- [Before frame statistics](baseline-stream-gfx.txt) and [after frame statistics](fixed-stream-gfx.txt).
- Visible long drafts: [before](baseline-stream.png), [after](fixed-stream.png).
- Editable returned Room: [before](baseline-room-typing.png), [after](fixed-room-typing.png).

## Repeating the capture

Read `scripts/latency-rig/README.md`, build the locally signed fixture APK, and start its disposable server/proxy. The attached fixture helpers target only `beeline_latency_rig_jellybean_responsive` on the local PostgreSQL socket. Use the local review sign-in and select Latency Rig 200. Run `node seed-stream.mjs` from this directory to prepare valid marker rows. The Back target is the Room marker; the corner-open target is the corner marker.

With the emulator in rig-corner-001, run:

```sh
LATENCY_RIG_DEVICE=<owned-emulator> LATENCY_RIG_OUTPUT=<output-directory> python3 capture-navigation.py <build-label>
```

The driver uses the recorded 1080×2400 display coordinates and fails if the native visibility marker never arrives. For streaming, reset `adb -s <owned-emulator> shell dumpsys gfxinfo app.usebeeline reset`, run `node stream.mjs` while the corner is visible, then save `adb -s <owned-emulator> shell dumpsys gfxinfo app.usebeeline framestats`. Remove this helper's `responsive-stream` live output and agent turn between builds. Keep the same fixture, emulator, network shape and build flags.

## Code and CI proof

Baseline costs are visible at `live-overlay.ts:58`, the focus-owned Room effect and cleanup in `useRoomSurfaceSession.ts:582,1358,1387`, synchronous `SurfaceRegistry.write`, `_chat-surface.tsx:784`, and the synchronous desktop commands in `src-tauri/src/lib.rs:14` at the baseline revision.

The fix moves verification after rejection checks, retains the Room session across focus changes, memoizes the surface boundary and moves focus-only effects off its render subscription. Storage deferral and the three-inactive-Room cache cap apply only to full `/room/<id>` responses. Other surface saves and caches keep their existing behavior. Removed or superseded data fences deferred writes. Mounted navigation screens retain their existing lifetimes; this cap bounds inactive registry responses, not the navigator's screen stack.

The always-running `SHARED PACKAGE TESTS` job now runs deterministic Room transition, save, state-reuse and boundary render tests as well as the shared decoder tests. There are no new wall-clock performance assertions in CI. The render test counts calls at the real route's memoized surface boundary with a lightweight body, paired with a guard against restoring an independent `useIsFocused` subscription in the heavy body.

[baseline-test-results.txt](baseline-test-results.txt) records five navigation/storage regressions and eight overlay regressions failing on current main. The fixed focused mobile suite passes 99 checks; the shared client suite passes 150. Root typecheck, workflow-path checks, dead-code baseline and the desktop Rust library check pass. Browser notification-landing, offline/retry, schedules, wallet and workspace paths were rerun after correcting native-boundary mocks and a concurrent shared-output rebuild.

The exploratory whole-mobile run was not green. Its affected regressions were fixed and rerun; the native fingerprint end-to-end check still fails locally on both this tree and an isolated main copy. Runtime pins and native fingerprint records were not changed. Live GitHub checks remain the merge authority.

### Review follow-up: background during a corner transition

R1 background-save variant: receive a canonical message delta, start pushing a
corner before the cache debounce expires, then background or inactivate the app
without advancing timers. The pending timer was outside the transition queue,
so the original PR head (`3280ff3a4`) did not save the latest message. Both new
regressions failed there (expected one save, observed zero).

The session now cancels that timer and writes its latest reconciled Room response
on either lifecycle event. The deterministic route/session regression observes
one save containing the new message before advancing timers, no duplicate after
the debounce interval, and no remaining lifecycle listener after unmount. It is
in the existing always-on responsiveness test file. The focused suite passes
(84 tests), and root typecheck passes.

This follow-up uses the exact lifecycle path in the mounted route harness; it
was not rebuilt or measured on Android. The Android timing table above describes
the earlier measured build and is unchanged.
