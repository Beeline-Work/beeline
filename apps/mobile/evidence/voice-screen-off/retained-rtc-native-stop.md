# Reproduction voice-screen-off-1: retained RTC and native Stop

Ruby's e697b0ce acceptance parked correctly but stalled for 34 seconds after addTransceiver on reply rejoin. It resumed only on unlock, timed out negotiation, produced no second playback and reopened no STT. Stop then left the newest server participant current. The hook regression against e697b0ce reproduces the extra connection: expected one connect, received two.

The fix retains the muted published microphone track and both LiveKit connections while parked, closes only server STT, and resumes the same participant/session after an authoritative committed-reply read. Microphone unmute replaces capture on the existing sender; it does not join or negotiate again. Existing resume data reaches the owning server runtime even when HTTP lands on another instance. Native Stop stores a memory-only, 24-hour, Stop-only capability fenced to the participant session. Android sends it on a native thread with bounded retries before removing the foreground service; iOS uses URLSession. Old capabilities cannot stop a successor.

## Short locked proof, squire, 2026-10-14

Private emulator-5554, API36, fresh x86_64 debug APK. Metro served the working tree based on e697b0ce before the final cross-instance park-packet/session-fencing additions; those additions have focused regressions and still require exact-head acceptance. The APK does not embed the JavaScript fix. Actual production hook, native module, RTC audio, isolated server, offline pocketsphinx/espeak; no production account or billed provider.

- Park: server parked_at=18:06:36.264Z, STT closed, frames=2941. Consecutive samples at18:06:38 and18:06:43 show unchanged frames and left_at=null. Notification reads Waiting for Ruby… · Stop. Device Asleep.
- Reply: committed report causes state HTTP200 and resume HTTP200 before unlock (guest log14:06:46.369–14:06:46.393, guest displays local time). STT opened rises1→2, parked_at clears, frames rise2941→3054→3559→4571, TTS samples72002→164026. No createOffer occurs in the reply/resume window. All corresponding power samples show Asleep. QEMU output preserves the actual playback audio (first speech at23.9–26.4s, delayed report at58.8–62.2s of the capture); long acceptance must still verify the words and audible chime.
- Idle end after playback: left_at=18:07:11.871Z, call=null, STT closed2/2, frames freeze5400. Before unlock, FGS is absent and the Conversation ended / Tap to return notification is present.
- One tap on the restart notification joins the same Room and opens STT again.

An initial attempt locked before FGS startup and was invalid: Android rejected a background microphone FGS launch. Reset and waited for active STT before the measured run above. A separate JavaScript-blocked Stop attempt recorded no native-stop request from the coordinate tap; device Stop proof was not obtained. Do not interpret that attempt as a passing Stop proof. Native HTTP and parked server-stop regressions pass independently; acceptance must tap the actual notification action and verify left_at before JS resumes.

## Validation and delivery

Root typecheck passed. Full mobile suite:535 files passed,4 skipped;4502 tests passed,5 skipped. The added reconnect/Stop-fencing and park/resume packet assertions pass in the final14-test hook run. Server suite:118 focused server/voice tests passed;39 affected voice tests rerun after resume ownership and session-fencing repair. Native module:10 tests passed, including a real HTTP Stop request without JavaScript. Android scratch Gradle build succeeded. Native fingerprint gate passes Android37/iOS35. Baby authored the initial native module contribution.

APK SHA-256:68006e819b8c5121abbdad573d1c1ffcdb4245403a5e2263544d6f85656757fc.

The writable scratch build is under this agent's session home at jellybean-native-tree/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk. The attached conversation-native-apk.zip.part1,part2,part3 concatenate to a ZIP containing app-debug.apk. Verify the APK hash after extraction. Use acceptance-runner.md with Metro and fixture from the pushed head, wait for active STT before locking, and rerun step1. Steps2–4 remain gated on step1.

Raw observations, voice logcat, power/service snapshots and QEMU audio are in the attached proof ZIP. The long10-minute/60-minute acceptance and audible chime remain unverified. iOS native build remains blocked: Expo EAS advertised ready, but its vaulted API call returned credential_not_found; no iOS build was queued.
