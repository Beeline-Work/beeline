# Transcript speed baseline

Local fixture only, three trials per interaction and open variant; twenty-one individual keystrokes. Android is an emulator, web is a narrow production export, and desktop is the packaged Tauri binary. None establishes physical-phone performance.

Frame intervals are pooled across trials. Android UI percentiles are the median of each trial’s HWUI histogram percentile, not pooled quantiles. HWUI jank and missed JavaScript animation opportunities are different measures. Browser animation callbacks observe main-thread/render scheduling together; separate compositor timings and physical scanout are not measured.

## Android release emulator

| Status | Evidence |
| --- | --- |
| Incomplete | No accepted capture supplied. See run notes for the exact blocker; no baseline is inferred. |

## Narrow production web

Runtime: 151.0.7922.34. Device: squire Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz. Refresh: 59.9 Hz (median requestAnimationFrame interval, headless virtual display).

Embedded build: `{"reactCompiler":false,"platform":"web","engine":null,"checkoutSha":"b3cf7eac3625d3ca69c68ba4d3043c766b73e01e","sourceDiffSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}`. Artifact SHA-256: `see export manifest`. Fixture: `cd7b92b10869393264cc3c20f1ff42f4c3c8a9ef77223697504231deeec64ae4`.

Sampling overhead, paired key-to-render upper bounds: inactive p50/p95 14.8/19.3 ms; active 25.0/32.0 ms. Alternating paired trusted keydown to second animation callback with sampler active/inactive. Measures incremental sampling cost only; layout-effect hooks are installed in both arms. Not total instrumentation overhead.

| Scenario | Trials | JS/render interval p50 / p95 ms | UI frame p50 / p95 ms | UI janky / rendered frames | Median transcript / row commits | Missed JS opportunities |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| keystroke | 21 | 16.7 / 16.7 | not separately measured | not measured | 2.0 / 4.0 | 3 |
| scroll | 3 | 16.7 / 16.7 | not separately measured | not measured | 1.0 / 2.0 | 0 |
| fling | 3 | 16.7 / 16.7 | not separately measured | not measured | 0.0 / 0.0 | 0 |
| history-prepend | 3 | 16.7 / 66.7 | not separately measured | not measured | 6.0 / 146.0 | 70 |
| incoming | 3 | 16.7 / 16.8 | not separately measured | not measured | 3.0 / 36.0 | 8 |
| concurrent-streams | 3 | 16.7 / 16.8 | not separately measured | not measured | 20.0 / 239.0 | 60 |
| optimistic-send | 3 | 16.7 / 66.6 | not separately measured | not measured | 9.0 / 97.0 | 21 |
| warm-room-switches | 3 | 16.7 / 16.8 | not separately measured | not measured | 174.0 / 2720.0 | 179 |

| Room open | Trials | First content p50 / p95 ms | Settled p50 / p95 ms |
| --- | ---: | ---: | ---: |
| cold-process-retained-storage | 3 | 1316.1 / 1325.1 | 2063.4 / 2066.5 |
| warm | 3 | 402.6 / 432.4 | 1145.9 / 1172.4 |
| cache-miss | 3 | 836.3 / 937.3 | 1560.3 / 1708.9 |

External action to observed fixture DOM plus two animation frames; upper bound includes driver round trips and 100ms readiness polling, not a physical scanout timestamp. Settled means five unchanged text/image-state polls.  new browser/app process with retained fixture storage; OS disk cache is not flushed

Keystroke-to-frame: n=21, p50=28.8 ms, p95=63.8 ms. Trusted keydown handler to the second animation callback: rendering upper bound, excluding OS input dispatch and physical scanout. Chrome Event Timing is also retained where available.

| Memory after Room switches | Before MiB | After MiB | Change MiB |
| --- | ---: | ---: | ---: |
| Trial 1, 20 switches, JS heap, no forced GC | 57.3 | 64.0 | 6.7 |
| Trial 2, 20 switches, JS heap, no forced GC | 64.0 | 122.0 | 58.0 |
| Trial 3, 20 switches, JS heap, no forced GC | 122.0 | 170.0 | 48.0 |

Blank area during fling: not instrumented; no zero-blank-area claim. Memory growth across this short experiment does not by itself prove a leak.

## Packaged Tauri desktop

Runtime: Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15. Device: squire Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz. Refresh: 60.0 Hz (Xvfb :91 1280x840; software rendering; virtual cadence).

Embedded build: `{"checkoutSha":"b3cf7eac3625d3ca69c68ba4d3043c766b73e01e","platform":"web","sourceDiffSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","engine":null,"reactCompiler":false}`. Artifact SHA-256: `9153e1675d5989bf34c91eeee4b3eb515c352f635d3d346ae31fce79235a5291`. Fixture: `cd7b92b10869393264cc3c20f1ff42f4c3c8a9ef77223697504231deeec64ae4`.

Sampling overhead, paired key-to-render upper bounds: inactive p50/p95 22.0/28.0 ms; active 21.0/35.0 ms. Alternating paired trusted keydown to second animation callback with sampler active/inactive. Measures incremental sampling cost only; layout-effect hooks are installed in both arms. Not total instrumentation overhead.

