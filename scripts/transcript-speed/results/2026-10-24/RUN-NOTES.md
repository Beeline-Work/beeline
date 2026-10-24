# Capture status and reproduction

This is a partial baseline, not completion of the brief. See [platform tables and measured ranking](BASELINE.md). Android remains incomplete; iOS is blocked by exhausted BrowserStack App Automate testing time.

## Retained evidence

The gzip JSON files are raw captures. `manifest.json` records their uncompressed SHA-256 hashes. Decompress into separate web and desktop suite directories, then generate the tables with:

```sh
node scripts/transcript-speed/report.mjs - web desktop BASELINE.md
```

A dash explicitly marks a missing platform; it never creates measurements. Replace it with the Android suite directory when that run completes.

Web used a narrow production export (390 × 844). Desktop used the extracted Debian package, driven through tauri-driver and WebKitWebDriver under Xvfb, not a browser tab. Both embed build SHA `b3cf7eac3625d3ca69c68ba4d3043c766b73e01e`. Subsequent commits changed drivers and reporting; the embedded SHA is the artifact identity, not the final PR head. Generated metadata records React Compiler disabled. Hermes and native Fabric are not applicable to these web runtimes; Android runtime verification remains pending.

Runs were serial, with this corner’s Android compiler suspended and no Android emulator running. Other workloads on the shared host cannot be excluded. Desktop startup host load was 12.07 / 15.21 / 13.59 across 20 logical CPUs. These are controlled local diagnostic baselines, not a guarantee of an otherwise idle host. The local proxy used 100 ms RTT, zero jitter and 10 Mbps bandwidth; images deliberately arrive late.

Each interaction has three trials; typing has twenty-one keys. Open variants each have three trials. History drivers verify older fixture content, streams use two agents, and send settlement checks local server state. Browser paint times are rendering upper bounds, not physical scanout. Separate UI/compositor frames, blank-area measurements and total hook instrumentation overhead remain unavailable; the paired comparison measures incremental sampler overhead only. Memory growth without forced GC does not establish a leak.

## Android blocker

The local release build was interrupted across agent sandbox resets. The persistent build log ends during native dependency compilation without a Gradle completion or failure result. On resumption no Gradle/build process remained, and the artifact check returned:

```text
ls: cannot access 'apps/mobile/android/app/build/outputs/apk/release': No such file or directory
```

Local exec and the connected development shell were tried; both ran inside the same ephemeral execution sandbox. The grant listing offered connection-install grants, not a persistent host-command route. Moving build caches and captures from `/tmp` into the ignored worktree run directory preserved the completed web/desktop evidence, but did not preserve the running Android build. Earlier native diagnostic observations without retained raw captures are excluded. The Android drivers are implemented but the full native suite is not demonstrated.

Next step: resume the cached release assembly in an uninterrupted execution window, install the resulting APK on the corner emulator, then run `capture-suite.mjs android` and regenerate these tables. Do not mark the PR ready until that succeeds.

## Native fingerprint

Local fingerprint validation failed on both this branch and clean main (`735d7a8a5`), using the same installed dependency set. The two retained `fingerprint-*.txt` files contain exact outputs. Computed hashes differ between checkout paths; this demonstrates the local failure also occurs on main, not identical computed fingerprints. No runtime pins or release configuration were changed. The original PR head passed its hosted native fingerprint check.

## iOS

The owner approved the host change; vault metadata confirms `hub-cloud.browserstack.com` is allowed. The expired approval was not resumed.

The native IPA upload on 2026-10-24 returned HTTP 403:

```text
[BROWSERSTACK_TESTING_TIME_LIMIT_EXHAUSTED]App Automate testing time has expired. Contact BrowserStack Support at https://www.browserstack.com/contact for extending your Free Trial.
```

Vault authentication and Expo EAS build discovery succeeded. BrowserStack recent apps returned no results; its plan endpoint reported Free. A hub session availability request returned `POST /v1/vault/use → 504 timeout`. Uploading an existing EAS IPA then established the expired testing-time blocker. No native timing was captured. Restore testing time on the approved account, then capture the fixture run; an existing IPA's availability does not establish that it contains this harness.

## Remaining driver changes

The Android driver retries accessibility snapshots, recognizes prefixed jump-to-newest labels, waits for newest content before incoming-message sampling, and retains screenshots/OCR to verify both streams outside timing windows. These changes still require the full native demonstration; no emulator was attached during the delivery check.
