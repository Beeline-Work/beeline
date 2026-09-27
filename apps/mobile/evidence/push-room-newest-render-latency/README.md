# Android push tap to newest Room text

**Final result:** [matched Android 36 trials and rendered frames](MATCHED-TRIALS.md) show killed median **3.433 → 3.082 s** and background median **2.099 → 1.213 s** from the [merged baseline](https://github.com/Beeline-Work/beeline/pull/1786) to this follow-up. One baseline killed tap stayed blank; all three final killed taps rendered newest text. Both APKs had OTA disabled, every reported trial passed the host load/swap gate, and the local receiver bypassed FCM delivery. The sections below retain the rejected counterfactuals and incident chronology that led to the final fix; their investigational APKs are not the final comparison.

## First Android request trace (investigational)

An in-worktree timing proxy forwarded the Android APK's requests to the same local server without recording credentials. A 100 ms read-only `/health` poll sampled app-pool counts. These three killed-app trials were under the load/swap gate; the 19,580-byte Room response took the server 14–16 ms, with no observed app-pool wait or active query at poll time. The client phase markers and proxy establish the following approximate breakdown; the Android and host wall clocks have an offset, so only same-clock differences are used.

| Cold trial | Load / 20 | Swap bytes | Secure access restore | First fetch dispatch → response | Server Room time | JSON + guard | Guard → layout | Tap → newest text |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| phase 1 | 6.00 | 1310720 / 4294963200 | 199 ms | 774 ms | 16 ms | 3 ms | 343 ms | ~3.0 s |
| phase 2 | 3.60 | 1310720 / 4294963200 | 205 ms | 703 ms | 16 ms | 2 ms | 262 ms | ~3.0 s |
| phase 3 | 4.16 | 1310720 / 4294963200 | 201 ms | 674 ms | 14 ms | 8 ms | 388 ms | ~3.2 s |

The first React Native fetch handoff/transport, rather than local server work, dominates the cold Room read. A background trace reached rendered newest text at ~1.2 s (load 1.76 / 20, same swap); its first fetch dispatch → response was 311 ms and the server Room time 25 ms. The `/healthz` warmup counterfactual used the same proxy and rendered-frame method: three killed trials were ~3.2, 2.8, and 3.0 s versus ~3.0, 3.0, and 3.2 s without it. That difference is below one sampled frame, so the extra request was removed. `/healthz` is a direct `{ok:true}` response in `apps/server/src/server.ts`, with no DB query or app-pool slot. The reported production 10/10 pool with queued reads remains a plausible *separate* production delay, not an explanation of this low-load local trace.

## Native warmup counterfactual — rejected

Two OTA-disabled APKs had byte-identical JS bundles (`9c1316054a9b15097131442ef4f0becc2bf83935768152ec6a2f960ff1e2a3fd`). The control SHA-256 was `a73287659fdba8dad3d3e510bebe9a0e8b58f7ae27105e7f7a11b6456fe34767`; the experimental APK was `d05842ab7f317aceb830b8893eaa7eb2302f16936d6e219308965ce561a07c37`. The only difference was a test-only change to the ignored generated `PushNotificationActivity.kt`: a cold push tap asynchronously requested unauthenticated `/healthz` and supplied its OkHttp client to React Native. It neither touched credentials nor delayed routing. The server handles `/healthz` before authenticated phone routing and without a database query. Logcat proved shared-client use; the Room GET took the very same socket in trials 1 and 4, while competing startup requests occupied it in the other three trials.

Each row below passed load <20 and non-full swap (all swaps 1,310,720 / 4,294,963,200 bytes). The same Android 36 emulator, 120-message Room, cleared app, killed process, real notification tap, and 5 fps rendered-frame OCR were used for each alternating pair. Frame time has ~0.2 s resolution; raw videos, frames, logcat, and the proxy timing log remain in the untracked `.task-rig` directory.

| Pair | Control load | Control frame / visible | Warmup load | Warmup frame / visible |
| --- | ---: | ---: | ---: | ---: |
| 1 | 6.52 | 23 / 3.4 s | 8.21 | 21 / 3.0 s |
| 2 | 6.56 | 22 / 3.2 s | 6.66 | 20 / 2.8 s |
| 3 | 5.60 | 22 / 3.2 s | 5.45 | 24 / 3.6 s |
| 4 | 5.17 | 23 / 3.4 s | 5.46 | 24 / 3.6 s |
| 5 | 5.87 | 21 / 3.0 s | 4.14 | 23 / 3.4 s |

Control mean/median were 3.24/3.2 s; warmup mean/median were 3.28/3.4 s. Socket reuse was technically possible but did not lower newest-visible time. The test-only native source was restored; there is no tracked native input change. Background and distant-target runs of this discarded native candidate were unnecessary. Two attempted background setups failed before the push: the local review exchange returned HTTP 429 twice. `ReviewAccess` allows ten redemptions per client per ten-minute window; the phone labels this response “invalid or expired.” `/healthz` remained healthy, and the failures occurred with the control APK, so they are a fixture rate limit rather than evidence about the native experiment.

## Remaining native option and safety boundary

An authenticated request from the native tap trampoline could overlap the ~200 ms cold SecureStore access restore and ~674–774 ms first React Native fetch interval with app startup. That is an upper-bound opportunity, not a predicted visible gain: route mount and roughly 260–390 ms of guard-to-layout work still set a floor. Expo SecureStore's Android read implementation is private to its React module; duplicating its Keystore ciphertext format would be fragile. A proposed native bridge would maintain one encrypted, expiry-bound access-token record, invalidating it *before* account switch/logout and updating it after sign-in or refresh. The trampoline would accept only the fixed Room GET path for a validated top-level Room tap and hold at most one bounded response in memory. JS would take it once only for the current response ID, Room ID, and identity, then run the existing read-model guard and exact-message landing. Expiry, 401, malformed data, or a missing bridge result would fall back to the current JS refresh/read. A newer tap, identity change, or sign-out would cancel and erase pending data; foreground routing would never await native work. The risks are a stale second credential copy, a response crossing identities, and an in-flight request after sign-out. This needs explicit lifecycle tests, a security review, the native fingerprint gate, and same-rig rendered-frame proof before it can be a fix. No credential bridge was implemented or approved.

## Method and baseline

This follows [the previous Room push trial](../push-room-last-message-latency/README.md). The baseline APK contains that change at `a9edb1e6186a455acc27d9aa4e8106ea9db09b71` (SHA-256 `ae52ab6b98a77c5beefd6a89f13dd1be480115090cba0bbd2c5e8f2fb69d4bc7`). The candidate is a clean release build of this follow-up (SHA-256 `470a7bdc7ba472a6c2ffb76ef9a6190dc341903faf9fffc59ab51ee45a4f07f8`). Both had Expo OTA updates disabled in the APK manifest.

Every trial used the same Android 36 x86_64 emulator, local server, review identity, and 120-message variable-height Room. The script uninstalled the prior APK, cleared app data, signed in, put the app behind Home, delivered a data-only push through the test Firebase receiver, and tapped the real notification. Killed trials also killed the process before the tap; Android logcat shows a new process for the notification activity. The push targeted message 120. The selected PNGs are the first sampled **rendered Room frame** whose OCR contains `NEWEST LATENCY PROBE MESSAGE 120`; notification text, route events, and view hierarchy did not count. Screen recordings were sampled at 5 fps. Approximate tap-to-visible time is `(first frame number - 1) × 0.2 s - 1.0 s` for the recording lead, with about 0.2 s resolution. Raw videos/logcat and the fixture credential were kept outside the committed evidence.

Host load and swap were recorded **before every trial**. The acceptance rule was load below 20 and swap not full; all rows below passed. Swap values are used/total bytes.

| APK | Trial | State | Load / 20 | Swap bytes | First frame | Tap → newest visible |
| --- | --- | --- | ---: | ---: | --- | ---: |
| baseline | 5 | killed | 2.88 | 1310720 / 4294963200 | [22](baseline_cold_5-newest.png) | ~3.2 s |
| baseline | 6 | killed | 5.51 | 1310720 / 4294963200 | [24](baseline_cold_6-newest.png) | ~3.6 s |
| baseline | 7 | killed | 10.38 | 1310720 / 4294963200 | [25](baseline_cold_7-newest.png) | ~3.8 s |
| candidate | 1 | killed | 17.20 | 1310720 / 4294963200 | [21](trace_cold_1-newest.png) | ~3.0 s |
| candidate | 2 | killed | 7.05 | 1310720 / 4294963200 | [22](trace_cold_2-newest.png) | ~3.2 s |
| candidate | 3 | killed | 5.37 | 1310720 / 4294963200 | [21](trace_cold_3-newest.png) | ~3.0 s |
| baseline | 3 | background | 2.60 | 1048576 / 4294963200 | [15](baseline_bg_3-newest.png) | ~1.8 s |
| baseline | 4 | background | 6.09 | 1310720 / 4294963200 | [16](baseline_bg_4-newest.png) | ~2.0 s |
| baseline | 5 | background | 6.42 | 1310720 / 4294963200 | [14](baseline_bg_5-newest.png) | ~1.6 s |
| candidate | 1 | background | 6.21 | 1310720 / 4294963200 | [15](trace_bg_1-newest.png) | ~1.8 s |
| candidate | 2 | background | 4.55 | 1310720 / 4294963200 | [13](trace_bg_2-newest.png) | ~1.4 s |
| candidate | 3 | background | 3.92 | 1310720 / 4294963200 | [13](trace_bg_3-newest.png) | ~1.4 s |

For this *experimental* build, killed median fell 3.6 → 3.0 s and background median 1.8 → 1.4 s. The router-safe build has not reproduced that cold result across a larger sample. The small sample and 0.2-second frame sampling limit precision; no production latency claim follows. The experimental build's highest-load trial (17.20) still met the stated acceptance rule. Earlier APKs and trials rejected for review sign-in or host conditions were not included.

## Where the time went

The prior change removed a duplicate pre-navigation Room lookup but left the screen's initial Room read behind its live-watch subscription. One prior background trace waited **1.100 s from Room mount to read start** while subscribing. In this build, a push starts one Room read as soon as the native tap response is available, then uses that same answer on the mounted screen. The screen paints the answer before installing the watch; its first subscribed frame forces a covering read for writes in the gap. Ordinary Room entry keeps its previous watch-first order. The push's complete top-level Room payload also claims the route before the deck's initial landing check, while older/incomplete targets retain their fallback.

The clean candidate's first killed trace shows the response present at bundle entry: prefetch began at logcat 1790486457.946, Room mounted at 1790486458.399, the Room answer applied at 1790486458.848, native layout committed at 1790486459.122, and newest-frame marker fired at 1790486459.207. The committed frame capture shows the actual text. The first Android HTTP request still varies by several hundred milliseconds and list layout remains about 0.3 s after the answer; neither route events nor the marker alone were used for the result. The local server's request pool did not show a wait during a monitored trial, so production pool saturation is a separate, unproven condition here.

A counterfactual that only raced the watch with a 150 ms timer left background at ~1.8 s and killed at ~4.2 s in two trials each. Reading first without reusing a valid cold access token also failed to improve killed time. That rejected the idea that merely removing the watch await was enough: it moved cold startup's first network round trip onto the Room GET. This follow-up restores the still-valid access token from the same encrypted SecureStore that already holds the refresh token, so the early Room read can use it without an exchange. Expired or revoked access still refreshes. No token is written to logs or this evidence.

For exact-message landing, a push to distant message 60 first showed [newest message 120](trace_distant_bg-newest.png), then [the exact target 60](trace_distant_bg-target.png) in the same recording (load 5.10 / 20, swap 1310720 / 4294963200). The measured-row retry from https://github.com/Beeline-Work/beeline/pull/1765 remains. Inline notification actions from https://github.com/Beeline-Work/beeline/pull/1764 remain on their existing path. The app never makes foreground routing wait for the prefetch or Workspace selection write.

## Verification

### Production release checkpoint (2026-09-27)

The live server `/version` returned source `93bb51ca8ad0b08ac1d3ea6681e4656cedf5168c`. Eight read-only `/health` probes at host load 2.60–2.65 / 20 and swap 1,572,864 / 4,294,963,200 bytes each returned in 145–173 ms. The reported app request pool varied from 3–10 connections, with 0–1 in use and **0 waiting** in every sample; oldest active query age was null except 6 ms and 0 ms. This verifies a quiet initial post-release checkpoint, not a push-tap result or a before/after pool comparison. At this checkpoint, the Android 36 rig's installed app and review fixture targeted the local server; the local review link could not authenticate a production test account. No production message had yet been posted.

After firstmate supplied the production review identity, the test continued in its separate `Empty screen test` Workspace (`b81a2815-924c-4bd9-bc04-d38bdee177bc`). A test-only Room `push-latency-probe-2926c2` (`39e6eb21-abc2-4025-b7a3-3ca03e3b9b55`) was created there and seeded with 120 variable-height messages, using **121 successful sequential production write requests** (one `createRoom`, 120 `sendRoomMessage`). The seed script was written at 17:37:09.709Z and started shortly afterward; its first request time was not instrumented, so an exact start timestamp is unavailable. The fixture manifest was written at **17:40:16.341Z** after the last successful response. A separate production app review sign-in, API review exchange, and workspace-list read preceded the seed; one `/health` check during it reported zero queued reads. Firstmate then reported two saturated production pools with 32/28 waiters and ordered an incident pause. The seed had already completed when that instruction arrived, but it overlapped the incident window and cannot be ruled out as a contributor. At the pause, no production notification had been triggered or timed tap recorded; no further production traffic was sent until firstmate's explicit clearance. The Room and messages remain in place for incident analysis. The earlier statement about unavailable production authorization describes the initial checkpoint only; it was superseded by this authorized scratch fixture setup.

### One cleared production cold tap (2026-09-27 19:07:58 UTC)

Firstmate cleared testing after server release `8ac20d149bcdbd3aa269f61586d8b8cc1c9108f6` recovered. On Android 36 emulator `emulator-5554`, an OTA-disabled release APK (SHA-256 `b5b27d21457b3fdd6bd30c05c9980b8563b8ebfe69972733989c595ff8148e4b`) carried the current investigational JS and enabled `EXPO_PUBLIC_ROOM_OPEN_TRACE=1`. A test-only native receiver passed one data-only `RemoteMessage` through Expo Notifications to produce a real Android notification for the scratch Room's newest message; the recorded tap was on that OS notification. This isolates Room entry against the live production server but does **not** test production FCM delivery. The app process was absent before tapping. Host load was **9.97 / 20** and swap **1,835,008 / 4,294,963,200 bytes**, so the trial passed the gate.

The first 5 fps frame with rendered `NEWEST LATENCY PROBE MESSAGE 120` was [frame 28](production-cold-newest-visible.png), about **4.4 s after tap**; [frame 27](production-cold-loading-before-newest.png) still showed `LOADING ROOM`. The video, every sampled frame, and logcat remain in `.task-rig/prod_cold_tap.*` and `.task-rig/frames_prod_cold_tap/` outside the report. Logcat's same-clock Room phase marks gave:

| Phase | Elapsed from route mount |
| --- | ---: |
| Session effect / identity ready | 8 / 38 ms |
| Occupancy yield complete | 275 ms |
| Hook begins awaiting initial Room read | 277 ms |
| Initial Room view received and applied | 1,774–1,775 ms |
| Native layout / newest-frame marker | 1,959 / 1,962 ms |

The initial Room promise wait was **1,497 ms**; its 27,093-byte answer held 30 recent messages and four members. The read had been prefetched before route mount, so the wait is **not** server query time. Fresh apply to layout cost about **185 ms**. The later live watch subscribed after newest text was visible, then made its covering read. A subsequent `/health` sample reported zero pool waiters, but it cannot establish pool state during this GET. The earlier 3.4–4.0 s killed-app trials used a *local* server and are not an apples-to-apples production before sample; no pre-release production video exists here. This one post-release frame proves that the newest text can still take 4.4 s on a production Room. It does not measure an improvement caused by the server release.

The access-token regression fails on the baseline because a new process refreshes despite a still-valid prior access token, and passes here. Focused mobile tests and typecheck passed. A clean Android release build passed after moving stale generated CMake state from the ignored native build directory. No tracked native input changed; the test receiver and OTA-disable flag live only in the ignored generated Android project, so the native fingerprint gate was not required. The access cache changes credential lifetime on device; expiry, 401 fallback, account-switch, and logout have focused tests. The final matched results are reported above.