| Scenario | Trials | JS/render interval p50 / p95 ms | UI frame p50 / p95 ms | UI janky / rendered frames | Median transcript / row commits | Missed JS opportunities |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| idle | 3 | 10.0 / 16.0 | not separately measured | not measured | 0.0 / 0.0 | 0 |
| keystroke | 21 | 16.0 / 17.0 | not separately measured | not measured | 2.0 / 4.0 | 3 |
| scroll | 3 | 15.0 / 18.0 | not separately measured | not measured | 2.0 / 4.0 | 14 |
| fling | 3 | 16.0 / 18.0 | not separately measured | not measured | 0.0 / 0.0 | 3 |
| history-prepend | 3 | 16.0 / 23.0 | not separately measured | not measured | 3.0 / 65.0 | 41 |
| incoming | 3 | 11.0 / 17.0 | not separately measured | not measured | 5.0 / 40.0 | 33 |
| concurrent-streams | 3 | 16.0 / 32.0 | not separately measured | not measured | 14.0 / 221.0 | 130 |
| optimistic-send | 3 | 16.0 / 19.0 | not separately measured | not measured | 11.0 / 72.0 | 91 |
| warm-room-switches | 3 | 16.0 / 23.0 | not separately measured | not measured | 82.0 / 733.0 | 420 |

| Room open | Trials | First content p50 / p95 ms | Settled p50 / p95 ms |
| --- | ---: | ---: | ---: |
| cold-process-retained-storage | 3 | 2010.2 / 2019.9 | 2718.1 / 2738.1 |
| warm | 3 | 485.7 / 533.8 | 1152.5 / 1176.3 |
| cache-miss | 3 | 846.7 / 923.3 | 1678.9 / 1731.8 |

External action to observed fixture DOM plus two animation frames; upper bound includes driver round trips and 100ms readiness polling, not a physical scanout timestamp. Settled means five unchanged text/image-state polls.  new browser/app process with retained fixture storage; OS disk cache is not flushed

Keystroke-to-frame: n=21, p50=24.0 ms, p95=28.0 ms. Trusted keydown handler to the second animation callback: rendering upper bound, excluding OS input dispatch and physical scanout. Chrome Event Timing is also retained where available.

| Memory after Room switches | Before MiB | After MiB | Change MiB |
| --- | ---: | ---: | ---: |
| Trial 1, 20 switches, app and descendant PSS | 968.1 | 956.6 | -11.5 |
| Trial 2, 20 switches, app and descendant PSS | 956.6 | 950.8 | -5.8 |
| Trial 3, 20 switches, app and descendant PSS | 950.8 | 949.3 | -1.5 |

Blank area during fling: not instrumented; no zero-blank-area claim. Memory growth across this short experiment does not by itself prove a leak.

## Native iOS

| Status | Dependency |
| --- | --- |
| Pending | Owner approval of BrowserStack host edit (01M5QSN2JGRMWXHK8G9M0HNW48); resume the single native run after approval. |

## Ranked measured costs

The ranking uses pooled animation-interval p95 within each platform. It identifies expensive scenarios; it does not assign CPU time to individual functions. Platform hardware and rendering backends differ, so do not read this as a device comparison.

### Narrow production web

| Rank | Scenario | p95 interval ms | Missed opportunities % | Median row commits |
| --- | --- | ---: | ---: | ---: |
| 1 | history-prepend | 66.7 | 31.7 | 146.0 |
| 2 | optimistic-send | 66.6 | 18.4 | 97.0 |
| 3 | incoming | 16.8 | 6.6 | 36.0 |
| 4 | concurrent-streams | 16.8 | 8.8 | 239.0 |

### Packaged Tauri desktop

| Rank | Scenario | p95 interval ms | Missed opportunities % | Median row commits |
| --- | --- | ---: | ---: | ---: |
| 1 | concurrent-streams | 32.0 | 17.7 | 221.0 |
| 2 | history-prepend | 23.0 | 21.5 | 65.0 |
| 3 | warm-room-switches | 23.0 | 9.8 | 733.0 |
| 4 | optimistic-send | 19.0 | 18.7 | 72.0 |

## Recommended remaining work

1. **Step 2 — reduce redraw propagation.** Isolate composer state and stabilize row inputs; rerun per-keystroke and incoming-message commit counts on Android, preserving send settlement and follow behavior. Use these measured counts as the before baseline, not a promise of a particular speedup.
2. **Step 3 — reduce row work.** Profile history insertion, send settlement, and concurrent streams to attribute the measured stalls to row types. Optimize markdown/code/card work only where the profile supports it, then compare this same fixture.
3. **Step 4 — benchmark list engines.** Compare the existing list with candidates using fling, explicit history prepend, landing/follow, and memory trials. Add blank-area instrumentation before choosing a replacement.
4. **Step 5 — address remaining startup and memory cost.** Use cold/warm/cache-miss splits and repeated switches to choose the next target. Confirm memory growth with longer runs and GC-aware analysis before calling it a leak.
