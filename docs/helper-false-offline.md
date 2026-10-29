# Helper intake stalls while the process stays alive

Investigated on squire on 2026-10-29 EDT. Inspection was limited to the user
journal, the saved pre-restart status file, and repository source. No live
helper lifecycle action, production database access, or Workspace change was
performed for this investigation. Reproductions use a loopback server with
stubbed persistence and real WebSockets and command intake.

## What the incident evidence establishes

The saved `helper-status-before-restart.json` records PID 388499, loaded release
`d2f1254ad92279f5b0eb01559d12ce18b58d525a` (v0.1.117), process state `serving`,
and `updatedAt=2026-10-29T18:49:05.088Z`. Ruby's entry is `serving` and says
`healthy; 16 Rooms active; surfaces=31 intake-ready=20 subscribed=0 discovered=11 degraded=0`.
Here `subscribed=0` counts the subscribed-but-not-intake-ready stage; it does
**not** mean no Room subscriptions exist (`surface-health.ts`).

The journal's last ordinary work record is Ruby's completed turn at
14:46:17.142509 EDT in Room `bb91a1c7-7cad-4fde-aafc-94fccb651ac8`.
There are no further journal entries until shutdown-related activity at
14:49:21. The 14:46 and 14:48 unanswered messages and the offline line at
14:48 are operator observations supplied with the incident brief. The status
writer's later timestamp proves the process still executed local work;
its cached healthy labels do not prove end-to-end delivery.

The failed release already contains `LiveLink`'s 75-second missing-ping
deadline. Its code and `machine-link.ts` are unchanged between that release
and the investigation base, `a9843bdd1`. There is no `[live-link] no server
heartbeat` warning in this quiet interval. A silently dead transport alone
should have triggered that deadline. The evidence does not establish which
server operation, await, or network component first stopped delivery: no
application checkpoint or pending-operation diagnostic was recorded before
the original process was restarted. An exact initiating await cannot be
recovered from the saved status and journal, and is not claimed here.

## The reproduced recovery gap

The server's 30-second protocol heartbeat runs independently of registration,
subscription admission and the per-Room inbox/command projections
(`server.ts`, `daemon-live.ts`). Protocol pongs require none of those
operations to complete. A projection waiting indefinitely leaves its
`commandsPushing` or `replaying` flag set, so subsequent invalidations only
request another iteration behind that same await. A failed projection also
used to log and discard the error without replacing its session or arranging
reconciliation. A single lost wake could therefore strand work on an
otherwise open connection.

The helper's transport deadline resets on protocol pings. Its local watchdog
asks `ThinDaemonCore`'s discovery loop to acknowledge progress; this does not
exercise an idle server session's command projection. Neither mechanism
detects the reproduced stalled projection while pings continue.

Presence is held by an accepted connection and the server instance's lease;
idle pings intentionally do not refresh a database row. Separately,
`ConnectionPresence.failDelivery` detects an unclaimed human message after
the pickup window without new authenticated HTTP evidence. It can mark the
agent offline even when the machine process and protocol connection remain
alive. The previous wording, “the helper isn't running,” asserted more than
that evidence proves. The line now says the helper is unreachable, with a
start command only if it stays offline. Historical wording still classifies
as offline.

## Recovery and bounds

New helper registrations request `intakeHeartbeat`; supporting servers confirm
it in `registered.capabilities`. On the existing server heartbeat tick, each
opted-in session sends `intake-ready` only after its already-admitted frame
queue and pending inbox/command reads finish. There is at most one pending
checkpoint per session. Idle checkpoints read no database and invoke no
daemon operation. This is push-based liveness, not command polling.

The helper requires registration to finish within 75 seconds and, after
negotiation, requires an intake checkpoint within 75 seconds. Protocol pings
cannot renew this deadline. Expiry logs the agent and registration/intake
phase, then replaces the machine socket immediately. Existing registration,
resubscription and one reconnect reconciliation restore durable pending
commands and re-claim presence. A permanently stuck projection is detected
within at most one 30-second checkpoint interval plus the 75-second deadline;
the new socket still depends on network/server availability and the existing
30-second handshake deadline. Persistent outages keep retrying with bounded
backoff. This does not promise recovery while the underlying service remains
unavailable.

Projection errors now end the affected agent session immediately, invoking
the existing registration retry path. Closed sessions suppress late projection
results. Registration refusals and updates retain their terminal behavior;
stop and socket replacement clear pending intake deadlines. Old servers omit
the capability and retain transport-only checks; old helpers do not request
application checkpoints. Both sides must be updated for stalled-projection
detection.

## Regression evidence

`apps/body/src/intake-link.integration.test.ts` stalls registration,
subscription, command projection and inbox replay while real protocol pings
continue. Each case keeps the old await blocked, verifies a bounded automatic
reconnect, claims queued work through real command intake on the replacement
session, observes presence release/re-claim, and rejects duplicate delivery
after the obsolete await finishes. Healthy idle checkpoints issue no HTTP or
database reads. The command-projection case failed before the repair because
the helper never opened a replacement socket.

`apps/server/src/daemon-live.test.ts` additionally verifies rejected projection
reads drop only that session and allow registration and snapshot replay again.
`no-polling.test.ts`, `live-link.test.ts`, `machine-link.refusal.test.ts` and
`workloop-watchdog.test.ts` cover idle reads, transport outages, permanent
refusals, older-server compatibility and the independent local watchdog.

Validation passed 123 helper tests (including the isolated machine-helper
suite), 89 server presence/delivery/silence tests, all 539 shared API-contract
tests, and the System-message lock check. Body, server, API-contract and
scripts typechecks and workflow-path lint passed. Root typecheck completed
all workspace checks, then failed in the unchanged mobile checkout on ignored
composer evidence copies and the locally missing `@sentry/react-native`
dependency. No mobile source or configuration was changed.
