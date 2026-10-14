# Conversation mode with the screen locked

Verification remains incomplete. Ten-minute locked audio survival was measured;
the twenty-second idle policy fails while locked. No sixty-minute soak success
is claimed. Raw observations: [Candy's lifecycle report](candy-locked-lifecycle.md).

## Reproduction voice-screen-off-1

The original screen-lock session death was **not obtained** on this implementation.
The idle acceptance failure was reproduced: after microphone input became silent
at 05:13:30Z, frames continued and no park occurred for 89 seconds while locked.
Unlocking at 05:14:59Z immediately ran the overdue JavaScript deadline and ended
the session. A second run parked at 05:28:01.762Z but left at 05:28:01.802Z,
before the worker report committed at 05:28:03.571Z. A later device run captured
the exception: Android setActivity returned ComponentName, which Expo could not
serialize. The native callback now returns null. The restart notification now
uses a package-scoped ACTION_VIEW intent so the launcher cannot drop its Room URL.
Device confirmation of these two repairs is pending.

Candy measured screen-off survival from 2026-10-14T05:15:57Z through 05:26:34Z:
21/21 observations had the microphone foreground service, active recording and
playback, and one server participant. STT recognized 32 inputs during the run;
TTS samples increased and an AudioFlinger playback track was active. App PSS
ranged from 355888 to 361888 KB. This demonstrates the ten-minute lifecycle path,
not the full idle policy or an hour-long session.

The working input is QEMU's WAV backend, using qemu_in.wav at emulator startup.
PulseAudio/ALSA host paths and gRPC injection failed on this host. The remaining
fix moves the one-shot silence deadline into native scheduling; Candy is preparing
that native patch while Jellybean owns client integration and the park exception.

## Automated validation

- Root `npm run typecheck` passed.
- Client transport/hook: 17 tests passed. Covers trusted Stop, pending join
  cancellation, token renewal, one-shot idle end, parked silence without repeated
  requests, reply delivery and socket-reconnect reconciliation, and mic reopening
  after playback. Cold iOS notification routing waits for root/landing readiness,
  retains the same-Room intent across navigation and deduplicates warm link replay. Fake-clock elapsed time is not a measured soak.
- Server runtime/service: 37 tests passed after integrating main. Covers spoken Stop, bounded input,
  parked lease recovery, idle end, and stale session generations.
- Android module compiled; its two native generation-gate tests passed.
- Debug Android APK built successfully. Device acceptance remains outstanding.
- iOS cloud attempt `33ae1bb2-1f5f-41b4-8e69-e526a4083c2c` failed before dependency
  installation because the source archive lacked the expected enclosing directory.
  Replacement `ecbf18ac-13de-4ded-ba85-826f12d4608d` uses an enclosing project root;
  it finished successfully, including native compilation. No iOS device testing is required or claimed.

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
