# Phone surface rendering proof

This change isolates unchanged Room rows from list, outbox and corner-page updates; isolates the thinking line from streaming parent updates; and memoizes unchanged roster rows and Needs You cells. It changes no layout or transcript/send implementation.

## Measurement scope

Native Android evidence uses emulator-5628, the existing runtime-40 APK (versionCode 27, versionName 0.2.22), and the production proof account. The starting OTA was v0.1.142, source `98c2a49a4f3df909e8fd3fc32ae39129f6f8367b`. Both comparison bundles use that exact source baseline and freshly built v142 api-contract, nostr and buzz-client outputs; the after arm overlays only this change. The production URL, renderer, native binary, fonts and temporary instrumentation are identical. These are local profiling updates, not releases.

The host is shared and heavily loaded. The arms run consecutively in one session; each sample records host load. There are 10 repetitions per navigation case, 20 live updates per update case, and a separate native thinking-line run. A final members-only after bundle adds the member-row memo/callback fix; the first after pass remains retained as an intermediate measurement. Other measured surfaces never mount a MemberRosterRow during these cases. This is a small, warm-session comparison; nearest-rank p95 with ten samples is the maximum. It does not certify cold start, physical-device performance or every possible account size.

The navigation baseline began with 14 conversations. Other proof work added two Rooms during this session, so the live-update passes have 16; this account drift limits causal timing comparisons for navigation. Both live-arrival arms have 16 Rooms, and the roster remains four identities. The fixture Room has the same 30 messages in both navigation arms. Members has four identities; the tray has one existing Needs You item; the corner list has one idle corner. A new private Room, `ui-surface-speed-proof`, contains only the proof human. The controller checks sole membership before every command, seeds 30 plain messages, then generates the arrival samples. Saved updates alternate one owned fixture message on/off and finish off. No agent turn, approval action or transcript send UI is exercised.

Temporary in-tree React Profilers use the native production profiling renderer. `actualDuration` measures render work associated with a commit, not the commit phase itself. Layout-effect counters count committed component-body renders, including updates underneath memo boundaries. Buffered logs flush once per second. All instrumentation, controller polling and local install changes are absent from shipped source.

For timing, app tap/route/data-ready markers and layout effects use the same monotonic clock as Android `gfxinfo framestats`. The native-frame proxy is the first completed frame whose DrawStart follows the meaningful-content marker (or the changed row/counter layout effect). Incomplete emulator records whose FrameCompleted predates DrawStart are rejected. This is a native rendering proxy, not a scanout or optical paint measurement. Screenshots establish the resulting content, but are taken after the measured transition. They cannot certify a precise painted deadline. Foreground measures a retained activity, not a new process.

## Results

The tables and per-sample data are generated from the retained logs and framestats. Values are milliseconds unless labeled counts. See `measurements.json` and `update-measurements.json` for sample timestamps, counts, durations, host load and missing markers.

`p50 / p95`; arrows mean before → after. Navigation render cost is the largest root-profiler render within each transition. Body counts are committed renders across the measured transition, including hidden screens. Native timing begins immediately before the adb input command, so it conservatively includes command dispatch overhead. App JS-touch timestamps are also retained in the JSON.

| Surface (10 samples/arm) |           Peak root render ms |         Room-row bodies |                       Native-frame proxy ms | After proxy p95 <150 / <450 |
| ------------------------ | ----------------------------: | ----------------------: | ------------------------------------------: | :-------------------------: |
| Room list return         |    83.0 / 247.0 → 36.5 / 81.2 | 28.0 / 28.0 → 0.0 / 3.0 |               444.8 / 682.2 → 221.3 / 292.5 |          no / yes           |
| Tray open                |     25.3 / 66.5 → 19.7 / 51.9 |  0.0 / 14.0 → 0.0 / 0.0 |               335.0 / 689.8 → 231.4 / 495.7 |           no / no           |
| Members open             |   156.1 / 210.4 → 43.5 / 70.6 | 28.0 / 28.0 → 0.0 / 0.0 |               478.7 / 947.2 → 204.8 / 381.3 |          no / yes           |
| Corner list open         | 232.7 / 923.3 → 101.8 / 158.7 | 28.0 / 30.0 → 1.0 / 1.0 |              783.2 / 3404.8 → 179.9 / 394.8 |          no / yes           |
| Room open                | 253.6 / 720.9 → 189.7 / 453.8 | 14.0 / 14.0 → 0.0 / 0.0 | not comparable (0/10 → 2/10 native matches) |          unproven           |
| App foreground           |    90.9 / 278.8 → 43.3 / 97.5 | 14.0 / 42.0 → 0.0 / 0.0 |              678.0 / 1079.6 → 289.5 / 434.9 |          no / yes           |

