# DELIVERY-2: commit before acknowledgement

A failed TTS acknowledgement previously left an addressed request with no ordinary
agent command. The baseline Android call reproduces that loss. The same path now
commits one command before synthesis and receives the agent's eventual report.

The proof uses a locally built Android release/Hermes fixture, API 36 native
WebRTC, LiveKit v1.9.12, and an isolated PGlite server. Alex joins on Android;
Sam uses a second RTC client. Ruby and Goosey are disposable agent identities.
The fixture renders the production call hook, call card, avatar strip and voice
bar. Native RTP packet counts and decoded audio energy prove report reception.

STT final transcripts and provider SSE/PCM responses are controlled stand-ins.
A gate holds the external-work decision so Sam can interrupt before acknowledgement;
one synthesis request fails deliberately. No live provider service or physical
phone speaker is measured. Real agent execution is represented by claiming the
ordinary routed command and posting its report through `DaemonService`, preserving
command provenance. No production identity, helper or database is used.

## Demonstrated

- Say “Ruby”, pause two seconds, then request external work. Sam interrupts before
  the final decision. Ruby receives exactly one command; no “Checking” is needed.
- Repeat with synthesis forced to fail. Delivery still commits once, the Android
  error says the request was delivered, and the report arrives as native audio.
- Tap Goosey's production avatar, then make the unnamed request. Only Goosey
  receives the command, and its report arrives.
- Wait beyond three seconds after a name-only segment. The unnamed request asks
  for an agent again and creates no command.
- Name Ruby, then explicitly name Goosey in the work request. Only Goosey gets it.

The database retains four commands for the four addressed work requests and no
command for the expired draft. Both humans retain the same durable call and the
server PID stays unchanged. [Baseline observations](baseline.json) and
[passing observations](fixed.json) contain the command IDs, transcript, synthesis
and commit timestamps, native media statistics and latency samples.

Automated regressions additionally prove per-human continuation renewal,
replacement names, explicit cancellation, departure cleanup, retrying the same
source after a failed commit, deduplication after an uncertain insert/dispatch,
and refusal to revise an already dispatched order.

## Latency

Five normal turns in each real Android/RTC call measured median end-of-turn to
first server audio at 22.4 ms before and 20.7 ms after. The samples include the
first cold turn. This controlled-provider comparison adds no settling timer and
shows no observed normal-path regression; it does not measure live provider or
physical speaker latency. Full samples are in the observation files.

## Repeat

Build `apps/mobile/scripts/voice-delivery-android-proof.tsx` as the generated,
ignored Gradle `react.entryFile`. Set
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18097`, enable loopback cleartext and
disable Expo Updates in the generated manifest. Build x86_64 with two Gradle and
Metro workers and a 4 GiB Gradle heap. Install on a Beeline-leased API 36 emulator
and grant microphone access. This changes no shipped mobile configuration.

Start a dedicated local LiveKit server on 17890, with RTC TCP 17891 and UDP
17892–17902, using development-only `devkey`/`secret`. Run:

```sh
SILENCE_PROOF_ANDROID_FIRST=1 node --import tsx scripts/prove-voice-delivery.ts
python3 scripts/prove-voice-delivery.py --device emulator-PORT --mode fixed
```

The driver uses the actual Join control and Goosey's avatar at the fixed
1080×2400 fixture layout. The control server binds only to loopback.

For the before run, materialize `apps/server/src/voice-room-runtime.ts` from
`1afe5e6ff` as temporary `apps/server/src/.voice-delivery-baseline.ts`. Run the
same server with `VOICE_DELIVERY_BASELINE=1` and the driver with `--mode baseline`.
Remove that temporary module afterward. Each run creates a disposable database.
[Build provenance](build.json) records the APK and tested sources.
