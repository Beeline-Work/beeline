# Capture status and reproduction

Android release, narrow production web and packaged Tauri baselines are captured. See [platform tables and measured ranking](BASELINE.md). iOS skipped by owner decision; Android is the reference.

## Retained evidence and repeat command

The gzip JSON files are raw captures. `manifest.json` records their uncompressed SHA-256 hashes; screenshot entries use file SHA-256. Decompress each platform into its own suite directory, then regenerate with:

```sh
node scripts/transcript-speed/report.mjs android web desktop BASELINE.md
```

Each interaction has three trials; typing has twenty-one keys. Open variants each have three trials. History drivers verify older fixture content, streams use two agents, and send settlement checks local server state. The same deterministic local-only fixture is used across platforms, with 100 ms configured RTT, zero jitter, 10 Mbps bandwidth and delayed placeholder images.

## Android host capture

The persistent host build and capture completed with `EXIT 0`. The Node 18 host default first failed Metro with `configs.toReversed is not a function`; Node 22.12.0 then failed this checkout's Expo config with `ReferenceError: require is not defined`. Explicit Node 20.11.0 built the release APK successfully. The README documents the host systemd route that survives sandbox resets.

The built APK embeds SHA `827dbc0018c2eede4f3729bf510147a021757b14` and a clean measured-source digest. Its SHA-256 is recorded in the table and checked against the installed APK before each driver. Device: corner-owned emulator-5562, Android 15 x86_64, 60 Hz, software GPU. Host identity, CPU, kernel and load are retained in `android/host.json.gz`. This is an emulator diagnostic baseline, not a physical-device claim. The build finished before capture; unrelated shared-host load cannot be excluded.

Generated Gradle settings enable Hermes and New Architecture (`android/generated-build-settings.txt`). Runtime samples independently confirm Hermes and Fabric. Embedded Metro metadata records React Compiler disabled. Retained screenshots show both live streams outside sampling windows; OCR text accompanies each screenshot. Incoming messages were visibly checked, history gestures revealed older fixture rows, and optimistic sends settled in the local database.

All twenty-one native keypaint samples in each sampler arm completed without timeouts. Active sampler p50/p95 is 51/69 ms, inactive 51/54 ms. These sequential samples measure incremental sampling cost with hooks installed in both arms; total instrumentation overhead remains unquantified. HWUI histograms estimate UI frame cost; JavaScript rAF intervals measure scheduling opportunities. Neither establishes physical panel scanout. Room opens use the existing newest-frame marker; settling includes five quiet frame-count polls. Cache-miss trials clear fixture app storage, sign in, then time entry to the target Room, so they exclude sign-in time.

Android's largest pooled JS frame-interval p95 occurs during repeated Room switching (154.4 ms), then optimistic send (41.3 ms) and concurrent streams (37.7 ms). History insertion has median UI p95 of 38 ms and median 364 row commits per trial. Typing has median two row commits per key, not zero; initial keys in the first trial had zero. Incoming messages have median 42 row commits. Use these measurements to focus follow-up profiling; they do not attribute CPU time to individual functions.

## Web and desktop

Web used a narrow production export (390 × 844). Desktop used the extracted Debian package, driven through tauri-driver and WebKitWebDriver under Xvfb, not a browser tab. Both embed SHA `b3cf7eac3625d3ca69c68ba4d3043c766b73e01e`. Subsequent commits changed drivers/reporting; artifact identity is distinct from final PR head. Generated metadata records React Compiler disabled. Hermes and native Fabric do not apply to these web runtimes.

These captures ran serially with this corner's Android compiler suspended and no Android emulator running. Other shared-host workloads cannot be excluded. Desktop startup load was 12.07 / 15.21 / 13.59 across twenty logical CPUs. Browser paint times are rendering upper bounds; separate UI/compositor frames remain unavailable. Paired sampling comparisons measure incremental sampler overhead only.

## Limitations and native fingerprint

Blank-area measurements and total hook instrumentation overhead remain unavailable. Short memory growth without forced GC does not establish a leak. The README and tables state metric-specific limitations; missing evidence is never reported as zero.

Local fingerprint validation previously failed on both this branch and clean main (`735d7a8a5`) using the same installed dependencies. Retained `fingerprint-*.txt` files contain exact outputs. Checkout-dependent hashes differ; this demonstrates the local failure also occurs on main, not identical hashes. No runtime pins or release configuration were changed. The original PR head passed hosted native fingerprint checks.

## Native iOS

iOS skipped by owner decision; Android is the reference.
