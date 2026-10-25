# Transcript list engine decision

Recommend **FlashList v2 for the next Android migration**, with a separate approval and migration verification. Recommend **retain the existing chronological DOM renderer on desktop web**. Among the three experimental virtualized web candidates, tuned FlatList is the only one that passed scrolling and loading older history. This is a measurement result, not a shipped migration or a defect report.

The Android choice favors correctness, lower memory and faster warm Room opens rather than a universal frame-time win. FlashList was the only Android candidate whose captured paths all passed. Tuned FlatList clipped a concurrent stream in the final repeat; LegendList clipped one in an earlier strict trial. Those observations remain failures even where subsequent trials passed.

## Decision numbers

Values are parenthesized. Full scenario tables and repeat spreads are in [MEASUREMENTS.md](MEASUREMENTS.md). Android memory is process PSS; web memory is JS heap. Do not compare them across platforms.

| Platform / engine | JS interval p50 / p95, ms | Missed JS opportunities | HWUI janky / rendered; missed vsync | Warm open median; range, ms | Memory median; range, MiB | Correctness |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Android tuned FlatList | (16.67 / 23.54) | (1563) | (232 / 3354; 4) | (1094; 1087–1095) | (269.07; 267.48–272.15) | One concurrent stream clipped in final repeat |
| Android FlashList 2.3.2 | (16.67 / 25.40) | (1485) | (258 / 3322; 8) | (974; 966–980) | (242.94; 238.40–251.17) | All captured paths passed |
| Android LegendList 3.6.0 | (16.67 / 23.81) | (1337) | (310 / 3221; 27) | (969; 959–1064) | (243.31; 229.91–244.12) | One concurrent stream clipped in aborted strict trial |
| Web tuned FlatList | (16.70 / 16.70) | (14) | (unmeasured) | (784.59; 766.50–802.32) | (39.41; 37.21–41.94) | Captured paths passed |
| Web FlashList 2.3.2 | (16.70 / 16.80) | (83) | (unmeasured) | (855.39; 845.13–861.88) | (51.34; 43.42–52.32) | Same wheel gesture did not scroll; older page not loaded |
| Web LegendList 3.6.0 | (16.70 / 16.80) | (14) | (unmeasured) | (782.97; 775.20–795.91) | (45.82; 45.79–45.91) | Same wheel gesture did not scroll; older page not loaded |

These JS intervals measure animation-frame scheduling, not JS execution time. Missed JS opportunities estimate intervals beyond a refresh budget; HWUI jank and missed-vsync counters are separate proxies. Physical compositor dropped frames were not measured on either platform. Recycler web scroll/fling timing is timing of attempted, ineffective gestures, **not comparable successful scrolling work**.

FlashList's Android warm median improved by (120 ms), with lower PSS by (26.13 MiB), versus tuned FlatList. Cold-process medians were (3450 / 3356 / 3559 ms) for Flat/Flash/Legend, with overlapping wide ranges. The warm advantage does not establish a cold-launch improvement. FlashList scroll p95 varied (21.35–39.16 ms), versus FlatList (21.53–23.02 ms); fling p95 median was worse (31.08 versus 28.22 ms). History worst-gap median improved (170.15 versus 202.29 ms), while history p95 worsened (29.37 versus 27.11 ms). Keep those tradeoffs visible when approving the migration.

## Visible results

All candidates displayed upright newest-first transcripts on Android. Each complete Android trial loaded older rows beyond the initial fixture window. Incoming messages, confirmed sends, typing and Room switches were exercised; the two-stream exceptions above are real visible failures, not discarded timing outliers. [FlatList failure](flatlist-streams.png), [LegendList failure](legendlist-streams.png) and [FlashList passing sample](flashlist-streams.png) show the contrast. The FlatList failure shows Stream 0 but not Stream 1; the LegendList failure shows Stream 1 while Stream 0's body is clipped at the composer.

Android fast swipes produced changing content in all engines. The [contact sheet](android-fast-scroll.jpg) shows every discrete sample. No fully blank viewport or obvious missing rectangular cell was visible in the sampled images (0/8 per engine). Web FlatList also had no observed blank viewport/cell gap (0/8); its image transitions and history indices confirm movement. FlashList and LegendList web each produced stationary screenshots (8/8); blank cells **during fast scrolling remain unmeasured** for those candidates. Screenshots are discrete and cannot exclude brief gaps between captures, nor identify a missing row without a visible gap. No continuous video or blank-area callback was available.

