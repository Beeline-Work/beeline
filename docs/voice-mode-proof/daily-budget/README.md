# Per-person daily call budget

Feature verification, not a defect report. The previous application had only
the provider's shared quota, with no per-person daily cap.

## Android user path

The disposable fixture uses the actual `useVoiceCall`, `VoiceCallCard`,
`VoiceBar`, native warning player, HTTP handlers, runtime, ledger and LiveKit
transport. Android API 36 runs the release APK. The budget is set to 180 seconds.
A second identity joins through a real RTC client without publishing a mic.
STT and synthesis are local doubles: STT receives actual Android PCM and emits
a confirmed unnamed utterance every eight seconds; synthesis returns flite PCM
speaking the warning. This avoids paid provider access and isolates existing
silence handling while PR #2546 remains separate.

1. Start local LiveKit v1.9.12 in development mode, mapping port 7880 to 17884,
   7881 to 17885 and UDP 7882 to 17886.
2. Generate the spoken warning with
   `ffmpeg -f lavfi -i "flite=text='You have two minutes of call time left today.'" -ar 24000 -ac 1 -f s16le .voice-proof/budget/warning.pcm`.
3. Run `node --import tsx scripts/prove-voice-budget.ts`. It creates an isolated
   database, identities and token, and serves the fixture on loopback port 38497.
4. Prebuild Android and set the generated Gradle entryFile to
   `../../scripts/voice-budget-native-proof.tsx`. Disable Expo updates and allow
   cleartext HTTP in the generated manifest for this local fixture only.
   Build `:app:assembleRelease` with x86_64, two workers, a 5 GiB Java heap and
   `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:38497`.
5. Install on the leased emulator, grant microphone permission, launch
   `app.usebeeline/.MainActivity` and tap Join. Let live input run for three
   minutes; inspect the warning, removal and subsequent denied Join.
6. Read `http://127.0.0.1:38497/__result` for the sanitized observations and
   durable budget. Stop only this fixture and its isolated LiveKit container.

The warning appeared 60.092 seconds after the Android joined observation. Its
private WAV response was ready 119 ms later. AudioFlinger showed an active
24 kHz playback track for the app. This is device playback evidence, not a
claim of a physical speaker listening test. Screenshots cover Bone and Obsidian.

The runtime forwarded exactly 180,000 ms of Android input before removal.
The ledger reached zero; Sam remained connected with all 180,000 ms remaining.
Sam received zero budget signals and zero voiced audio frames throughout.
Tapping Join again displayed “0 minutes of call time remaining today” and
“2026-10-18 00:00:00 UTC”; no new participation was created. `result.json`
contains the observations and surviving participant from this run.

## Accounting and timing checks

`voice-budget.test.ts` exercises interval union across overlapping devices,
no-input gaps, idempotent retries, UTC midnight, a failed checkpoint's pause and
resume, final-checkpoint retry, persisted database restoration, and a successor
lease rejecting the old writer. The restart/handoff and next-day cases use a
database snapshot and controlled clock; the Android fixture does not run a
production multi-server deployment or wait until midnight.

`voice-service.integration.test.ts` drives the authenticated HTTP join endpoint
at zero and verifies HTTP 429, zero remaining, reset time and the other human's
continued membership. The Android run additionally exercises the visible path.

The runtime latency probe returned first audio while an accounting write was
still unresolved: 0.540 ms before that write and 0.477 ms during it in the final
run. Providers and RTC are controlled in this probe; it verifies there is no
awaited accounting dependency on the voice response path, not external-provider
latency. Root typecheck, affected mobile tests, runtime/integration tests,
schema readiness and existing voice-preview tests pass.

There is no stored user timezone field today. Reset is explicitly UTC.
Checkpointing runs every 250 ms; the accepted abrupt-death loss bound is one
second of live input. No production release is part of this work.
