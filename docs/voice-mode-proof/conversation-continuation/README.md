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

Repeat CONVERSATION-1 against the revision 4 runtime and the same built app.
The brain completes three decisions, one for each joined version. Each new
fragment aborts the superseded synthesis. Before the controlled speech gate opens,
there is one human row and **no command**:

> @ruby Ruby build a clock and build an alarm and build a timer

Opening the gate prepares the first voiced frame. Assembly closes, exactly one
command commits, and only then does that frame publish. The command is claimed
and reports through DaemonService; its provenance-bound report reaches the
transcript and native RTP audio. Nothing amends, cancels or replaces a committed
command. See [fixed observations](fixed-android.json) and
[fixed screenshot](fixed-joined.png).

The Android binary predates the revision 4 mobile mock gate. It is used here to
exercise the server and transport. These screenshots do not constitute human
approval of mobile UI changes; the PR remains draft pending that approval.

CONVERSATION-2: tap Goosey's production avatar, wait four seconds, then make an
unnamed request. Goosey receives it and remains visibly selected, with an outline
and underlined name ([selection screenshot](fixed-selected.png)). Server tests
also cover persistence across replies and multi-human targeting; component tests
cover immediate selection across rerenders.

CONVERSATION-3: the fixed-block proposal and the waveform in this older Android
binary were superseded by brief revision 5. The existing scrolling appearance is
retained. The refreshed [composer browser proof](../../../apps/mobile/evidence/conversation-composer/README.md)
demonstrates a live newest bar responding immediately to volume events, with no
wait for history sampling or offscreen entry. The Android observations here
remain proof of server request joining and transport, not the new waveform.

Server regressions cover both direct answers and work decisions completing
between fragments, same-human partial speech, independent replies to another
human, dispatch before failed/empty acknowledgement, stable-source retries, and
refusal to edit an already committed order. A continuation during the dispatch
round trip starts a new source; it cannot alter the accepted command.

## Latency

No settling timer is added. The existing controlled finished-sentence regression
still expects 76 ms from Flux final to first accepted voiced audio, or 1076 ms
including its simulated 1000 ms Flux end-of-turn boundary, unchanged from baseline.

Five actual Android/RTC turns per runtime retain their samples in the observation
JSON. These controlled-provider timings do not measure live provider or physical
speaker latency. The fixed samples are refreshed for revision 4; the baseline
median is 15.9 ms; the revision 4 median is 21.6 ms. This small
CPU-sensitive sample differs by 5.7 ms; the deterministic finished-turn
regression remains unchanged at 76 ms. No fixed wait is introduced.

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
