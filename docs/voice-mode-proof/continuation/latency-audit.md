# Finished-sentence latency audit

Compared baseline `cfcc47ecd` with measured PR head `82d44eec`. Line numbers below refer to those immutable revisions, before main integration and timing instrumentation. No new provider runs were performed for this audit.

## Finding

No code cause for the slow PR runs is established. There is no added merge hold window, sleep, duplicate-final wait or automatic retry on the no-continuation path. The live first-reply latency gate remains failed. PR runs 1 and 3 took 3,666 and 4,291 ms from Flux final to first voiced server audio; the other four took 1,384–1,690 ms. Source inspection cannot attribute that difference to a provider or to code without stage observations.

## Await and scheduling inventory

`R` denotes `apps/server/src/voice-room-runtime.ts`; `S` denotes `apps/server/src/voice-service.ts`; `P` denotes `apps/server/src/voice-providers.ts`. Unless two locations are given, the location is identical in both revisions.

| Stage | Baseline location | PR location | Waiting or cancellation |
| --- | --- | --- | --- |
| Accept Flux final | R:126–152 | R:129–156 | Synchronous validation, echo filtering and turn-index fence. Duplicate or old finals return before cancellation. No await. |
| Interrupt old playback | R:143 | R:146–147 | Synchronous abort and clearQueue. PR also aborts this human's pending controller; an ordinary first turn has none. |
| Agent lookup | R:202 | R:229 | Await S.agents: S:54 speech selection/optional prepare; S:55 agent DB query. S:93–100 awaits provider preparation; Aura has no prepare implementation. |
| Human count | R:203 | R:230 | Await DB query S:105. |
| Continuation source | absent | R:207–211,231 | Only a previous pending turn without started playback is merged and aborted; only that branch awaits its source promise. Not entered for a fresh turn. |
| Target signal | R:207 | R:246 | Await R:102 / R:105 publishData to RTC; PR skips it if aborted. |
| Human commit | R:208 | R:250 | Await S:230 transaction, S:231 access query (S:42), S:232 participation/lease row lock, S:235 insert and transaction commit. PR uses the same original insert path. ReviseHuman is continuation-only (PR S:241–260). |
| Replace playback | R:209–212 | R:257–260 | Abort and clearQueue are synchronous. speechIdle is created, not awaited by this path. |
| History | R:219 | R:277 | Await DB query only when the in-memory history is absent. |
| Brain | R:239 | R:300 | Await brain.answer; text callbacks launch TTS concurrently with generation. P:249 awaits OpenRouter fetch; P:264 awaits streamed body chunks. Nonempty content is delivered at P:274. No added retry. |
| Phrase availability | markdown-to-speech.ts:64–96 | same | MarkdownSpeechStream holds text until a safe clause/paragraph boundary or finish. No timer. Plain punctuation requires following whitespace; a final unbroken sentence can wait for brain completion. Same in both revisions. |
| First phrase queue | R:229–232 | R:287–291 | Promise.then microtask; awaits speaker publishData, then play. Queue starts resolved; there is no speechIdle or prior reply wait. Later phrases serialize behind prior playback. |
| Speech provider selection | R:327 | R:402 | Await S.speech; then another awaited S.agents at R:329 / R:404 to get current voice (same nested prepare and DB waits as above). |
| TTS request and bytes | R:336 | R:411 | Await Aura fetch P:313 and streaming body P:319. P:317 JSON wait is only an error/quota path, not successful audio. |
| First frame accepted | R:344,351 | R:421,430 | Await audio.captureFrame. Full frames accumulate 20 ms PCM; tiny trailing fragments capture after stream completion. Quiet samples do not fire the voiced-audio metric. PR sets the continuation fence before capture and signals first audio after successful capture. No hold. |
| Final-only answer | R:247,254,259 | R:305–317 | Baseline can await dispatch before fallback text, and awaits recordAnswer before flushing pending final text. PR flushes final text immediately and commits only after first voiced audio and final decision. This removes a possible pre-audio DB wait, rather than adding one. |

`waitForPlayout` (baseline R:354, PR R:433) follows capture and is not a first-audio gate. Reply completion awaits and speaker cleanup follow playback. Background report playback does await speechIdle (baseline R:288,301; PR R:362,375), but the finished-turn reply does not.

