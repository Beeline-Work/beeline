# CONVERSATION-1: join until first audible reply, without a settling timer

The API 36 Android release/Hermes fixture uses the production call hook, avatar
strip and voice bar with actual native WebRTC and LiveKit v1.9.12. It displays
human request text read from the real PhoneService Room projection. The database
and identities are disposable. Flux finals and provider SSE/PCM are controlled
stand-ins; no production identity, real microphone recognition or physical
speaker latency is measured.

## Reproduced

Baseline runtime `e2665c7dfc62ed9ac1de9ef4b18838dd76f9c6de`, same Android binary:

1. Join the call, then leave the partner so the Android caller is alone.
2. Gate acknowledgement speech at the provider boundary. Say “Ruby build a
   clock”, pause 1.2 seconds, “and build an alarm”, pause 1.8 seconds, then
   “and build a timer”. Each work decision completes before the next fragment.
3. The Room projection and native preview show three human rows. Three commands
   commit. See [baseline observations](baseline-android.json) and
   [baseline screenshot](baseline-joined.png).

## Demonstrated

Repeat CONVERSATION-1 against the fixed runtime and same built app. Claim the
first command before continuing speech. There is one human row:

> @ruby Ruby build a clock and build an alarm and build a timer

The command keeps its ID. Amendment atomically cancels the claimed attempt's
output authority and requeues the same command with a fresh turn request ID.
The old attempt is refused. The replacement is claimed and reports through
DaemonService; its provenance-bound report reaches the transcript and native
RTP audio. No acknowledgement bytes are produced before the controlled gate
opens. See [fixed observations](fixed-android.json) and
[fixed screenshot](fixed-joined.png).

CONVERSATION-2: tap Goosey's production avatar, wait four seconds, then make an
unnamed request. Goosey receives it and remains visibly selected, with an outline
and underlined name ([selection screenshot](fixed-selected.png)). Server tests
also cover persistence across replies and multi-human targeting; component tests
cover immediate selection across rerenders.

CONVERSATION-3: production composer volume events change the fixed blocks in the
same render, without advancing a timer. The browser proof verifies stable block
nodes and no translation in both themes; [composer evidence](../../../apps/mobile/evidence/conversation-composer/README.md)
contains the screenshots. The 120 ms sample queue and smoothing are removed.

The helper intake regression demonstrates that an amendment cancels the old
attempt and runs its replacement serially under the same command ID. Claim
receipts refresh the authoritative turn request and source if amendment wins
between snapshot and claim. Service coverage also exercises completed attempts,
idempotent amendment retries and refusal of superseded outputs. Already performed
external effects are not rolled back.

## Latency

No settling timer is added. The existing controlled finished-sentence regression
still expects 76 ms from Flux final to first accepted voiced audio, or 1076 ms
including its simulated 1000 ms Flux end-of-turn boundary, unchanged from baseline.

Five actual Android/RTC turns per runtime measured median final-to-first-server-
audio at **15.9 ms before** and **18.4 ms after**, including cold samples of
206.7 ms and 209.8 ms respectively. This small sample observed a 2.5 ms median
difference; it does not measure live provider or physical speaker latency.
All samples are retained in the observation JSON files.

## Repeat

Build `apps/mobile/scripts/voice-delivery-android-proof.tsx` as the generated,
ignored Gradle `react.entryFile`, with the local URL
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18097`. Enable loopback cleartext
and disable Expo Updates only in the generated manifest. Build x86_64 with two
Gradle/Metro workers and a 4 GiB Gradle heap. Install on a Beeline-leased API 36
1080×2400 emulator and grant microphone access. [Build provenance](build.json)
records the tested source and APK hashes.

Start local LiveKit on 17890 (RTC TCP 17891, UDP 17892–17902) with development
`devkey`/`secret`. Run:

```sh
SILENCE_PROOF_ANDROID_FIRST=1 node --import tsx scripts/prove-voice-delivery.ts
python3 scripts/prove-voice-continuation-android.py --device emulator-PORT --mode fixed
```

For baseline, materialize the pinned runtime above as temporary
`apps/server/src/.voice-delivery-baseline.ts`, run the server with
`VOICE_DELIVERY_BASELINE=1`, and use `--mode baseline`. Remove the temporary
module afterward. Each server run creates a fresh database. The driver uses the
fixture's recorded Join/avatar coordinates because continuous native audio
updates prevent UIAutomator's idle detector from settling.
