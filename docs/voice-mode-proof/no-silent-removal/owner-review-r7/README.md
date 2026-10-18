# Revision 7 owner review

Seven full-phone, unedited Android captures from the normal Experiments Room. The app uses its real Room screen, server-indexed reads, transcript, existing System lines and composer. Bone is selected. These replace revision 6's four captures for owner review; the owner hold remains.

| State | Capture | Artifact |
| --- | --- | --- |
| Agent speaking, brass square outline and waveform | [01-speaking.png](01-speaking.png) | 3594aa3f-ddfe-496b-b745-f935be2d1cc4 |
| Muted, slashed mic and flat waveform | [02-muted.png](02-muted.png) | 8d5875fb-00e6-419a-8c7b-c3b50784fba3 |
| Exactly Ending in 10s | [03-countdown.png](03-countdown.png) | a1c21cb7-a4c9-45b4-8183-ee4f19fcb2ce |
| Ended by quiet, existing System line and normal composer | [04-ended-quiet.png](04-ended-quiet.png) | 089f0327-d4d9-4967-b7ef-c71567022a03 |
| Ended by last stop, duration with no cause | [05-ended-last-stop.png](05-ended-last-stop.png) | 1a189a3b-9e4a-41b2-b3f9-1565d7ef0dd1 |
| You left, Sam remains, Join offered | [06-left-others-stay.png](06-left-others-stay.png) | 35b90f03-3ad2-4efa-a76d-3ee0a77ad3f7 |
| Room list during a running call | [07-room-list.png](07-room-list.png) | 7aae54ac-294e-41ff-82ba-095c9cc2b59a |

Ruby reviews these against the approved mock before the owner decides. The workspace daily-limit frames belong to the separate workspace-call-limit corner.

## Demonstrated

Reproduction **multi-human-silence-1** retains the original Android removal/misrouting reproduction and fixed multi-human routing, reconnect, outside-work and pending-work evidence in the parent directory. Revision 7 adds the approved UI; the UI itself is not a defect report.

The real Room used Alex on Android, Sam on Node RTC, and Ruby. Joining displayed You and Sam, without agents in the call roster. A named utterance produced actual RTC audio from the deterministic tone speech provider and highlighted Ruby's square avatar. Tapping the existing mic slot muted the local RTC microphone and flattened the waveform. Stop restored the normal composer while Sam remained; the header offered Join. Joining again restored the in-call controls. The deck displayed Call · Sam and elapsed time in the usual timestamp slot.

Call-initiated work held the group call for more than 115 seconds. Completing it began a fresh quiet window. [quiet-proof.json](quiet-proof.json) records the server warning and termination observed **61.119 seconds** after completing that work. Both participants ended together; the existing System line reads Voice call ended · 2:56 · No one spoke for 60s. The header disappeared and the normal composer returned.

Starting from the normal composer's conversation icon created a different solo call. Its native countdown was captured at exactly 10 seconds remaining. Pressing stop at 54 seconds ended that call; the existing System line reads Voice call ended · 0:54, with no silence cause. [room-after-last-stop.json](room-after-last-stop.json) preserves both ended calls. [countdown-last-stop.json](countdown-last-stop.json) records screenshot timestamps and OCR; only the selected full-size capture is retained from the sampled frames.

[icon-overlay-check.json](icon-overlay-check.json) compares dark glyph pixels in the same screen rectangles. Speaking, countdown, quiet-ended, last-stop-ended and left-call mic bounds are identical: x 875–906, y 2237–2281. The muted slash widens the drawing symmetrically to x 871–910 without moving its center or vertical bounds. The filled stop bounds stay x 960–1002, y 2238–2280 in speaking, muted and countdown states. The restored conversation icon has the same center, (981, 2259). Browser layout assertions additionally compare the exact control rectangles across group, mute and warning transitions in both themes.

## Repeat the Android path

Use the existing runtime-39 Android debug binary with Metro serving the current JavaScript. No native code changed in revision 7. The binary's embedded build label still names d0d124989; the screenshots use the revision-7 source through Metro.