The only STT endpoint timeout is the unchanged provider setting P:88 (`eot_threshold=0.7`, `eot_timeout_ms=1000`), preceding receipt of Flux final. The socket handshake timeout P:91 and failed-upgrade response timer P:97 are connection setup/error paths. Runtime disconnect grace (R:76 / R:79) and heartbeat interval are lifecycle paths, not turn timers. The 1,500 ms recentSpeech expiry (R:355 / R:434) is an echo-filter timestamp after playout, not a sleep.

## Added paths that could restart work

PR R:146 aborts a pending generation on another accepted speech event; R:207–211 merges a later final into an unheard pending turn, and R:231 waits for its source. That restarts brain work with combined text after the new final. This can delay a reply when there is real continued speech. It does not execute for one finished turn, and duplicate finals are rejected at R:126–127 before the abort. Without traces from the slow runs, it would be speculation to say they restarted. No new merge hold window or wait for another EndOfTurn exists.

## Instrumentation

When no cause was established, the authorized fallback added bounded `[voice-turn-timing]` JSON records, one per stage per generation: `flux_final`, `human_committed`, `brain_request`, `brain_first_token`, `brain_complete`, `tts_request`, `tts_first_byte`, `first_audio_published`, `first_voiced_audio_published`, and conditional `continuation_restart`.

Each contains a random generation trace ID, call ID and milliseconds since final receipt. No transcript, agent soul, provider key or prompt is logged. Brain first token means the first nonempty content delta exposed by VoiceBrain, not SSE headers or reasoning. First byte means the first nonempty PCM chunk exposed by VoiceSpeech. First published audio is successful AudioSource.captureFrame acceptance, not phone-speaker playback; the separate voiced marker preserves the existing measurement definition. Differences split pre-brain work, brain content latency, phrase buffering, TTS latency and RTC capture latency. A restart gets its own trace and an explicit marker. No timers or awaited logging operations were added.

Main integration also retains multi-human interruption thresholds, avatar targeting and the current short checking acknowledgement. These were conflicts with changes already on main, not new latency features.

## Standing Android results

Six finished-sentence runs per build, alternating builds, shared byte-identical PCM fixtures. Median/p90 use linear interpolation.

| Measure (ms) | main median / p90 | PR median / p90 |
| --- | ---: | ---: |
| Speech end to commit | 1,220 / 1,741 | 1,085.5 / 1,208 |
| Speech end to Android first reply audio | 3,541.75 / 4,004 | 3,681.25 / 6,113 |
| Flux final to server first voiced audio | 1,394 / 1,490.5 | 1,568 / 3,978.5 |

| Build / measure | Runs 1–6 (ms) |
| --- | --- |
| main commit | 1182, 1295, 1038, 1149, 2187, 1258 |
| PR commit | 1051, 1071, 1172, 1244, 1066, 1100 |
| main Android audio | 3704.5, 3482, 3567.5, 3429, 4303.5, 3516 |
| PR Android audio | 5927, 3603.5, 6299, 3344, 3448.5, 3759 |
| main server audio | 1486, 1078, 1371, 1417, 1351, 1495 |
| PR server audio | 3666, 1409, 4291, 1690, 1446, 1384 |

Source: Ruby's 2026-10-14 standing proof in corner e9244a2e; all twelve measured latency cases printed PASS but the runner exited 1 afterwards on its single-turn duplicate-final-count assertion. Server audio values were read by OCR from final screenshots. These qualifications remain part of the evidence. Instrumentation and local controlled regressions do not establish a passing live latency gate; renewed provider proof remains unauthorized.

## Local validation

Root build and root typecheck passed. Five server voice suites passed (95 tests), including CONTINUATION-1 real-service/phone-read cases at 1.2 s and 1.5 s and main multi-human regressions. LATENCY-AUDIT-1 exercised VoiceRoomRuntime with controlled providers/RTC and printed one finished turn with one brain call, one source, one reply and stage records; a focused rerun passed after adding the source/reply assertions. These are local regression demonstrations, not fresh live Android/provider evidence.
