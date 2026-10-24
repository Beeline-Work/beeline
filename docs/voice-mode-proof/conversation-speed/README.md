# Conversation speed

This is an approved latency/speaking-speed feature, not a defect report. No release
is dispatched from this corner. Production after-release numbers remain pending.

## Production baseline

`baseline.sql` fixes the window to 2026-10-17 16:00 UTC through 2026-10-24
16:00 UTC. `baseline.json` is the read-only production result retrieved through
the owner's Neon connector. The cohort contains 106 turns with published voiced
audio. Times start at Flux EndOfTurn; they do not include phone playback.

| Stage | p50 (ms) | p90 (ms) |
| --- | ---: | ---: |
| First brain content | 961.54 | 5083.57 |
| First committed TTS request | 1584.61 | 2868.06 |
| First voiced PCM published | 1988.67 | 3348.78 |

These exact-window results supersede the approximate first-token p90 and TTS p50
in the brief. `after.sql` accepts inclusive start, exclusive end and release SHA,
and measures the same audible cohort after deployment.

## Safe overlap

The provider can emit text before a later `order` tool call. Therefore text
deltas alone never authorize playback. The runtime synthesizes one bounded plain
opening as deltas arrive, holds the PCM privately, and reuses it only when it
matches the final cleaned opening exactly. An order still commits its dispatch
before any voiced frame. Changed text, complex Markdown, an overlong opening,
changed voice, interruption and shutdown discard speculation. This overlaps
synthesis with generation without changing the router or adding a classifier
call. It does **not** play uncommitted text or remove the final routing wait.

| Change | Baseline | Deterministic local result | Production follow-up |
| --- | --- | --- | --- |
| Opening TTS overlap | TTS starts at 200 ms; sound publication at 300 ms | TTS at 40 ms; sound publication at 200 ms | `after.sql`: private prefetch and first voiced publication |
| Eager brain start | 200 ms brain work after final | 50 ms after final with 150 ms useful eager lead | `after.sql`: first content and voiced publication |
| Speech tempo | Original PCM duration; first complete frame at 110 ms | Duration / 1.15; first frame still at 110 ms | `after.sql`: first voiced publication; waveform test checks ratio |

`VOICE-SPEED-1` uses a 40 ms first sentence, 200 ms final answer, and 100 ms TTS.
`VOICE-SPEED-2/3/4` cover cancellation, no pre-final audio, dispatch gating and
changed-final-text discard. The eager helper test compares the same 200 ms brain
with/without a 150 ms speculative lead. The tempo test feeds odd byte fragments
at 100 and 110 ms; both paths publish their first complete frame at 110 ms.
The waveform test preserves a 220 Hz tone within 218–222 Hz while producing
exactly round(input samples / 1.15) output samples for three seconds of input.

## Slow tail and request count

`tail.sql` selects audible turns whose brain-request-to-first-content interval
exceeds 4900 ms. `tail.json` retains the production timing rows and correlated
Fly log excerpts. All eleven matching traces contain `search_web` or
`search_history`. For example, trace `2c143b3a-1e72-4bd2-ae90-f3db16fcc1ff`
published its lookup acknowledgement at 1961 ms but stamped first content at
5489 ms. The latter is the second model response, after routing, lookup, and
the acknowledgement playback. It is not first sound latency.

The evidence establishes a search-path tail, but old logs do not distinguish
provider latency from history size. No provider-specific cause is claimed.
New `[voice-brain-provider]` records include provider (or `not_reported`), model,
generation/request IDs, bounded history counts/characters, searched status,
first content-or-tool delta time and total request time. They omit transcript
text. `[voice-brain-trace]` associates consumed requests with the turn. All
attempts, including cancelled eager calls, emit the provider record.

Local no-search call counts: baseline one; successfully reused eager turn one;
one resumed/cancelled eager attempt followed by a final turn two. In production,
count distinct `requestId` values from `[voice-brain-provider]` for the release
window, including cancelled calls, and divide by final turns from
`voice_turn_timings` (`stage='flux_final'`). Do not count the trace copy again.
`jq -s -f calls.jq release-logs.jsonl` supplies the exact request-count aggregation
for Fly JSON log rows whose `.message` contains the log line, as in `tail.json`.
Legacy logs have no per-provider-request counter; neither the production call
increase nor after-release savings can be honestly measured before deployment.
If search remains the tail after this change, compare `searched=true/false`
request timings before considering a separate change to stream tool-free
search answers during the existing acknowledgement.