The members fix additionally reduces MemberRosterRow body counts from **16 / 16 to 4 / 4**. Peak members-surface render cost falls from 62.6 / 183.7 → 34.6 / 61.5 ms. Each identity renders once per page open. The intermediate after pass without member-row memoization is retained in the JSON.

Room open has data-ready markers in all samples, but usually no later native draw: the static content draw can precede the existing double-requestAnimationFrame marker. Its ready-marker latency is 1422.9 / 2199.7 → 976.7 / 1767.4 ms. Neither those delayed markers nor the two surviving native matches establish first paint. They must not be converted into a passing paint claim. Corner navigation starts one second after opening its parent Room, so pending parent work can overlap; the root duration includes that work.

| Live update (20 samples/arm) |       Peak root render ms |            Body renders | Arrival → native-frame proxy ms | After proxy p95 <150 |
| ---------------------------- | ------------------------: | ----------------------: | ------------------------------: | :------------------: |
| Room-list message arrival    | 64.9 / 91.8 → 34.5 / 50.5 | 32.0 / 32.0 → 1.0 / 1.0 |    148.1 / 215.6 → 93.3 / 115.3 |         yes          |
| Tray Saved add/remove        |    6.4 / 11.9 → 5.1 / 7.8 |   3.0 / 3.0 → 1.0 / 1.0 |       37.3 / 52.0 → 29.6 / 40.3 |         yes          |

For message arrival, unchanged Room-row bodies fall from **30 / 30 to 0 / 0**, and only the changed row renders in the after arm. Total root render work per arrival falls from 113.5 / 167.6 → 63.3 / 85.1 ms. The tray still receives one cell render per update; this change removes the other two rather than ignoring changed DTOs or callbacks.

| Thinking fixture                           |      Before |       After |
| ------------------------------------------ | ----------: | ----------: |
| Capture seconds                            |       20.43 |       20.78 |
| Streaming parent body renders              |         307 |         312 |
| Working-line body renders                  |         307 |          21 |
| All root commits, render ms p50 / p95      |   1.1 / 1.6 |   0.2 / 1.1 |
| Counter effect → native frame ms p50 / p95 | 29.9 / 37.3 | 33.2 / 38.4 |

**Budget result:** these captures demonstrate less JavaScript work and a sub-150-ms p95 arrival/update proxy. They do **not** establish the universal 150/450-ms painted-time invariant. The tray proxy tail remains above 450 ms, navigation/foreground proxies exceed 150 ms, Room first paint is unresolved, and the shared-host/account drift prevents a calibrated navigation claim. Physical-device or compositor/optical paint proof and the independently owned transcript work remain necessary. No timing pass is inferred from a missing sample.

## Exact-candidate native behavioral validation

The [fresh native evidence packet](live-candidate/README.md) records the seven requested scenarios on candidate `ca54fc4c9534e94e4508ba482f1023d4b377c33e`, with all four phone SDKs freshly compiled from that revision. Its provenance identifies the installed runtime-40 bundle on reserved emulator-5628. The retained screenshots show actual native paint, not test-renderer output. Controller and host source copies are evidence only; they are not installed routes or shipped implementation.

**Re-evaluation of test-2:** the earlier authentication/device evidence blocker is resolved by the driver's exact-candidate packet. Inspection supports passing outcomes for Room arrival/refusal presentation, gestures, corner summary/archive isolation, current member destinations and Tray updates. The working-line counter and latest Stop callback pass at the native component interface in a controlled streaming host; server-agent cancellation remains untested. Refusals are set through the real durable outbox owner, rather than a new server rejection path. The driver reports that logs include independent age-label updates and preceding navigation work; those logs are not retained in the fresh packet, and whole-file render totals must not be treated as the render count for a single command. Stale working-host accessibility dumps are excluded.