Android keyboard samples for all engines show an upright transcript and composer above the IME. Older-history screenshots show different row/date alignment after the gesture; pixel anchor displacement was not instrumented, so loading proof is not an anchor-stability guarantee. Sticky date placement, accessibility navigation, swipe gestures and recycled row state were not exhaustively verified. No swipe implementation was edited.

Web actual-viewport audits passed incoming, server-confirmed send and both live stream visibility for all candidates. Nevertheless, FlashList and LegendList failed scroll/history in all completed blocks. The experimental build deliberately routes desktop through the native inverted controller. The shipped chronological DOM renderer was not a matched control: the web result does not prove FlatList would improve the current shipped web experience. Retaining that renderer is the defensible present choice; select tuned FlatList only if a separate web virtualization project is approved.

## Method and limits

The Step 1 fixture and flows from PR 2913 were used: the same deterministic mixed transcript, Room open, typing, scroll/fling, load older, incoming, settled send, concurrent streams and repeated Room switches. Backend/proxy/image ports were isolated (20880/20881/20882), with (100 ms RTT, zero jitter, 10 Mbps), and the same delayed placeholder image. The fixture fingerprint is checked across every engine and platform by the report generator.

Each platform used complete alternating blocks (Flat/Flash/Legend, Legend/Flash/Flat, Flat/Flash/Legend), with one scenario repeat per block and seven keystrokes per repeat (three trials and twenty-one keystrokes per engine). Opens were captured separately in the same blocks. Timing collection ran after compilers stopped. Desktop Chromium was headless with a matched viewport (1440 × 844; transcript rectangle x376/y61/1064×689). All corrected candidates had matching flex layout/padding before acceptance.

Android used the same continuously running API 35 x86_64 emulator, SwiftShader, release/Hermes/Fabric, React Compiler off and prop trace off. Classic ADB serial emulator-5566 disappeared during a FlatList trial while the guest remained running; QEMU process, guest uptime, fingerprint and loopback transport confirmed the same VM. Collection resumed through 127.0.0.1:5567 with the private ADB server (5798). The interrupted partial trial is retained separately. This emulator is not a physical-device performance calibration; shared-host scheduling adds noise. Repeats and spread describe observed variation, not confidence intervals.

Repeated cold fixture logins exhausted the local review-login attempt window. The owned fixture process was restarted outside timing before each engine, retaining database/network settings. No server security policy was changed. Open settling includes the harness quiet confirmation window. Memory is a snapshot after repeated switches, not leak evidence. Instrumentation overhead was not calibrated for these engine builds; all candidates used the same build-only commit counters and animation-frame sampler. No claim is made about uninstrumented absolute timings.

Two incomplete native trials are preserved outside complete-trial quantiles. The strict LegendList trial failed the two-stream visibility precheck; before that failure its scroll/fling/history p95 values were (43.17 / 50.28 / 34.62 ms), with worst gaps (197.27 / 120.51 / 207.92 ms). The ADB-interrupted FlatList trial's same observations were (21.60 / 33.82 / 34.46 ms), worst gaps (52.72 / 122.84 / 258.97 ms). These partial results broaden uncertainty and must not be represented as successful complete trials or silently erased.

## Why recycling helps, and where it did not

Step 3 PR 2923 attributed cost to React/Fabric rendering plus native ShadowTree commit/layout/mount. Recycling should reduce repeated creation/mount work. Here, warm-switch row commit medians fell from FlatList (380) to FlashList (266) and LegendList (46); history commits fell (139 → 128 → 120). Lower PSS and faster warm opens are consistent with reuse. This is an inference: row commits are not native mount counts, and this experiment did not collect per-engine native CPU profiles. Recycling did not remove all render/layout work: FlashList's overall interval p95 and HWUI jank were worse than tuned FlatList's, and LegendList had slower scrolling plus a correctness failure. Fewer commits alone is insufficient grounds to migrate.

## Migration risks and change size

