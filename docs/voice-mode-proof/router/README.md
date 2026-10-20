# Voice router proof — VOICE-ROUTER-1

The October 20 real calls in brief revision 1 reproduce conversational and history questions being handed off, invented progress, and a busy agent seeing voice requests only as context. The original calls cannot be recreated safely against the production agent. The closest stand-ins are the live router replay below, actual command claim/recovery through a disposable database, and the production Android voice hook/VoiceBar with native LiveKit RTC and controlled STT/brain/PCM. No production helper, identity or credential is used by the Android fixture.

## Reproduced

VOICE-ROUTER-1: ask the router the conversational/history lines below → the reported calls unnecessarily dispatched orders; asking about Serbia also produced unsupported progress claims. Dispatch another voice request while heavy is busy → overdue command recovery could fold it into background context.

The original Android build was measured before changing startup. Its join state did not verify audio playback, and its meter depended on server speaker updates.

## Demonstrated

The final production router prompt was replayed through `openai/gpt-6-luna` five times per line with realistic history. Joke fragments follow a joke; forwarding follows a recorded Checking acknowledgement and an explicit pending request; pending-status questions include that same pending evidence. Other cases follow ordinary conversation. Searches remain available. `replay-final.json` records every history, response, status and decision; `replay.json` is the earlier prompt-development run. All 50 final decisions match the expected route. Pending replies say work is still running without claiming progress or results.

| Utterance | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
| --- | --- | --- | --- | --- | --- |
| Ah, i a c k. Your joke. | answer | answer | answer | answer | answer |
| You had to | answer | answer | answer | answer | answer |
| why did you forward this… | answer | answer | answer | answer | answer |
| Tell me about the Ottoman Empire. | answer | answer | answer | answer | answer |
| Tell me about the history of Turkey. | answer | answer | answer | answer | answer |
| tell me about the history of Serbia | answer | answer | answer | answer | answer |
| check whether the release went out | order | order | order | order | order |
| merge the PR | order | order | order | order | order |
| open a corner to fix X | order | order | order | order | order |
| Are you still working on the release check? | answer | answer | answer | answer | answer |

`voice-service.integration.test.ts` dispatches and claims a first request, dispatches two more while it is claimed, then simulates overdue recovery. Both later requests remain independent commands with explicit answer-in-this-turn instructions. The first completed command stays complete. `voice-room-runtime.test.ts` checks pending evidence delivered to the brain, shadow transcripts, routing logs and cancellation logs. `voice-providers.test.ts` checks the no-invented-progress prompt. Existing turn acceptance and interruption rules are unchanged.

## Android startup

Built release APK, Android API 36 emulator, native microphone publication and native inbound RTP energy. Values are milliseconds from the observed Join tap. The providers are controlled stand-ins: these numbers measure startup/transport, not live provider response latency. One startup per build; native RTP observations occur every 50 ms. First agent audio is PCM energy above 0.00001, excluding near-zero partner microphone noise. The baseline's original calculation counted that noise; its saved observations allow the corrected value below.

| Event | Before | After |
| --- | ---: | ---: |
| Mic published | 1965 | 1181 |
| Audio playable | 1904 | 1101 |
| First received agent audio | 2380 | 2383 |

First received agent audio is unchanged within the 50 ms sampling resolution (+3 ms). This single-run comparison cannot prove a small latency difference. Controlled end-of-turn-to-first-server-audio samples: before 26.42, 21.6, 22.25, 25.35, 28.47; after 100.88, 34.92, 55.08, 32.47, 47.73. Their medians are 25.35 and 47.73 ms; the server samples increased and should not be described as a speedup. Startup mic/audio readiness improved. Raw events and screenshots are in `baseline-startup.*` and `fixed-startup.*`.

The loading glyph remains until microphone publication and `canPlaybackAudio` are both ready; the unit test independently delays each condition. Native mic capture volume drives the waveform directly; browser capture uses an unsmoothed analyser per animation frame. Remote speaker levels no longer override it.

To repeat: start local LiveKit with the disposable development settings used by `scripts/prove-voice-delivery.ts`; run that script with `SILENCE_PROOF_ANDROID_FIRST=1`, build the APK using `apps/mobile/scripts/voice-delivery-android-proof.tsx` as the Gradle entry, launch it on a leased emulator, then run `python3 scripts/prove-voice-router-startup.py --mode fixed --device emulator-<port>`. Each run needs a fresh fixture. No release or lifecycle command is involved.

## Validation

- `npm run corner:prepare`: passed, including workspace build.
- Root `npm run typecheck`: passed, including mobile and scripts.
- Server provider/runtime/service/assembler suites: 168 passed; final prompt-only provider rerun: 32 passed.
- Mobile hook, browser waveform, keep-awake and native compatibility: 42 passed.
- VoiceBar: 9 passed.
- Android release build: passed; production hook and VoiceBar demonstrated on native RTC.