Scenario seven uses the authorized same-session A/B records above; no fresh timing run is claimed. Arrival/update native-frame proxy p95 **115.3/40.3 ms meets 150 ms**. Room-list return **292.5**, members **381.3**, corners **394.8** and foreground **434.9 ms** are below 450 ms but above 150 ms. Tray **495.7 ms exceeds 450 ms**, and Room first paint remains unproven. These are proxies, not certified painted deadlines. This is the explicitly accepted measured partial improvement; remaining budget work belongs to a separate worker.

The packet records cleanup of outbox fixtures, pin and bookmark, with the created corner archived. This test-phase update only retains and assesses supplied evidence; it does not rerun device actions or change production implementation or tests.

## Regression coverage

- `ConversationRow.preview.test.tsx`: a single changed DTO among 12 freshly cloned Room DTOs renders only its row; an unrelated outbox notification renders none; a refusal in the matching Room still appears and clears.
- `room-corner-store.hooks.test.tsx`: writing an archived page does not repaint a summary consumer; replacing the summary does.
- `room-bottom-chrome.test.tsx`: subsecond timer ticks and fresh streaming Stop closures do not repaint the working line; seconds still advance; Stop uses the latest committed handler, including across a suspended transition.
- `tray.test.tsx`: replacing two DTOs but changing one does not repaint the unchanged Needs You cell.
- `MemberRosterRow.test.tsx`: cloned usage DTOs leave an unchanged identity row untouched; identity actions receive the correct pubkey and callback replacement remains observable.
- Existing Room-list gesture, pin, tray and outbox tests exercise the resulting behavior.

## Reproduction and build provenance

Follow the [phone dependency build invariant](../../../../docs/agent-mobile.md#mobile-client) before exporting a native bundle.

The first current-main profiling export could not load production Rooms because its local `@beeline/net/dist` was stale: the bundled AdmissionOwner lacked `focusOwner` and `releaseOwner` and had old route policies. After freshly compiling net and verifying the other 85 bundled api-contract/nostr/buzz-client modules against fresh compilation, current main loaded the production Room list. The earlier failure is not evidence of a current-main/server compatibility regression.

For an A/B repeat, export Android from the pinned `apps/mobile` toolchain with the same production URL and runtime, use separate Metro cache versions per fixture root, enable `EXPO_PUBLIC_LATENCY_RIG_TRACE=1`, and install only local profiling assets on the reserved emulator. Add temporary React.Profiler wrappers at RootLayout, Room list, tray, members, corners, ConversationRow, NeedsYouCell and TurnProgressLine; count committed bodies with layout effects. Keep the app on the Room list for message-arrival measurements and on the tray for bookmark measurements. Do not run this lane's builds or tests during capture. Remove the wrappers/controller before committing.

The thinking fixture mounts the real TurnProgressLine, fonts, styles and native animation. Its parent ticks nominally every 50 ms with a fresh Stop closure, while the displayed second advances normally. This isolates stream-driven rendering; it is not a measurement of a live agent's network ticks.

`provenance.json` records bundle hashes and module counts. Retained raw records contain only the profiling/latency tags and native frame data, not authentication material or app databases.

Recompute both JSON summaries from the sanitized records, from the repository root:

```sh
python3 apps/mobile/evidence/ui-surface-speed/recompute.py --output .beeline-proof/ui-surface-recheck
```

This manual evidence check is not a CI gate. It reproduces both summaries exactly. Representative before/after images are in [screenshots](screenshots), including the fresh-main load confirmation and the final restored production Room list. The original production update database was restored on emulator-5628 after capture, and the temporary controller server was stopped.

Validation: root `npm run typecheck`, mobile UI component policy and `git diff --check` pass. The eight affected route/store/component suites pass 183 tests (eight existing browser cases skipped); the final working-line suite passes 15 tests. The additional members/route batch covers 143 tests, with its two initially failing test-harness/design assertions corrected and their 15-test suites rerun successfully. All Vitest runs use at most two workers.
