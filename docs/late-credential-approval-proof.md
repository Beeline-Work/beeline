# Late credential approval: LATE-APPROVAL-1

The reported Android incident occurred on 2026-10-15 in corner
`dac9d764-e14e-4ca0-b263-cda37ffa737a`. The required screenshot was read from
the brief's local attachment path. Its SHA-256 is
`3f546d319a6a25e3f53ea49771b35b6c9da5b3b315061f20c0a65c4fd64a1b1c`.

## Incident evidence

Owner-authorized, read-only Neon HTTP SQL inspected the incident's messages,
approval cards, activity and command rows. Local helper journal entries were
checked for 15:10–15:28 UTC. Squire's tool responses are preserved in the server
activity records; this account's vault audit endpoint did not return the
incident's fetch decisions. No credential values or approval URLs are included
here. No production approvals were consumed during this investigation.

| UTC | Committed evidence |
| --- | --- |
| 15:06:58 | Owner DM card `4b5406b6…` for approval `01M501MADGWC4F797BF3VNQSCQ`, deadline 15:16:58.860. |
| 15:12:29 | Owner DM card `8a2dba31…` for a second approval, `01M501YCY4TM749CV9A4W1M9DG`, deadline 15:22:29.120. The owner received a separate card; delivery to the physical phone is not established by the database row. |
| 15:16:58 | Local expiry posted `1af2ec3f…`, claiming the first approval had no answer. |
| 15:20:14 | Owner's “it's been approved” message starts command `7425bfb7…`, request `8ade710a…`. |
| 15:20:35 | `fetch_credential` with **only the second approval ID** returns `approval_pending`. No new approval was created by this call. |
| 15:20:48.990 | Another fetch with that same ID returns `credential_fetched`. This proves Squire accepted approval of the second request and delivered its value. The passkey signature's timestamp is not available in these records. |
| 15:20:49–15:22:22 | Android commands continue: launch the reviewer login, inspect screens, set up the test Workspace and open the invite path. |
| 15:22:29.176 | Helper expiry posts `96b2263b…` for the **already consumed second approval**, with detail “Reveal a saved credential.” The earlier pending retry had replaced the original requester with the currently running request. |
| 15:22:29.176 | Resume routing completes command `7425bfb7…` and creates resume `559bf5c1…` under the same turn request. |
| 15:22:30–15:22:44 | Helper activity and heartbeat receive `403: command output authority rejected`; the helper cancels the Android turn after 150.20 seconds. |
| 15:24:14.875 | Message `627ebbd8…` reports the stalled turn and exhausted retries. The resume command has `hiccup_attempts=2`. |

The premise that the credential never arrived is contradicted by the committed
Squire result. There was no blocking credential call at 15:22:29: both fetches
completed in under a second according to the helper's call-start/end entries.
The 10-minute approval timer falsely revoked a productive turn. The subsequent
stall notice is the server's 90-second presence/pickup recovery path
(`ConnectionPresence.failStalledTurn`), not a fetch timeout. Two retries plus the
initial attempt account for “three tries”; the mutable command row does not
preserve every individual retry timestamp.

## Reproduced

Reproduction LATE-APPROVAL-1: request a vault credential; end the asking turn; approve later;
consume the same approval ID from a new turn; pass the original deadline.
Before the fix, the relay returns `credential_fetched`, then emits an `expired`
decision for that ID. `squire-task-relay.test.ts` test “LATE-APPROVAL-1: consumes a late
approval in a new turn without a false no-answer wake” failed with that exact
unexpected decision before implementation.

Replaying a real passkey ceremony would disclose a real one-use credential and
requires the owner's participation. The closest stand-in uses the affected
relay's real loopback HTTP boundary with scripted Squire responses and an
accelerated clock; it exercises the same pending/consume/expiry sequence.

## Demonstrated

After the fix, LATE-APPROVAL-1 returns the consumed fixture value, emits no false decision,
allows the continuing turn to make another call after the original deadline,
then completes the relay turn and releases its idle connection. Squire still owns passkey verification and
single-use delivery; Beeline never caches or replays the value.

The compiled `apps/body/dist/squire-task-relay.js` was also exercised through
its loopback HTTP endpoint with an earlier turn, a later approved consume,
a refused second delivery from the Squire stand-in, and a one-second original
deadline. After 1.1 seconds the decision callback remained empty. This uses
fixture values, not a production credential or a real passkey ceremony.

Additional regressions exercise:

- A Squire decision racing a pending response cannot re-arm its old wait.
- An elapsed local deadline releases tracking without inventing a human answer.
- A second credential request after consumption reaches the owner's approval
  endpoint through a real stdio facade and HTTP handoff, with its own ID and
  turn context. The consumed value is absent from those notifications.
- A hung vault MCP request returns `fetch_credential timed out after 30000ms`;
  the relay preserves this error instead of replacing it with a browser restart
  instruction. Browser operations retain their 210-second ceiling.

No new System message type or release dispatch is part of this change. Local
expiry no longer produces a synthetic decision wake: a missing upstream
notification cannot establish that a person failed to answer. Genuine approved
and denied notifications retain their existing resume path.
