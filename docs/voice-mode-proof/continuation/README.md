# Voice continuation proof

Reproduction CONTINUATION-1: recognized speech ends, the owner continues while
the voice brain is thinking, and the baseline creates a second human message.
At baseline `a37868e86eaaced940d95b4d0c2d5bf9674ffff0`, the reproduction in
`voice-room-runtime.test.ts` failed because `recordHuman` ran twice.

The fix reserves a source before asynchronous work, serializes edits of that
source, and restarts generation with the combined text. Confirmed partial speech
aborts an unheard draft before the next final transcript. The first accepted
non-silent server audio frame closes the continuation window. Later speech keeps
the existing barge-in behavior. Dispatch starts once that audio boundary and the
final order decision exist; interrupting playback cannot cancel the dispatch.
If the acknowledgement streamed before the order decision, generation finishes
that decision despite playback cancellation. Unheard cancelled text is never
persisted, and an in-flight answer write cannot produce a duplicate row.

The same-message update checks current Room/Workspace membership, joined call
participation, active runtime ownership and lease expiry in its transaction.
It refuses sources that have already dispatched an ordinary command.

## Demonstrated

The isolated PGlite tests run the actual VoiceService, VoiceRoomRuntime and
PhoneService reader. They inject recognized STT events, wait 1,200 or 1,500 ms,
then inject a confident partial and its final transcript. Both phone reads show
one human source containing the combined request and one complete agent reply.
Generation runs twice, the cancelled partial produces no visible reply or
ordinary command, and a duplicate final does not create another acknowledgement.
Stale runtime leases and removed membership cannot revise that source.

Race tests cover continuation during authorization and insertion, authorization
failure, serial edits, opening-name and avatar target changes, cancellation
during the first audio capture, dispatch before playback finishes, an order
decision arriving after audible barge-in, and persistence racing barge-in.

## Finished-sentence timing

The identical controlled-clock fixture runs on the baseline and the final code.
It supplies a 1,000 ms end-of-turn event delay and fixed costs for authorization,
message writing, generation, synthesis and frame capture.

| End of speech to | Before | After | Change |
| --- | ---: | ---: | ---: |
| Human message commit | 1,011 ms | 1,011 ms | 0 ms |
| First accepted server audio frame | 1,076 ms | 1,076 ms | 0 ms |

Flux remains `eot_threshold=0.7` and `eot_timeout_ms=1000`. No flat silence
threshold or continuation wait was added. The source-edit path only runs for
continuations.

These are deterministic regression measurements using provider and RTC doubles,
not live Flux/Luna/Aura or phone-speaker measurements. They prove no additional
scheduled wait in the finished-sentence path. They do not establish the live
phone latency merge gate.

## Validation commands

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm run build -- --concurrency=2
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
npm test -w @beeline/server -- --pool=forks --maxWorkers=1 --minWorkers=1 src/voice-room-runtime.test.ts src/voice-providers.test.ts src/voice-service.integration.test.ts src/voice-target.test.ts src/voice-emotion.test.ts src/agent-voice.test.ts src/markdown-to-speech.test.ts
npm test --prefix apps/mobile -- --run --pool=forks --maxWorkers=1 --minWorkers=1 sources/buzz/voice-transport.test.ts sources/buzz/use-voice-call.test.tsx sources/components/buzz/ConversationComposer.speech.test.tsx
NODE_OPTIONS=--max-old-space-size=4096 npm test -w @beeline/api-contract -w @beeline/nostr -w @beeline/buzz-client -- --pool=forks --maxWorkers=1 --minWorkers=1
```

Server voice: 94 tests. Mobile voice: 48 tests. Shared packages: 466 API-contract,
8 Nostr and 399 client tests. Existing regressions for #2442, #2443, #2446 and
#2447 remain in the passing voice suites. No mobile or screen-off code changed.

## Android limitation

On chad, adb and the Android 35 x86_64 SDK image are available. An isolated AVD
was created after reading the avdmanager launcher. The prescribed accelerated
emulator command failed because this process cannot access `/dev/kvm`.
A separate `-accel off` attempt reached adb, but Android did not report completed
boot during validation and package services were initially unavailable.
No Beeline Android app or native RTC continuation check was completed.
The isolated emulator was stopped; production services were untouched.

Before merge, the owning helper must complete a usable Android device check and
live-provider, phone-audio latency verification. No iOS check or merge was
attempted.
