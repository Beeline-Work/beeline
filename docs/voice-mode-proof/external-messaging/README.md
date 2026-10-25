# External messaging and bare contact fragments

Revision four requires bare contact names to stay silent while callers finish
their request. Stored contacts remain in the human transcript, do not invoke
the model or order, and produce no reply or audio. After recording the fragment,
the runtime keeps the silent draft and remembers the addressed agent. The next
phrase joins that draft, so both model input and the actual command source
contain the recipient without relying on older history.

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
revises the same human source to `Grok bot tell it hello`, sends that complete
text to the model, and creates exactly one ordinary command whose source
contains the recipient, plus one acknowledgement (4 runs). The phone read
shows one complete human request, replacing the earlier bare fragment. RTC/STT/TTS and the model are
doubles; this is not physical microphone or external webhook delivery proof.

Stored contact names use the existing parallel call-start read. Agent hints
retain priority within the cap (80). The controlled read overlap proof remains
unchanged (20 ms). The caller-resume and committed search-budget regressions
remain included in validation.

## Retained live routing and latency evidence

The model prompt/tools are unchanged; only caller text is assembled differently. Live streaming Luna
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

## Joined-contact reproduction and integration

SPEEDY-CONTACT-2 on reviewed head `e47581c30` fails when the model input must
contain `Grok bot tell it hello` (4/4). Merely retaining the contact in older
history did not satisfy a complete handoff. The correction leaves the recorded
contact draft assembling instead of finishing it. Existing continuation
assembly revises the same source before dispatch. The strengthened proof
checks both model input and `agent_commands.source_message_id`'s actual text.
Live streaming Luna replay of the joined request also orders once (4/4), with
no outbound webhook execution. Prompt bytes remain unchanged.

Merged main `5d289039c` to resolve the existing PR conflicts. In
`voice-room-runtime.ts`, contact lookup and speaking-speed refresh stay in the
same startup Promise.all, with contact results in the correct tuple slot;
input cleanup retains both contacts and speed caches. In
`voice-room-runtime.test.ts`, both contact and speaking-speed blocks are kept.
Caller-resume and committed search-budget handling are unchanged.

## Validation after joined-contact repair

- Workspace build, including the server: passed.
- Root typecheck, including mobile and scripts: passed.
- All voice suites: passed (446 tests, 14 files).
- Focused contact/resume/search/startup/speaking-speed checks: passed (30 tests).
- Live streaming joined-request routing: order exactly once (4/4).
- Built provider payload comparison: byte-for-byte unchanged; no latency rerun.
- No unmerged paths; whitespace checks pass.

Raw before/after output, live generation IDs and payloads are attached in the
corner. The real service/database proof verifies one revised human source and
one actual agent command with its recipient in the source text.

## Silent contact draft lifecycle

SPEEDY-CONTACT-3/4 on `528417cf9` fail (4 cases; 2 pass): a new agent/contact
or repeated contact joins the stale draft, and the draft never expires.
The same cases now pass (6/6). Stop cancels the draft; a different agent or
contact replaces it; repeating its name stays silent without duplication.
The assembler cancels an idle contact draft after ten seconds, refreshing the
limit while the caller speaks and clearing its timer on continuation or cancel.
Bare agent handling is unchanged. Existing request assembly still supplies one
complete recipient-bearing model input and command source (SPEEDY-CONTACT-2,
4/4). No prompt text changed.

Final validation: all voice suites pass (452 tests, 14 files); focused contact,
resume, search, eager and startup checks pass (36 tests). Root typecheck and
server build pass. Built provider payload bytes are unchanged; latency was not
rerun. Raw before/after output accompanies this proof.
