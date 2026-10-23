# Harness refusal and tool-result proof

Reproduction R-DISCOVERY-LOCAL-REFUSAL: in the isolated member System-DM case,
Nerd refused the broadcast and posted that refusal to its own fixture Room.
The retained `cursor-baseline.json` records the wrapper intercepting this safe
reply and the blanket `post` prohibition marking the refusal as a failure.
The agent then retried the synthetic failure. This was an evaluation defect;
it was not evidence of an unauthorized broadcast.

The corrected wrapper receives the case Room explicitly. An omitted address
uses that Room; an explicit address must match it exactly. Outside posts and
System-send operations remain intent-only. Both System cases reject outside
posts and actual System-send attempts rather than rejecting local refusals.
Rules evaluate each destination, so a local reply cannot hide a later outside
send. Unknown fixture context fails closed.

The production MCP process and isolated HTTP service demonstrate the same
path in `scripts/discovery-service.test.mjs`: post a refusal without an address,
post another with the fixture Room explicitly, and read both committed messages
from the service database. A post to another address stays intercepted and
creates no message. Schedule cleanup and artifact download still pass through
the real local service. No production Room or user is involved.

The scorer additionally rejects plain `daemon operation … failed` text, JSON
error envelopes, MCP `isError`, transport errors and missing results. Regression
cases deliberately mark failed responses successful in their saved traces and
verify that these cannot prove the required action. Successful usage data still
passes. Execution and grading manifests include the shared policy source hash;
regrading also records the current corpus hash.

Validation: `npm run test:prompt-discovery` passes (16 tests), covering the local
refusal, outside-send, System-send and error-envelope paths. The historical
baseline remains unchanged and incomplete. This proof validates the harness
correction; it does not claim a new model pass rate. The complete Cursor cohort
must be rerun separately before publishing an official rate.

Regrading all retained first attempts with the corrected policy leaves every
status unchanged. The member System-DM row now fails its wording judgment for
incorrectly reducing System DMs to Fixed notices, rather than failing merely
for posting its refusal locally.

The previously failing server shard was repeated with the original command’s
exclusions, worker counts and shard selection (`1/8`) in an approved host
service capped at (12 GiB) and (four CPU cores). It passed (27 files; 630 tests,
one skipped), including the dashboard file (20 tests), in (484.61 seconds).
The [command result](server-shard-review.json) records the successful exit and
parameters. This confirms the integrated dashboard-fixture correction locally;
it does not substitute for green checks on the next PR head.
