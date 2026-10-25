# Caller resume: VOICE-CUTIN-1

The runtime publishes speech earlier after PR 2912, exposing an existing final-turn
fence and closing request assembly sooner. In the controlled replay, a new-index
StartOfTurn cancels audio, but its continuation becomes a new request after sound
starts. A same-index TurnResumed is rejected by the consumed-turn fence, leaving
audio playing. The patch accepts a recognized resume for an active reply, clears
queued audio, and retains its conversational request for continuation.

Speech tempo, eager generation, synthesis overlap, eot_threshold and eot_timeout_ms
are unchanged. The first voiced publication remains 150 ms after the final in
both current-main and fixed replay. There is no grace timer or delayed first frame.
Audio can still start before a future resume; the repair stops it when that resume
is recognized. This does not claim that acoustic overlap never occurs.

## Reproduced and demonstrated

The real production transcript supplies the split sentence: “you have a way of
sending” / “a message to…”. Complete recorded Flux events were not retained.
The replay therefore reconstructs event sequences rather than claiming to replay
an actual recording. Providers and RTC are controlled; STT events enter through
the runtime's microphone callback, rather than calling an inner cancellation method.

`voice-cutin.test.ts` sends EagerEndOfTurn 600 ms before EndOfTurn, followed by
StartOfTurn (new index) or TurnResumed (same index). Brain duration is 700 ms;
synthesis starts producing frames after 50 ms. Speech is fed in paced 20 ms
chunks. The observation window extends until the original reply has finished.
The same-index variant also tests a cumulative final without duplicating the prefix.

Exact runtime sources: pre-2912 `5d3b72f3b`; current main `2f9d30007`.
Historical runtime files are temporary, unmodified `git show` outputs beside the
runtime, using the same harness. The request assembler is unchanged between those
historical versions. Raw results are the adjacent JSONL files.

Each cell is **voiced before resume / last publication after resume (ms) / joined request**.

| Resume (ms) | Pre: StartOfTurn | Main: StartOfTurn | Pre: TurnResumed | Main: TurnResumed | Fixed: either event |
| --- | --- | --- | --- | --- | --- |
| 200 | no / 0 / yes | yes / 0 / no | no / 3530 / no | yes / 2950 / no | yes / 0 / yes |
| 400 | no / 0 / yes | yes / 0 / no | no / 3330 / no | yes / 2750 / no | yes / 0 / yes |
| 600 | no / 0 / yes | yes / 0 / no | no / 3130 / no | yes / 2550 / no | yes / 0 / yes |
| 800 | yes / 0 / no | yes / 0 / no | yes / 2930 / no | yes / 2350 / no | yes / 0 / yes |
| 1200 | yes / 0 / no | yes / 0 / no | yes / 2530 / no | yes / 1950 / no | yes / 0 / yes |

For ignored pre-release resumes that precede sound, the later publication is still
counted as publication after resume. Pre-release first sound, when not cancelled,
is 750 ms. Fixed queue clearing occurs at the resume timestamp in the controlled
matrix. All fifteen fixed cases retain one source and revise it once. Assertions
failed on unpatched main and pass on the patched runtime.

This proves cleanup and assembly behavior for the supplied sequences. It cannot
establish whether eager mode changes Flux's own boundary emission. No revert is made.

## Request boundaries

An audible conversational reply stays in `playing` state. A recognized interruption
pauses it back into assembly; a subsequent final revises the same source. A separate
final without a detected resume still starts a new request. Completion releases
the request immediately. Committed orders still close assembly before dispatch;
resumes cannot resend accepted work. Multi-human backchannels retain the existing
live-membership and interruption rules. A delayed membership read cannot cancel
a newer request that arrived while it was pending.

## Production measurement

`[voice-playback-resume]` identifies the call, reply trace, caller, event/index and
milliseconds since first voiced publication. It observes recognized non-echo speech
from that same caller during active audio, including an otherwise stale resume.
`replyKind=turn` correlates with voice_turn_timings; reports use `replyKind=report`
and their message ID. Count distinct turn traces whose sinceFirstVoicedMs is at
most 2000, divided by distinct audible turn traces in the same release window.

`[voice-playback-stopped]` correlates by call/trace/caller and records publicationTailMs,
queueClearMs and cleanupMs. These measure server publication and cancellation,
not playback of already-transmitted packets on the phone. No transcript or PCM
is added to these logs, and telemetry adds no timers, database work or awaited I/O.

The earlier production comparison found audible replies (41 before / 52 after)
and first voiced publication p50/p90 (2007/3503 ms before; 1105/1649 ms after).
Only four timed calls existed on either side, with different conversation topics.
Historical cut-in shares, split acoustic turns and EndOfTurn per caller-speech
minute remain unavailable; the telemetry does not reconstruct missing history.

## Android evidence and limitation

The disposable `prove-voice-delivery.ts` service runs the actual VoiceService and
runtime with injected providers, a local LiveKit server, and a built Android debug
app using the production useVoiceCall/native RTC path. `/cutin` drives the same
split sentence through the Android participant's STT callback. The fixed phone read
contains one joined source. Native inbound audio energy confirms decoded audio.
Server queue/publication timings are retained in the adjacent Android summary.
The latest controlled Android resume cleared the server queue after 0.679 ms;
its last in-flight publication completed after 12.391 ms, within one 20 ms frame.

**Acoustic output onset is not proven.** The headless emulator exposes no PulseAudio
playback stream. A graphical kept-emulator restart exited before boot; the launcher
does not forward DISPLAY/PulseAudio settings. A no-Qt PulseAudio attempt also exposed
no playback stream. Android AudioFlinger tee produced no capture, and screenrecord
supports video only. Native receive energy is not substituted for output onset.
The connected BrowserStack API was also tried: its plan lookup succeeded, but
creating an Android session with audio/video capture was refused because App
Automate testing time has expired. No remote test session was created.
The remaining proof needs an audio-capable Android emulator/host launch, then the
existing `prove-voice-speed.ts` monitor to capture onset and post-resume output.

## Repeating

```sh
git show 5d3b72f3b:apps/server/src/voice-room-runtime.ts > apps/server/src/.voice-cutin-baseline.ts
VOICE_CUTIN_RUNTIME=./.voice-cutin-baseline.ts VOICE_CUTIN_MEASURE_ONLY=1 \
  VOICE_CUTIN_LABEL=pre-2912 npm test --workspace=@beeline/server -- src/voice-cutin.test.ts
npm test --workspace=@beeline/server -- src/voice-cutin.test.ts
```

Remove the temporary historical source afterward. `VOICE_CUTIN_RESULTS` optionally
writes JSONL (relative to apps/server); measurement-only mode disables fixed-runtime
assertions solely for collecting historical comparisons.

For Android use the disposable entry `scripts/voice-delivery-android-proof.tsx`,
Metro with EXPO_PUBLIC_BUZZY_MONOLITH_URL pointing to the proof HTTP service,
and a local LiveKit server. After joining, POST `/cutin` with
`{"resumeMs":800,"kind":"TurnResumed"}`. Restore the normal mobile entry after
the proof; no mobile implementation change is part of this patch.

Validation: six focused voice suites passed (281 tests). The subsequent targeted
resume run passed (16 tests), including the new membership-read race and telemetry
assertions. Root workspace/mobile/scripts typecheck and workflow-path checks pass.
