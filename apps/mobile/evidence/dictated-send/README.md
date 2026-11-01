# Dictated Send: OTA fixes and evidence

Send now finishes when recorded audio closes, without waiting for the recognizer's final `end` event. Whisper gets a fixed 1,800 ms finalization deadline. Existing pause uploads remain unchanged. Late native results can still improve the fallback while waiting; cancellation and late provider replies cannot commit another message. The missing-audio timeout remains a recovery path.

No native, UI, provider or model changes are included.

## Harness timing, not device timing

Reproduction DS1 uses the actual composer Send handler, speech input hook, transcription uploader, client transport and message outbox. A fake native recognizer replays recorded human audio in real time. Requests reach an isolated Beeline server, real PostgreSQL and real Groq `whisper-large-v3-turbo` through vaulted egress. Room acceptance is the server publish acknowledgment, not a rendered frame.

The baseline is main `7753811`. Both versions use the same harness and audio hashes. Each row contains five repetitions, running concurrently within each take. Main and branch batches run sequentially, so provider variation affects comparisons. Native final `end` is either absent or immediate by assumption; neither delay was measured on a device.

All table values are **harness milliseconds**, shown as median / worst. Groq time includes the vault egress hop; upload-to-text timings and individual samples are in [results.json](results.json).

| Assumed final end | Take | Main Send → Room | Branch Send → Room | Main Groq | Branch Groq | Fallback main / branch |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Missing | Short | 2145 / 2231 | 579 / 761 | 549 / 598 | 533 / 718 | 0/5 / 0/5 |
| Missing | Long, pauses | 2140 / 2237 | 913 / 1000 | 549.5 / 13736 | 547 / 927 | 0/5 / 0/5 |
| Missing | Long, continuous | 2123 / 2191 | 1629 / 1816 | 1124 / 1469 | 1494 / 1683 | 0/5 / 0/5 |
| Immediate | Short | 548 / 621 | 543 / 625 | 450 / 526 | 491 / 577 | 0/5 / 0/5 |
| Immediate | Long, pauses | 723 / 962 | 833 / 1094 | 473 / 856 | 575 / 1023 | 0/5 / 0/5 |
| Immediate | Long, continuous | 1348 / 3691 | 1278 / 1683 | 1181 / 3524 | 1152 / 1557 | 0/5 / 0/5 |

The slow main paused upload finished while speech continued, before Send. Shutdown and upload waits overlap: their timings must not be added together. Immediate-end comparisons include ordinary provider variability and do not imply every take gets faster.

The 1,800 ms bound leaves approximately 200 ms of the target for Room publication. Common measured whole-take provider round trips were roughly 1.2–1.7 seconds. An earlier 1,500 ms trial fell back on three of ten continuous takes; the final bound fell back on none of thirty sends. This sample does not guarantee a fallback rate on phones or other networks.

## Audio and accuracy

The source is [LibriSpeech test-clean](https://www.openslr.org/12/), speaker 6930, chapter 75918, utterances 0000–0003: recorded human audiobook speech, never TTS. LibriSpeech is © 2014 Vassil Panayotov, CC BY 4.0, derived from public-domain audiobooks.

The short take is 5.025 seconds. Both long cases contain the same 46.07 seconds of PCM. The paused case closes at measured silence midpoints (3.42, 17.68 and 22.64 seconds). Clip preparation asserts that concatenating all pieces preserves every PCM frame, with no loss or duplication. The continuous case closes only at stop. Source hashes and silence intervals are recorded in results.json.

Native hypotheses are explicitly scripted reference text with substitutions, **not real phone ASR**. In the earlier fallback trial, each continuous fallback lost five word distinctions across 126 words: `princess` became `prices` twice, `France` became `friends` twice, and `congratulations` became `congratulation` once, compared with the actual Whisper response. Final sends retained Whisper, so none lost accuracy through fallback. This does not establish native recognizer accuracy for names or Room terms.

The harness replaces native recognition, React Native view hosts, the recording filesystem adapter, authentication storage and outbox disk persistence. It exercises the actual composer handler with a parent binding to the real transport/outbox; it does not mount the full Room screen. Phone CPU, network, native shutdown and actual microphone behavior remain unproven.

## Regression proof

Seven DS1 regressions fail against main and pass on the branch. They cover early audio closure on Android/iOS, end-before-audio ordering with late native finals, cancellation during upload, and fixed deadlines for long recordings. The six relevant suites pass (129 tests), including speech-input, speech-transcription, speech-dictation-path, composer speech, dictation timing and outbox runtime. Root typecheck, dead-code checks and dead-code guard tests pass.

Production-visible timing logs contain stage names, elapsed time and ephemeral take IDs only; no audio, text or recording URI.

## Reproduce

Run `npm run corner:prepare -- --mobile`. Install ffmpeg and Python 3. Prepare a dedicated local PostgreSQL database, for example:

```sh
createdb --host=/var/run/postgresql beeline_latency_rig_dictation
```

Read the scripts before running them. Configure a fresh local-only `DICTATION_REVIEW_SECRET` in both server and replay environments. Supply `GROQ_API_KEY` only to the backend environment; an optional vaulted route uses `DICTATION_GROQ_BASE`. Never write secrets into evidence or key files.

```sh
bash apps/mobile/evidence/dictated-send/start-server.sh
# In another shell, with the matching local review secret:
node apps/mobile/evidence/dictated-send/run-replay.mjs
```

The server script builds dependencies and migrates the isolated database. The replay script downloads the specified human clips, prepares pause pieces, archives main's mobile sources to temporary storage, and runs all four source/end combinations. It never changes main. Default output is ignored `.local/results/replay-results.json`; default repetitions are five. `DICTATION_CLIP_DIR` selects an existing prepared clip directory. `DICTATION_ONLY=branch` repeats final branch batches.

The recorded benchmark used a dedicated database named `beeline_latency_rig_dictation_fa2e`, the same server implementation and committed egress preload. The final branch batches were repeated after increasing the cap and making production timing logs visible. Source and harness hashes identify the measured working tree in results.json; the recorded branch base predates these uncommitted-at-measurement edits.

## Real-phone check pending before merge

Niglet will arrange the owner's Galaxy A15. Record the same short, long paused and long continuous human takes before and after. Record app build, Android version and connection. Capture native logs:

```sh
adb logcat -v time ReactNativeJS:W '*:S' > dictated-send.log
```

Filter `[dictation-timing]` and compare `send_tapped` with audio closure, native end, upload start/response, Groq text and server acceptance. Stage timestamps share an ephemeral take ID; subtract their elapsed times. The upload response includes provider processing rather than measuring only transfer. Count fallbacks and compare actual native/Whisper wording, especially names and Room terms. Keep audio and text out of timing logs.

These phone results provide absolute latency. The approved replay stand-in provides relative behavior only; no device timing is claimed here.
