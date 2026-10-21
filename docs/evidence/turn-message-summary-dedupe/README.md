# Turn message and summary deduplication

Reproduction 572a0de1c06be02cb120b38294e3d9b80b9bdfa8cdf6e53dcb708819b41393c3.

## Original path and cause

On 2026-10-21 Niglet posted the Google sign-in #2676 merge note in DM
250680af-d903-47be-9cdf-53ac6c51403d, then ended with matching final prose.
The recorded messages were 572a0de1… and cefee946… (brief revision 2).

- `apps/body/src/acp.ts:1484` selects the final assistant text.
- `apps/body/src/monolith-room-turn.ts:2174` sanitizes that final run and
  collects preceding assistant runs as notes in reply steps.
- `apps/body/src/turn-stream.ts:305` sends the final through `postRoomMessage`.
- `apps/server/src/daemon-service.ts:8200` handles explicit `post` through
  `postCornerMessage`. Previously it stored an independent visible message
  without the active request or generation.
- `apps/server/src/daemon-service.ts:3914` stores final replies, on both
  transactional routing and atomic completion paths.

PR [#2627](https://github.com/Beeline-Work/beeline/pull/2627), corner
1767a0a4-7947, fixed an earlier, different path: every streamed assistant run
was joined onto the answer. It switched the answer to the last run and stored
earlier runs as collapsed notes. It did not associate explicit posts with
the current turn or compare a final against those posts. Consequently this
DM sequence still produced two messages.

## Failing regression before the fix

`commander.integration.test.ts`, `same-address post then matching final`, runs
both untagged atomic completion and tagged transactional routing. It claims a
human-triggered DM command, calls `postCornerMessage` to its own DM, then
calls `postRoomMessage` with matching prose and reads the human Room DTO.
Before the fix, both cases failed with two message IDs instead of the expected
single explicit-post ID. The control that appends a new sentence passed.

## Passing service proof

The same sequence now returns one visible conversation message through
`PhoneService.readRoom`; the command still completes. The terminal row is
activity, preserving receipt identity, retry behavior and tool steps. Exact
and contained repeats have no second conversation body; conservative near
matches retain their wording as a collapsed summary note. A final containing
new content remains a message. A new attachment also keeps the final visible.

Scope is the same Room, author, request and generation, excluding deleted
messages. Cross-address posts, another request/generation, new sentences,
changed outcomes and changed numbers do not suppress the answer. Collapsed
finals do not wake tagged agents a second time.

`monolith-room-turn.publishing.test.ts` additionally replays intermediate
assistant text, a tool call, and matching final text through a real ACP stdio
parser and Room loop configured for Claude. Only the scripted harness and
server transport are stand-ins; the publishing lane is real. It submits one
visible final reply. Current streamed intermediate text uses draft/activity
or collapsed notes, not a second conversation message.

## Production browser attempt and remaining proof

Trusty Squire opened `https://web.usebeeline.app` and Niglet's original DM
read-only in an existing lunchboxfortwo session (session
70372244-abe5-4a80-9a06-7adc1e303992, closed afterward). This was not the GitHub
reviewer bypass. Vault metadata confirms a sealed reviewer login-link exists,
but no reviewer session or passing production reproduction was obtained.
No message was sent, no release was dispatched, and this server branch is
not deployed. Production cannot demonstrate this unshipped server behavior.

The closest executed stand-in is the exact public service sequence above,
including the human-facing Room read, plus the scripted Claude ACP publishing
path. Required follow-up after an explicitly authorized deployment: sign in
with the GitHub reviewer bypass on web.usebeeline.app, run a Claude turn that
posts to its own address then ends with matching final prose, and verify one
visible message. Do not describe this production criterion as passed.

## CI integration repair

Server shard 1 rejected the first implementation because changing the final
insert's presentation expression also changed a producer fingerprint in the
System-message lock. The repair preserves that locked insert expression.
A turn with an earlier same-address post uses the authorized transaction;
a repeated ordinary message is demoted before commit with an update constrained
to `presentation='message'`. Cards and System messages are not candidates.
The original fast completion path remains available when no same-turn post
exists. The guard and its lock file are unchanged.

Server shard 6 separately exceeded the unchanged room-list timing budget
(167.1ms versus 150ms). Its exact width-corpus test passed locally: four tests,
EXPLAIN p95 41ms, Room-list median 56ms. The personal GitHub token's job-rerun
request was refused with HTTP 403 (Actions write required). No timing budget
was relaxed and no unrelated read query was changed.

## Review correction: contained literal facts

Speedy found that normalized containment bypassed the signed-number/URL
protection applied to equality. Through the same-address post, final, and
human Room read, both corrections failed before the repair: `-5` to `5` and
`https://example.com/a-b` to `https://example.com/a/b`, with an omitted second
sentence. The corrected final was missing from the visible messages.
Containment now requires literal-bearing prose to occur with punctuation
intact and each literal to match exactly. Both corrected finals stay visible;
the unchanged amount and link summaries still deduplicate. Unit coverage also
allows dropping an unrelated sentence containing a different literal.
