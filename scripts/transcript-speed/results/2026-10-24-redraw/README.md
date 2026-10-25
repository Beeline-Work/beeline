# Android transcript redraw comparison

Reproduction `TRANSCRIPT-REDRAW-2`: sign into the disposable PR 2913 fixture, open Transcript A, type in the composer, receive a message, switch Rooms, observe two live replies and send a message. Before, one incoming message caused a median 42 row commits (31 distinct rows); one key press caused 2. After, the incoming message commits exactly its one new row, and typing commits none. All three incoming trials and all 21 key presses agree.

## Same-device release measurements

JS figures are pooled animation-frame interval p95 in milliseconds, using the same PR 2913 sampler. UI figures are the median of each trial's Android gfxinfo p95 histogram. These are separate measurements, not interchangeable input latency or physical scanout. Row figures are median commits per scenario, including lifecycle updates. Each scenario has three repeats; typing has 21 key presses.

| Scenario | JS p95 before / after ms | UI p95 before / after ms | Row commits before / after |
| --- | ---: | ---: | ---: |
| Incoming message | 18.9 / 17.7 | 17 / 27 | 42 / 1 |
| Key press | 17.8 / 17.0 | 16 / 16 | 2 / 0 |
| Room switches (20 per trial) | 204.4 / 78.8 | 117 / 101 | 2342 / 1142 |
| Optimistic send | 49.3 / 30.6 | 48 / 28 | 88 / 6 |
| Two concurrent agent replies | 50.2 / 32.8 | 32 / 26 | 253 / 23 |
| Fast scroll / fling | 23.9 / 34.8 | 28 / 42 | 61 / 31 |

Room-switch JS p95 is lower by 61%; send by 38%; concurrent replies by 35%. **Fast-scroll frame timing regressed in this run despite fewer row commits, and incoming UI p95 rose.** These results do not establish that scrolling became faster. Swipe/parser work and a list-engine replacement remain outside this change. Streaming trials include start/stop presence changes, working bylines, placeholder replacement and the two draft bodies; they are not a count per token. Both reply labels were verified by screenshot OCR outside timing, and each optimistic send settled on the fixture server.

The fresh-data same-device before run measured 204 ms Room-switch JS p95, versus the earlier published 154 ms run. The table compares the matched fresh-data arms, not those different cache histories. Each arm cleared only the fixture app's data, reset scenario traffic and used the same emulator, seed, network, driver and scenario options. No builds/tests ran during sampling. Both captures contain 42 samples; the driver's legacy `status: partial` label remains even on normal completion. Final artifact/fixture/build fields, all three send settlements, incoming visibility and all scenario counts are present.

## Regression repeat investigation

[All repeat results, median and spread](repeats/REPEATS.md) retain the alternating before/after trials, full-suite repeats and separate scroll profiles. The original table above is historical; it is not a no-regression acceptance verdict. Ruby subsequently approved transition-based Room-switch acceptance; the [same-instance real-tap proof](room-switch/README.md) passes, with settled time, JS CPU busy time and worst gap all improving.

## Runtime and provenance

Android 15 API 35 userdebug emulator, `se_api35`, 1080×2400, 60 Hz, x86_64, software GPU, four cores, 2560 MiB. Owned serial `127.0.0.1:5567` (same emulator as `emulator-5566`). Local Postgres fixture and delayed proxy: RTT 100 ms, jitter 0, 10 Mbps. Seed fingerprint `cd7b92b10869393264cc3c20f1ff42f4c3c8a9ef77223697504231deeec64ae4`.

Both APKs are release builds with Hermes/Fabric and React Compiler **off**. After-build prop tracing is off; before-build prop tracing did not exist. Diagnostic traces are separate from timing captures. Private driver port 19896 maps through this emulator's reverse port 19886, preventing other fixture apps from consuming commands. `TRANSCRIPT_SKIP_HISTORY=1` is identical in both arms; the separate long history-prepend experiment is omitted. Android only, as requested.

- Before embedded build: `827dbc0018c2eede4f3729bf510147a021757b14`, clean tracked tree; its product source matches PR 2913's `dc889ca98` head (later differences were harness/results/docs). APK SHA-256 `f72b96ba2bee56395291cafab5c3eb9e4ebe6e2464261d4e77746ba04cfb0eba`.
- After embedded build: `9c58c9f40fee7d3c84c2dcabe6187d2de3bcdb5a`, clean tracked tree. APK SHA-256 `061be2300d89505768aaf618ecdcd2fc2b886ac0af7d06551bd6b3da5f832b91`. A later driver-only commit adds bounded retries to transient accessibility reads outside timing; it does not alter app source.
- Each driver verified the installed APK hash against its supplied artifact. APKs remain local and are not attached.
- Host: shared squire, Intel i9-10900K (20 logical CPUs). [Before](before-host.json) and [after](after-host.json) load snapshots are retained. Emulator and shared-host variability limit causal claims about small frame-time changes. This is not physical-phone performance, and total instrumentation overhead is unquantified.

## Evidence

[Before raw capture](before.json.gz), [after raw capture](after.json.gz), [implementation](IMPLEMENTATION.md), [checks and baseline fingerprint exception](CHECKS.md). Screenshots and visible-path proof accompany this report. Compressed diagnostic traces retain the canonical-window churn and arrival-context causes; the baseline Hermes Room-switch profile points to React render/reconciliation work. Diagnostic builds/samples are not timing evidence.


## Visible regression proof

The [row-update capture](row-updates.json.gz) passed on the same after APK. Incoming, visible edit and server reaction each committed one row. A real reaction-chip press changed the displayed count; typing committed zero rows. Composer center moved from `(491, 2260)` to `(491, 1440)` above the keyboard and returned to `(491, 2260)`. While reading older content, `Fixture 0999: agent answer` stayed at `(541, 1195)` before and after another incoming message.

[Edited row and reaction](edited-and-reacted.png), [keyboard dock](keyboard-dock.png), [preserved history position](reading-position.png), [before transcript](before-transcript.png), [after transcript](after-transcript.png). The transcript comparison uses the same seeded row 0996 notification anchor after a fresh app-data reset in each arm. Status-bar clock changes are expected.

Pixel comparison of the original PNGs below the status bar (`y >= 136`) is identical; only status-bar pixels differ.
