# Android push to Room: newest visible text

## Fixture and method

One Android 36 x86_64 emulator, one local server, and the same 120-message Room with variable-height history were used for every build. Each trial uninstalled the prior APK, cleared app data, redeemed the same review identity, posted a data-only push through the test `FirebaseMessagingService` receiver, and tapped its actual notification. The background trials put the signed-in app behind Home; the cold trials also killed its process before the tap. The push names message 120, the newest Room message. Every accepted APK had Expo OTA updates disabled so its bundled JavaScript was the measured code. The pre-#1765 APK is commit `78f0d002f` (after #1764); current is `8b49c6e61`; the v0.0.128 APK was built from its release source; the fixed APK uses the current source plus this PR.

The first frame with the **rendered text** `NEWEST LATENCY PROBE MESSAGE 120` was found by OCR on the screen recording sampled at 5 fps and checked in the linked frame captures. Approximate tap-to-visible time subtracts the script's one-second recording lead; resolution is about 0.2 seconds. `response→navigate` comes from Android logcat. Before each trial, host load was below 20 cores and swap usage was 0.5 MiB of 4 GiB. An initial set of APKs with OTA enabled, a failed v0.0.128 HTTP-cleartext setup, and a review-link rate-limit attempt were rejected and excluded.

| Build | State | Host load | Response→navigate | Tap→newest text | Visible proof |
| --- | --- | ---: | ---: | ---: | --- |
| v0.0.128 | background | 5.62 | 0.917 s | ~1.6 s | [frame](v128-background-newest.png) |
| pre-#1765 | background | 5.00 | 1.107 s | ~1.6 s | [frame](pre1765-background-newest.png) |
| current | background, trial 1 | 3.11 | 0.810 s | ~1.4 s | [frame](current-background-newest.png) |
| fix | background, trial 1 | 4.50 | 0.252 s | ~1.8 s | [frame](fix-background-newest.png) |
| current | background, trial 2 | 4.52 | 0.510 s | ~1.8 s | [frame](current-background-newest-2.png) |
| fix | background, trial 2 | 8.75 | 0.372 s | ~2.0 s | [frame](fix-background-newest-2.png) |
| v0.0.128 | killed | 7.24 | 1.106 s | ~3.6 s | [frame](v128-cold-newest.png) |
| pre-#1765 | killed | 5.46 | 0.079 s | not visible within 6 s; landed on Room list | [frame](pre1765-cold-room-list.png) |
| current | killed, trial 1 | 3.98 | 0.892 s | ~3.4 s | [frame](current-cold-newest.png) |
| fix | killed, trial 1 | 6.06 | 0.916 s | ~3.8 s | [frame](fix-cold-newest.png) |
| current | killed, trial 2 | 6.32 | 1.031 s | ~4.0 s | [frame](current-cold-newest-2.png) |
| fix | killed, trial 2 | 6.52 | 1.029 s | ~3.8 s | [frame](fix-cold-newest-2.png) |

The pre-#1765 cold result is a routing failure, not a speed result. Its cold tap opened the Room list, so its 0.079 s navigation milestone does not represent successful Room navigation. The current and fixed builds both showed the intended Room and newest text after cold taps. These local measurements **do not show an end-to-end speedup** for the fix, or a clear newest-message regression from #1765 in this fixture: background rendering varies more after navigation than the removed preflight cost. They do show that the current route has an avoidable serial server request before the Room can begin its own read; the new stalled-read regression test captures that latency tail.

The app's Room-open trace gives the masking condition. In the first background pair, current mounted the Room after its preflight lookup and began the screen's Room read 0.143 s later; the fix mounted sooner but waited 1.100 s for its Room watch before beginning the read. The screen read itself took 0.043 s current and 0.042 s fixed, with 30 messages and 19,579 bytes projected in both. Native layout/newest-frame milestones were 0.474/0.534 s after Room mount on current and 1.388/1.445 s on fixed. In the first cold pair, route-mount→room-read was 0.125 s current and 0.293 s fixed; route-mount→newest-frame was 0.567 s and 0.856 s. This is why removing the route's wait did not translate directly to the visible result on the local server. The Room's watch, history read, and native list measurement still determine the last frame.

## Cause and counterfactual

PR #1765 added a Room-truth lookup before navigating a push. For a current top-level Room push, the payload already has the Room and Workspace IDs. The screen then fetches the same Room again, so the first lookup is serial work in front of Room entry. The lookup is still needed for a corner that may be finished and for older payloads without a Workspace. This PR bypasses it only for the fully identified top-level Room case; the Room screen still owns its read and exact `notificationMessageId` landing.

PR #1765 also added measured-row retries for distant notification anchors. A counterfactual background push to message 60 on the fixed build first showed the [newest text](fix-background-distant-newest.png), then the [exact distant target](fix-background-distant-target.png). The pre-#1765 build showed [newest text](pre1765-background-distant-newest.png) but did not visibly land on target 60 in its recording. Thus the measured-row retry is doing useful work, and removing it would not explain a delay to the newest row. PR #1764 added inline push actions but did not add this pre-navigation Room lookup.

Focused checks: 99 mobile tests passed (notification routing, push response, Room scroll follow, real-load entry); mobile typecheck passed. No native input changed, so a new native build or fingerprint update is not part of the fix. The optional fingerprint checker reports the same existing native fingerprint drift on this branch; neither changed source file is a native input. A clean fixed APK was built for the live trials.
