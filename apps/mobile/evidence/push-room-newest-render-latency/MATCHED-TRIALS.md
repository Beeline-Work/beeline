# Final matched Android 36 trials

The baseline is the merged [prior Room push change](https://github.com/Beeline-Work/beeline/pull/1786) at `a9edb1e61` (APK SHA-256 `ae52ab6b98a77c5beefd6a89f13dd1be480115090cba0bbd2c5e8f2fb69d4bc7`). The follow-up is the clean release build of this diff (APK SHA-256 `c235d81f4d26d41eda68ec8b78c0531646a20f8c2e695c0321d0c1c6e11a2132`). Both manifests set `expo.modules.updates.ENABLED=false`. The follow-up's configured local URL passed through a loopback timing proxy to the same local server used by the baseline; that extra hop did not give it a network advantage.

The rig was the same Android 36 x86_64 emulator `emulator-5554`, local server, review identity, and `Long History` Room with 120 variable-height messages. Each trial cleared app data, redeemed the local review link, selected the fixture Workspace, put the app behind Home, delivered a data-only push through the generated test receiver, and tapped the resulting Android notification. Killed trials verified the app process was absent immediately before the tap. The pushed message was newest message 120. A screenshot sampler started before the tap and OCR found the first **rendered Room frame** containing `NEWEST LATENCY PROBE MESSAGE 120`. Notification text, route events, JS frame markers, and view hierarchy did not count. Approximate time is the midpoint of that screenshot capture minus the midpoint of the tap command; capture cadence varied around 0.3 seconds. Raw frames, logcat, and trial metadata stay in the ignored `.task-rig` directory. The linked PNGs are the actual first visible frames.

Every accepted trial had host one-minute load **below 20** and swap **6,029,312 / 4,294,963,200 bytes** at its start. A review-link 429 before a push was rejected and is absent from this table.

| APK | Trial | State | Load / 20 | Swap used / total bytes | Tap → newest visible | Rendered proof |
| --- | --- | --- | ---: | ---: | ---: | --- |
| baseline | 1 | killed | 8.37 | 6029312 / 4294963200 | 4.730 s | [frame](matched_baseline_cold_1-newest.png) |
| baseline | 2 | killed | 8.12 | 6029312 / 4294963200 | no Room within 7.5 s | [blank final frame](matched_baseline_cold_2-blank.png) |
| baseline | 3 | killed | 9.51 | 6029312 / 4294963200 | 3.395 s | [frame](matched_baseline_cold_3-newest.png) |
| baseline | 4 | killed | 7.17 | 6029312 / 4294963200 | 3.433 s | [frame](matched_baseline_cold_4-newest.png) |
| follow-up | 1 | killed | 9.28 | 6029312 / 4294963200 | 3.082 s | [frame](matched_final_cold_1-newest.png) |
| follow-up | 2 | killed | 7.82 | 6029312 / 4294963200 | 3.503 s | [frame](matched_final_cold_2-newest.png) |
| follow-up | 3 | killed | 1.14 | 6029312 / 4294963200 | 2.987 s | [frame](matched_final_cold_3-newest.png) |
| baseline | 1 | background | 7.92 | 6029312 / 4294963200 | 1.832 s | [frame](matched_baseline_bg_1-newest.png) |
| baseline | 2 | background | 9.11 | 6029312 / 4294963200 | 2.192 s | [frame](matched_baseline_bg_2-newest.png) |
| baseline | 3 | background | 8.83 | 6029312 / 4294963200 | 2.099 s | [frame](matched_baseline_bg_3-newest.png) |
| follow-up | 1 | background | 9.73 | 6029312 / 4294963200 | 1.618 s | [frame](matched_final_bg_1-newest.png) |
| follow-up | 2 | background | 3.30 | 6029312 / 4294963200 | 1.212 s | [frame](matched_final_bg_2b-newest.png) |
| follow-up | 3 | background | 3.14 | 6029312 / 4294963200 | 1.213 s | [frame](matched_final_bg_3-newest.png) |

Among successful taps, killed median fell **3.433 → 3.082 s** (0.351 s, 10%) and mean **3.853 → 3.191 s** (0.662 s). Background median fell **2.099 → 1.213 s** (0.886 s, 42%) and mean **2.041 → 1.348 s** (0.693 s). The baseline also had one cold blank-screen failure, while all three follow-up cold taps rendered newest text. This is a small local sample, and the screenshot cadence makes the 0.351-second cold median improvement approximately one frame; it is a measurable result, not a production latency guarantee. The local receiver isolates navigation/rendering from FCM delivery.

## Cause and counterfactual

The push trigger was a real OS notification tap. Room mount already had a redundant pre-navigation read removed by the prior change, but the on-screen Room read could still wait behind live-watch subscription; a previous background trace measured **1.100 s from Room mount to read start**. The follow-up begins that read at the JS bundle entry for a complete top-level Room response and paints it before installing the watch. Its first subscribed frame forces a covering read for any updates between the read and watch. Ordinary Room entry remains watch-first. A counterfactual that only yielded two frames before a cache-miss read worsened cold timing (~3.79 s), and a native `/healthz` warmup produced no repeatable gain; both were removed.

Cold startup had an independent masking failure: the root layout returned `null` until font loading completed. Trace instrumentation showed Expo Router's outer navigation ref reported ready while its dispatch queue held a different, unready inner ref; Home's first `replace` was dropped, so the Room route never mounted and the screen stayed blank. A retry-only counterfactual still produced a blank trial. Mounting the navigator on the first root render, with the native splash remaining until fonts load, aligned the refs in the traced runs; a bounded Home retry and visible fallback protect a dropped dispatch. The baseline blank frame above reproduces the same symptom, and the final three cold trials all mounted the Room. This first-render fix also overlaps font loading with the Room read. The prefetch uses the valid encrypted access-token cache to avoid putting a cold refresh round trip before that Room GET; expired/401 tokens refresh, and logout/account switch invalidate the cache.

The [measured-row landing change](https://github.com/Beeline-Work/beeline/pull/1765) remains: focused routing/scroll tests and a prior same-fixture distant-target capture show newest message 120 first, then exact distant message 60. The [inline notification actions](https://github.com/Beeline-Work/beeline/pull/1764) retain their separate action path. Focused mobile tests passed (182 tests across eight files), mobile typecheck passed, and a clean offline Android release build passed after moving stale ignored CMake state aside. No tracked native input changed, so the native fingerprint gate did not apply. The read-model parser root resolution was untouched.
