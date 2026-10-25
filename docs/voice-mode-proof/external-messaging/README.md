# External messaging and bare contact fragments

Reproduction SPEEDY-CONTACT-1: a stored webhook contact `Grok`, or the short
name of `Grok bot`, is spoken as a confident final. The previous runtime drops
single-word `Grok` before recording it; multiword bare contact names reach the
brain and can incorrectly dispatch work. Speedy's live review saw bare `Grok`
order on every attempt (4/4).

The regression emits eager and final recognizer events into VoiceRoomRuntime.
Against PR head `0d6c35be0`, the initial contact cases fail (3/3). With the fix,
stored `Grok` and `Grok bot` contacts retain `Grok`, `Grok bot`, and `Grok Bot?`
in the transcript, never invoke the brain or dispatch, then dispatch a following
`Tell Grok bot hello`. Each contact/fragment combination is repeated (4 runs;
16 total). This is a simulated RTC/STT path, not a real microphone proof.

Stored contact names use the existing call-start read. Matching accepts the
normalized full name, a trailing `bot` label omitted, punctuation and a greeting.
It does not treat an arbitrary first word of a multiword contact as its name.
The final guard runs after recording the human transcript; the eager guard runs
before model work. Previous request fragments still join normally.

Live streaming Luna checks use the payload captured from the built
OpenRouterVoiceBrain, with the existing production provider settings and no
external side effects. Bare `Grok` clarified (4/4); raw bare `Grok bot` clarified
(3/4) and ordered (1/4). The runtime guard therefore remains essential and
prevents all these bare inputs from reaching that model. Actual requests to
message Grok, the `Crock Pot` recognition variant, email and Telegram all ordered
(4/4 each). A sky-color knowledge question answered in-call (4/4).

The raw live results include generation IDs, responses and usage. They are
attached to the corner, alongside the timing samples and original/fixed test
outputs. These proofs cover routing and transcript retention. They do not prove
acoustic recognition or delivery through the external webhook.

## Latency comparison against PR head 0d6c35be0

Same method as the previous comparison: alternating streamed base/head pairs
(40), interleaved base/base controls (20 pairs), OpenAI pinned without fallback,
reasoning off, identical date/soul/history/contact context, output cap unchanged.
All successful samples are retained (120 requests), with generation IDs and
OpenRouter generation `latency` as the first-delta proxy; this is not phone
first-audio latency. Resolved model: `openai/gpt-6-luna-20260922`.

| Payload | Samples | Median | p90 |
| --- | --- | --- | --- |
| Current PR base | (40) | (577 ms) | (1198 ms) |
| Fixed head | (40) | (623.5 ms) | (813 ms) |
| Base/base control A | (20) | (545 ms) | (972 ms) |
| Base/base control B | (20) | (537.5 ms) | (784 ms) |

Head minus base: median (+46.5 ms), p90 (-385 ms). Absolute paired control
jitter: median (69.5 ms), p90 (463 ms). Paired bootstrap intervals (95%,
10,000 resamples, seed 1729): median difference (-4 to +104 ms), p90 difference
(-560 to -80 ms). No clear median regression at this sample's noise floor;
this does not establish identical distributions or literal zero latency cost.
All fixed-head timing requests ordered (40/40).

Complete provider input shrinks (660 → 630 tokens; -30), relative to
`0d6c35be0`. The controlled call-start read proof remains unchanged (20 ms).
Server build, root typecheck and voice suites pass (304 tests, 5 files), with
final targeted runtime checks passing after the last runtime/test edit
(18 tests). `git diff --check` passes.
