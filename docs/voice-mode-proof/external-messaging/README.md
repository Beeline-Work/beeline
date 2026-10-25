# External messaging and bare contact fragments

Revision four requires bare contact names to stay silent while callers finish
their request. Stored contacts remain in the human transcript, do not invoke
the model or order, and produce no reply or audio. After recording the fragment,
the runtime finishes it and remembers the addressed agent like a bare agent
name. The next phrase uses normal persisted Room history to resolve the contact.

## Reproduced

Reproduction VOICE-EXTERNAL-1: the original built router refused `Ruby, tell
Grok Bot hello` instead of handing it to the full agent. Retained live generation:
`gen-1792895403-KRS5HIQSdRCaCEhEJbTV`.

Reproduction SPEEDY-CONTACT-1: before the contact guard, a confident single-word
`Grok` was discarded before the transcript, while multiword contact fragments
could incorrectly dispatch. The initial contact regressions fail against
`0d6c35be0` (3/3). Speedy's original live review observed bare `Grok` order
(4/4). Revision four explicitly requires silence, superseding the intervening
spoken-clarification review request; the unpublished spoken change was removed.

## Demonstrated

Eager/final recognizer events retain stored `Grok` and `Grok bot` fragments
(`Grok`, `Grok bot`, `Grok Bot?`) in the transcript, with no model call,
dispatch, recorded answer, synthesis or accepted audio frame (4 runs per
combination; 16 total). Following Grok, Crock Pot, email and Telegram requests
each invoke the model, dispatch and speak an acknowledgement (4 runs each).

SPEEDY-CONTACT-2 uses the real VoiceService, database and phone read. A stored
webhook contact supplies `Grok bot` to hints. The final `Grok bot` is visible
in the phone transcript without an order or audio. A following `tell it hello`
reaches the model with the stored contact in normal call history and creates
exactly one ordinary agent command and one acknowledgement (4 runs). Both
human phrases remain in the phone transcript. RTC/STT/TTS and the model are
doubles; this is not physical microphone or external webhook delivery proof.

Stored contact names use the existing parallel call-start read. Agent hints
retain priority within the cap (80). The controlled read overlap proof remains
unchanged (20 ms). The caller-resume and committed search-budget regressions
remain included in validation.

## Retained live routing and latency evidence

The captured model request is unchanged by revision four. Live streaming Luna
checks for Grok, Crock Pot, email and Telegram action requests each order
(4/4); a knowledge question answers in-call (4/4). Raw bare `Grok` clarified
(4/4), while raw bare `Grok bot` clarified (3/4) and ordered (1/4). Those bare
inputs are blocked before the model by the runtime, so raw model behavior does
not determine silence or dispatch. No external messages were actually sent.

The previous comparison alternated streamed base/head pairs (40), with
interleaved base/base controls (20 pairs), OpenAI pinned without fallback,
reasoning off and identical date/soul/history/contact context. Every successful
sample is retained (120 requests), with generation IDs and OpenRouter generation
`latency` as the first-delta proxy; this is not phone first-audio latency.
Resolved model: `openai/gpt-6-luna-20260922`.

| Payload | Samples | Median | p90 |
| --- | --- | --- | --- |
| Base at 0d6c35be0 | (40) | (577 ms) | (1198 ms) |
| Unchanged model payload | (40) | (623.5 ms) | (813 ms) |
| Base/base control A | (20) | (545 ms) | (972 ms) |
| Base/base control B | (20) | (537.5 ms) | (784 ms) |

Head minus base: median (+46.5 ms), p90 (-385 ms). Absolute control jitter:
median (69.5 ms), p90 (463 ms). Paired bootstrap intervals (95%, 10,000
resamples, seed 1729): median difference (-4 to +104 ms), p90 difference
(-560 to -80 ms). No clear median regression at this sample's noise floor;
this does not establish identical distributions or literal zero latency cost.
Provider input shrinks relative to the base (660 to 630 tokens; -30).

## Validation

- `npm run corner:prepare`: passed.
- `npm test -w @beeline/server -- voice --maxWorkers=2 --minWorkers=1`: passed (403 tests, 14 files).
- Focused contact, resume, search-budget and startup command: passed (27 tests).
- Server build and root typecheck (mobile and scripts included): passed.
- Built provider request comparison and `git diff --check`: passed.

Relative to reviewed head `c60322be1`, runtime code adds the same addressed-agent
continuation used by bare agent names. The spoken local draft was replaced
before publication. No production-corpus threshold or unrelated code changed.
