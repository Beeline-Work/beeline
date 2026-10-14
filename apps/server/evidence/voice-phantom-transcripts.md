# Phantom conversational transcripts

## Reproduction phantom-1

The harness in `src/voice-room-runtime.test.ts` runs the production
`VoiceRoomRuntime.listen` callback, cancellation, generation and playback queue.
It also runs the production `VoiceService.recordHuman` writer, capturing the
actual `INSERT INTO messages` arguments with an authorized fake database.
RTC, the speech providers, model responses and database storage are simulated.
It injects recognizer events while PCM playback is held open. These are not
physical microphone measurements or writes to a production Room.

`adb devices` showed no attached devices. Android acoustic reproduction was
not obtained. The approved faithful harness reproduces the runtime behavior.

With main commit `20822ca3e` (PR #2442), the observed timeline was:

```text
57.4ms STT EndOfTurn turn=0 text="Explain the answer"
64.4ms message send: @ronnie Explain the answer
65.3ms TTS start: Hey there is the answer.
108.9ms STT StartOfTurn turn=1 text=""
108.9ms STT Update turn=1 text="Hey"
108.9ms STT EndOfTurn turn=1 text="Hey"
109.4ms barge-in cancel
109.5ms STT StartOfTurn turn=2 text=""
109.5ms STT Update turn=2 text="Yeah"
109.5ms STT EndOfTurn turn=2 text="Yeah"
109.7ms TTS stop: Hey there is the answer.
111.4ms message send: @ronnie Hey
111.4ms message send: @ronnie Yeah
111.9ms TTS start: Hey there is the answer.
```

The model fixture returns the same answer for each input. Its second TTS start
proves a new generation was triggered, not that a real model would repeat the
same words. The separate report reproduction below establishes actual replay
of a saved answer without depending on model behavior.

## Root cause and hypothesis limits

At `20822ca3e`, `src/voice-room-runtime.ts:25` treats a final transcript without
word confidence as confirmed speech. Line 36 rejects a single-word echo only
when the entire playback also consists of one word. Thus "Hey" inside a longer
phrase bypasses the echo gate at lines 133–134. Line 137 cancels audio, line 141
calls `utterance`, and line 201 calls `recordHuman`. The latter inserts
`@ronnie Hey` in `src/voice-service.ts:235`.

The "Hey" case reproduces an injected TTS echo fragment; "Yeah" reproduces
recognizer noise absent from TTS. Both were accepted with no confidence
metadata. This identifies a runtime validation defect. It does not distinguish
which acoustic source produced the words on the user's Android device.

A separate regression starts an echo turn during playback, finishes playback,
advances the clock beyond its 1.5-second echo window and then delivers the
final "Hey". Main submits that delayed final. It is a stale *current* turn
losing its playback context, not a replay of the previous user's input.
Duplicate accepted finals already remain suppressed by the turn-index gate.

## Reproduction phantom-2: answer replay

On the original corner base `638e2a300`, a saved delegated report followed
this timeline:

```text
51.5ms TTS start: Hey, here is the previous answer.
102.3ms STT EndOfTurn turn=0 text="stop"
103.3ms message send: stop
103.5ms barge-in cancel
103.6ms TTS stop: Hey, here is the previous answer.
155.2ms TTS start: Hey, here is the previous answer.
```

That base's `src/voice-room-runtime.ts:237` plays the report before marking it
spoken at line 238. Cancellation throws before the update; the `finally` at
line 241 removes the queue guard. The next refresh selects the same unmarked
report and starts its full text again. No duplicate human transcript is needed.
This reproduces a report replay mechanism; the screenshot does not establish
that the interrupted answer was a delegated report.

## Overlap

The prior order went to corner `voice-agent-switch`
(`fd6f0386-bcdd-445d-bfbe-0001f12aa1c4`). PR #2442 is the inspected overlapping
implementation; delegation did not itself establish that the corner owned it.
Its head `3c39fe41e6194c32717c44b38262fb30b5e56c30` ignored bare VAD, added word
confidence and echo checks, deduplicated final turns and claimed reports before
playback. It passed phantom-2 but failed phantom-1. It has since merged as
`20822ca3e`, and this branch incorporates it. The report-replay fix is inherited,
not duplicated here.

## Demonstrated after the narrow fix

The same phantom-1 harness now emits:

```text
51.0ms STT EndOfTurn turn=0 text="Explain the answer"
52.9ms message send: @ronnie Explain the answer
53.2ms TTS start: Hey there is the answer.
101.7ms STT StartOfTurn turn=1 text=""
101.8ms STT Update turn=1 text="Hey"
101.8ms STT EndOfTurn turn=1 text="Hey"
101.8ms STT StartOfTurn turn=2 text=""
101.8ms STT Update turn=2 text="Yeah"
101.8ms STT EndOfTurn turn=2 text="Yeah"
102.1ms STT StartOfTurn turn=3 text=""
102.1ms STT EndOfTurn turn=3 text="stop"
102.3ms barge-in cancel
102.5ms TTS stop: Hey there is the answer.
103.5ms message send: @ronnie stop
```

There are no Hey/Yeah inserts or cancellations. Stop still interrupts. The
fix matches single words within longer playback and retains playback context
through the recognizer turn's final. It consumes rejected final turn indices.
Confidence-free short acknowledgments during playback are rejected; confident
non-echo acknowledgments and new short utterances after playback still work.

Before this change, the phantom-1 and delayed-final tests fail on `20822ca3e`;
phantom-2 already passes. After the change, all 31 runtime/provider tests pass:

```sh
npm test -w @beeline/server -- src/voice-room-runtime.test.ts src/voice-providers.test.ts --maxWorkers=1 --minWorkers=1
```

The suite also checks duplicate finals and genuine `stop`, `wait`, `no`,
confident `Yeah`, and multiword interruptions. Stop/wait/no are tested even
when those words occur in the agent's playback. Root `npm run typecheck` passes.

Independent review found that freezing the initial context could miss a later
streamed clause in the same recognizer turn. The added later-clause test failed
on that intermediate implementation. The final code retains the earlier clauses
and adds newly spoken clauses to the turn's context, and that regression passes.

The harness cannot prove Android acoustic echo cancellation quality. A real
person repeating the agent's exact words can be indistinguishable from echo;
the explicit interruption words remain exempt from echo suppression.
