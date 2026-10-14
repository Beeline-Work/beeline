# Conversation mode with the screen locked

Verification remains incomplete. No locked-screen or 60-minute soak success is claimed.

## Reproduction voice-screen-off-1

Original locked-screen failure: **not obtained**. The isolated Android 36 AVD
was booted through `beeline emulator` on squire. The new debug APK compiled and
installed. An earlier production-hook session opened STT and ended after its
idle deadline; this did not establish audible chime or foreground-service cleanup.

Microphone injection through emulator gRPC `injectAudio` crashed two isolated
emulators: the default PulseAudio backend and an ALSA null backend. The latter
returned `UNAVAILABLE: Stream removed (recvmsg:Connection reset by peer (104))`.
Host PocketSphinx calibration recognized the synthetic phrase, but no successful
phone microphone recognition or locked-screen playback was measured. Candy is
investigating a supported input route in a separate diagnostic corner.

## Automated validation

- Root `npm run typecheck` passed.
- Client transport/hook: 17 tests passed. Covers trusted Stop, pending join
  cancellation, token renewal, one-shot idle end, parked silence without repeated
  requests, reply delivery and socket-reconnect reconciliation, and mic reopening
  after playback. Cold iOS notification routing waits for root/landing readiness,
  retains the same-Room intent across navigation and deduplicates warm link replay. Fake-clock elapsed time is not a measured soak.
- Server runtime/service: 32 tests passed. Covers spoken Stop, bounded input,
  parked lease recovery, idle end, and stale session generations.
- Android module compiled; its two native generation-gate tests passed.
- Debug Android APK built successfully. Device acceptance remains outstanding.
- iOS cloud attempt `33ae1bb2-1f5f-41b4-8e69-e526a4083c2c` failed before dependency
  installation because the source archive lacked the expected enclosing directory.
  Replacement `ecbf18ac-13de-4ded-ba85-826f12d4608d` uses an enclosing project root;
  it reached native compilation; its completion result is pending. No iOS device testing is required or claimed.

The isolated fixture uses the production hook, native module, RTC transport,
server routes and socket, with local offline speech providers and a disposable
database. It uses no production accounts or billed transcription. Start the
fixture with `npx tsx apps/mobile/evidence/voice-screen-off/server.mts`; its `/proof/metrics`
endpoint reports PCM/STT counts and bounded transcript/event evidence.

## Outstanding device acceptance

Measure a twenty-second idle chime/service end and one-tap notification restart.
For a command pending beyond twenty seconds, show the parked notification,
closed mic/STT, unchanged frame count, reply playback and mic reopening.
Lock at least ten minutes with known periodic speech, capture audible replies,
then compare the unlocked transcript. Measure a separate sixty-minute run with
periodic speech and process PSS, call identity and live-session evidence.
Exercise spoken, notification and in-app Stop. Preserve raw timings and sanitized
measurements before claiming any result.

## Release

Runtime pins: Android `37`, iOS `35`. Both platforms require new native binaries;
OTA alone cannot supply the foreground service or lock-screen controls. Baby
contributed the initial native implementation; Jellybean integrated and repaired
its lifecycle handling. OEM battery allowances require verification on the owner's
device and are not established by emulator checks.