## Android measurement method

Measured first published PCM to emulator output onset:

| Run | Turns | p50 (ms) | p90 (ms) |
| --- | ---: | ---: | ---: |
| Original runtime, separate connection | 24 | 351.07 | 356.74 |
| Revised runtime, separate connection | 24 | 369.13 | 375.92 |
| Original playback, shared connection | 20 | 347.50 | 351.50 |
| Revised playback, shared connection | 20 | 348.63 | 351.14 |

The separate runs differed by about 18 ms. Alternating both playback methods
on one connection reduced the median difference to 1.13 ms, with overlapping
ranges and a slightly lower revised p90. This supports connection/buffering
variation rather than a tempo-induced frame delay; it does not establish a
phone latency improvement. The deterministic provider test separately proves
that tempo adds no input-frame lookahead to the first published frame.

No two-second playback delay was reproduced, so the phone buffer is unchanged.
Every measured turn had one publication burst and one output onset; there were
no additional onsets separated by over 500 ms of silence. This is not a claim
that a tone test detects every speech artifact or sub-frame dropout. The
sample-duration and pitch checks cover the server transform separately.

`android-summary.json` uses linearly interpolated percentiles over the retained
`android-*.jsonl` samples. Raw event files also contain setup publications/tap
sounds; the measurement driver associates only events occurring after each
trial starts. The native fixture/state captures and `android-paired.png` show
the real Android hook and transport in the controlled call. Production-after
server numbers still require release and the `after.sql` query.

Use the existing debug APK with the temporary `voice-delivery-android-proof`
entry and its production `useVoiceCall`/native LiveKit transport. The disposable
service injects SSE decisions and PCM, and uses no production identity. The
observer measures first PCM publication to onset at the emulator's PulseAudio
output monitor, not live provider end-to-end latency or a physical loudspeaker.

The installed emulator's headless executable lacks PulseAudio symbols. Use the
windowed executable hidden on Xvfb (`-qt-hide-window`, without `-no-window`),
and a dedicated PulseAudio null sink. This fixes the rig only. No phone buffer
change is justified without an observed delay in the output measurement.

Run a dedicated LiveKit instance (HTTP 18290, TCP 18291, UDP 18292), Metro on
18281 with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18297`, and the observer:

```sh
VOICE_PIN_PROOF=1 VOICE_DELIVERY_BASELINE=1 \
VOICE_PROOF_PORT=18297 VOICE_PROOF_LIVEKIT_PORT=18290 \
VOICE_PROOF_MONITOR=emberus_voice_proof.monitor \
VOICE_PROOF_EVENTS="$PWD/docs/voice-mode-proof/conversation-speed/android-baseline-events.jsonl" \
SILENCE_PROOF_ANDROID_FIRST=1 node --import tsx scripts/prove-voice-speed.ts
```

For baseline only, generate `apps/server/src/.voice-delivery-baseline.ts` from
`git show 5d3b72f3b:apps/server/src/voice-room-runtime.ts`. For after, omit
`VOICE_DELIVERY_BASELINE` and select separate result/event files. Wait for
`DELIVERY-2 ready` before launching the app, grant microphone permission and
join. `VOICE_PIN_PROOF` keeps only the disposable fixture alive during setup.
Run the measurement driver in small batches, collecting at least twenty turns:

```sh
python3 scripts/measure-voice-speed.py EVENTS.jsonl RESULTS.jsonl 8
```

The monitor runs independently of the service event loop and uses the same
Linux monotonic clock as PCM publication. The script fails on missing sound.
It also retains onset and publication-burst counts so interrupted playback
cannot silently pass as a faster result. Restore the production mobile entry
after the proof.

For a paired check, set `VOICE_COMPARE_PLAYBACK=1` on the revised fixture and
pass `--alternate` after the driver's count. This selects the original or
revised `play` method in the disposable service per request while retaining
one native connection, jitter buffer and output device. No application
playback code or production feature flag is added for this comparison.

Validation: five focused server suites pass (248 tests), including the full
runtime/provider regressions; root workspace/mobile/scripts typecheck and
workflow-path checks pass. `local-results.json` records deterministic values.