1. Start local LiveKit v1.9.12 on ports 17890, 17891 and 17900–17920, using the disposable devkey/secret pair. Advertise an address reachable by Node and Android; this run used 172.17.0.1. The emulator reaches the HTTP/websocket endpoint through 10.0.2.2.
2. Run `SILENCE_PROOF_ANDROID_FIRST=1 SILENCE_PROOF_HOLD=1 npx tsx scripts/serve-voice-room-review.ts`. The local adapter runs real PhoneService, VoiceService and VoiceRoomRuntime against disposable PGlite on localhost:18097, with deterministic STT/brain/tone-TTS substitutes. No production account, Room or provider is used.
3. Start Metro from apps/mobile on port 18098 with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18097`. Temporarily load a local-auth boot module before expo-router/entry: identityId returns the seeded a-repeated-64 identity, authorization returns a dummy token without a Bearer prefix, and monolithSession.fetch forwards native fetch. No screen or component is substituted. Restore the entry and remove that module afterward.
4. Open Experiments in the normal deck. Join from the header; use the mic for mute and the right control for stop. POST `/say` with `{"text":"Ruby, ready?","speechMs":12000}` to keep the deterministic RTC speech visible long enough to capture. Its default remains 100 ms.
5. POST `/work-finish`; capture the warning and allow the server's whole-call quiet end. Start another call with the normal conversation icon, capture its countdown, then press stop. Scroll to the newest System line for the last-stop capture.

## First audio and checks

[Matched first-audio samples](first-audio.json) compare the prior head d0d124989 against revision 7 on the same local RTC/PGlite/deterministic provider rig, with Android stopped and its emulator idle. After one warm-up, five samples each give medians **18.024 ms before / 16.150 ms after**. The samples overlap; this is not a speedup claim. It measures voiced audio accepted by RTC, not live-provider latency or physical speaker output. No awaited stage or buffer was added to the turn path. The new short warning tone runs only in the quiet checker and does not reset its deadline.

Validation: 145 focused mobile/design/browser checks; all 81 prior runtime cases plus the new warning-tone regression (82 runtime cases covered across runs); 18 service integration cases; 17 System-lock cases; root typecheck; UI component policy; workflow paths; and zero introduced dead-code findings. The tone regression also covers call work completing between quiet checks, so each renewed quiet window gets its own tone. The one System-lock entry change is the existing producer's silence consequence expressly approved in revision 7.

## Proof environment observations

The local LiveKit rig logged a lossy data-channel closure on join; reliable call signals, RTC audio and the demonstrated lifecycle continued to work. Feedback item fb_e8266240c4f764468538a703 records it. A later cold reopen of the development client, outside an active call, crashed once in React Native MountingCoordinator. Reopening through the development launcher succeeded and produced the final last-stop capture. The [native trace](cold-reopen-crash.txt) is retained; feedback item fb_9e56004257a02cbd953df5f8 records it. These observations are left visible for review; their causes have not been established.

## Main integration after revision 7

Integrated main at `17e5b7ade` without changing the captured call layout. Main's voice budget warning/audio support remains connected; its warning uses the waveform slot and the silence countdown wins. Main's spoken-name/ID formatting and iPhone App Store update dialog remain intact. The separate workspace-call-limit corner still owns replacing the per-person budget.

Validated all 85 runtime cases across runs (the two updated speech-formatting fixtures passed on rerun), 19 service integration cases, 28 speech-formatting cases, 7 budget cases, 74 System-lock cases, and 68 mobile cases. The same service-path reproductions cover shared quiet termination, call-work holds, outside wakes, silent listeners and reconnects. The new main integration case exercises exhausted join through authenticated HTTP while the peer stays. The controlled accounting-checkpoint timing case reports 0.255 ms before / 0.361 ms after while the checkpoint stays unresolved; this measures doubles, not provider or physical-speaker latency. Root build and typecheck, UI policy and workflow paths pass. The System lock now tracks the already-approved `silence` discriminator through the existing leave wrapper under main's updated scanner; no additional System wording was introduced.
