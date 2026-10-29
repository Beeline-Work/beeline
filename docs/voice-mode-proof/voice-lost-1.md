# Mixed conversation and work in a voice request

Reproduction voice-lost-1, investigated 2026-10-29. Production reads were
read-only. Personal names, store information and unrelated conversation are
omitted.

## Production evidence

The call ran on 2026-10-28 from 17:22:08 to 17:23:11 UTC.

- At 17:22:24 the source transcript contained “Introduce yourself. Connect my
  Shopify”. At 17:22:26, `[voice-brain-trace]` recorded the completed model run
  and `[voice-router-decision]` recorded `answer`. The spoken answer contained
  an introduction and asked what to tackle first; it did not address Shopify.
- At 17:22:36 a subsequent router decision was `order`. Delivery committed
  against that same source message. Its ordinary command was claimed at
  17:23:10, then cancelled by a new human steer at 17:24:07.
- The two later spoken “Checking” replies each had a separate source message
  and ordinary command. Both commands completed successfully, with visible
  Room replies at 17:25:37 and 17:25:53. Both explained the Squire connection
  blocker. The first completed turn trace included connector and feedback
  calls. These replies arrived after the call ended.

The evidence does not support a missing dispatch or a blanket free-agent
result-delivery failure. The voice defect is the first mixed request being
handled as conversation only. The routing instructions described conversation
and work separately, without requiring the action to survive a mixed request,
and did not explicitly name app/account connections as work. The narrow fix
adds that routing requirement to the voice prompt and order tool description.
The separate Squire connection failure is outside this change.

## Local demonstration

The original production call has ended; it cannot be replayed in place.
Use the service stand-in with the same reproduction identifier:

```sh
npm test -w @beeline/server -- src/voice-room-runtime.test.ts -t 'Reproduction voice-lost-1 stand-in' --silent
```

It runs the mixed transcript through `VoiceRoomRuntime`, `OpenRouterVoiceBrain`,
real `VoiceService` dispatch, ordinary command claim and `DaemonService` reply
publication, then reads the visible result with `PhoneService.readRoom`.
It asserts one command containing the whole request, an acknowledgement followed
by a clear connection failure in the Room, and one playback of that failure
after repeated refreshes. Storage is isolated PGlite; RTC, speech synthesis and
the provider response are doubles. The failure text is an injected agent result,
not a live Shopify connection attempt.

The regression fails on the unmodified provider prompt because the mixed-work
routing requirement is absent, and passes with the fix. This is a prompt-contract
regression plus a service-path demonstration, not a deterministic model-quality
test.

A separate live check used the built provider's request configuration with the
production starter soul and reconstructed pre-request history. The fixed prompt
returned `order` for the original mixed request, a direct Shopify connection
request, and a paraphrased mixed request. An introduction-only control returned
conversation without an order. The original mixed-request passing generation
was `gen-1793246403-tCODKJSovf37TJ0EGYmK`. A fresh run of the old prompt also
returned `order`; the production failure is intermittent. These samples verify
the intended route, not a guarantee across future model runs. No production
connection or caller state was changed.