| Area | Required before a separately approved migration |
| --- | --- |
| Inversion and tail following | Verify newest-first ordering, jump-to-newest, short lists and both live stream bodies throughout growth and settlement. Preserve the current controller contract or explicitly redesign it. |
| Older-history anchoring | Measure actual pixel displacement while prepending mixed-height text/code/images, during delayed image loads and while reading mid-history. Existing page proof checks only older data became visible. |
| Swipe and recycled state | Verify reply/forward swipe closes, tapability, expansion state, selection, media and animations reset when a cell receives a different message. Coordinate with the separate swipe corner; do not include its implementation here. |
| Sticky dates | Verify dates stick to the correct day in the inverted coordinate system and during rapid direction changes; current screenshot checks do not prove all boundaries. |
| Keyboard and accessibility | Repeat focused composer/IME transitions, font scaling, screen-reader order and focus restoration on a physical Android device. |
| Web | Fix actual wheel propagation and history triggering before considering a recycler; compare against the shipped DOM renderer with a chronological integration. |

The benchmark adapter is (71 lines), plus build-only selection and fixture tooling. This is a small integration seam, not the size of a production migration. FlashList needs an import/ref/component swap, tuned-prop removal, its visible-position configuration and the row-layout acknowledgement wrapper. Those changes touch the transcript surface/controller boundary; recycled row state and anchoring verification dominate the work. Estimate one focused implementation PR plus device verification, with scope growing if controller semantics change. Retaining the present web renderer needs no migration. LegendList adds manual inversion/header/footer wrappers and a separate DOM web bridge in this port, and upgrading from the installed beta expands its scope further. No time estimate is supported by this measurement.

FlashList v2 is JS-only and requires New Architecture ([upstream](https://github.com/Shopify/flash-list), [migration guide](https://shopify.github.io/flash-list/docs/v2-migration/)). LegendList is also a JS library; its stable package has no added native module. Its [v3 API](https://legendapp.com/open-source/list/v3/api/) exposes recycling and native visible-position anchoring. Existing native runtime requirements still apply: introducing an actual native dependency or changing runtime pins later requires a store build. Neither is proposed here. Both names already exist in the mobile manifest; this experiment keeps FlashList at the lockfile's (2.3.2) and extracts stable LegendList (3.6.0) into an ignored alias without changing manifests or lockfiles. The installed LegendList beta (2.0.0-beta.3) failed web startup because its batching export was missing; it was not substituted silently.

## Provenance and evidence

Measured checkout was `077e9050d3074fc9d32dc05caa1e4345dd56d202` plus the saved experiment sources. The original build hook incorrectly computed its source diff relative to Metro's mobile working directory and stamped an empty diff. **That stamp does not prove a clean measured build.** The hook now anchors Git at the repository root, with a passing regression. Raw captures retain the original stamp.

Independent evidence: each installed APK was hash-checked against its selected artifact; actual engine, Hermes/Fabric and compiler flags were recorded. Saved pre-fix source snapshots include adapter/runtime/plugin/config and unchanged transcript sources. [Source-map verification](source-map-verification.json) confirms the last generated Hermes bundle exactly matches the saved LegendList APK and its source map exactly matches adapter/runtime/transcript/row snapshots. This directly verifies the last-built LegendList artifact; earlier APKs retain hash/engine/source-snapshot evidence, not independently matched composed source maps.

[evidence.tar.gz](evidence.tar.gz) contains all accepted raw capture/open JSON, OCR, visual metadata, source snapshots, selected original screenshots and both aborted partial trials. [evidence-manifest.json](evidence-manifest.json) hashes every original accepted capture file and explicitly marks which are included in the archive. Native fast-scroll PNGs are represented by the complete contact sheet; unique web fast-scroll representatives and selected native keyboard/history/stream originals are included. The remaining original PNGs stay in this corner's ignored capture directory; hashes alone are not substitutes for their pixels. APKs and generated exports remain local and are not committed.

To regenerate the numeric report, extract the archive, then run `node scripts/transcript-speed/list-engine-report.mjs <extracted>/captures <output.md>`. Read [LIST-ENGINES.md](../../LIST-ENGINES.md) for build selection and isolation. Harness/transition tests passed (11); root typecheck passed; dead-code baseline passed (four existing findings, zero introduced). The built Android and browser paths above supply the user-path demonstration, including recorded failures. No production list, dependency manifest or runtime pin changed.

Decision requested from Ruby: approve FlashList as the Android engine for a separately scoped migration, retain the current web renderer, and accept the explicit correctness/measurement limits above. No migration starts with this report.
