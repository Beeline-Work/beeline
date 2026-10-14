# Truthful corner states: PR 1 evidence

The Step 0 consumer and writer map was posted to corner `f95aa673-2eb5-491a-930b-51dc1aa2d2ee` before code edits (message `945f648c8b10580c5d12f6746fa7f6cce0fa1dbb6acebe2e997f44663668797c`).

## Reproduced

Reproduction truthful-state-2453: the live `inspect_corner` read on 2026-10-14 returned `lifecycle: in-review`, `activity: idle`, passed checks, and a dispatched reviewer wake for `71264d10-4279-404b-89bb-7af245563946` (#2453). The old display derivation kept completed review stages in REVIEW indefinitely while inspect projected every non-WORKING state to idle activity.

Reproduction truthful-state-2454 and Reproduction truthful-state-screen-off replay the brief's other stalls: completed review checks at one hour, and a two-hour working lifecycle with no running or queued work. They use isolated databases, not production writes.

## Demonstrated

Run `npm run test -w @beeline/server -- src/corner-attention.integration.test.ts src/corner-state.test.ts src/chat-corner-counts.test.ts --maxWorkers=1 --minWorkers=1`.

The three reproduction paths execute `PhoneService.readCorners`, the daemon restore read, the attention recorder/deliverer and command inbox reads. Each prints:

```text
Reproduction truthful-state-2453: in-review/passing, 2 hours stall -> list and inspect IDLE; commander=1, worker=0, reviewer=0; repeat=0
Reproduction truthful-state-2454: in-review/passing, 1 hour stall -> list and inspect IDLE; commander=1, worker=0, reviewer=0; repeat=0
Reproduction truthful-state-screen-off: working/unknown, 2 hours stall -> list and inspect IDLE; commander=1, worker=0, reviewer=0; repeat=0
```

The same integration suite exercises running/queued worker and reviewer work, running checks, crash recovery between recording and sending, a new turn/push between ticks, commander-watch and worker-schedule/subscription exclusions, System-DM grant provenance, untagged human decision reports, repeated daily reminders, dismissal through `clearNeedsYou`, resolution before delivery, tagged choice resolution, merge holds and open-only corner discovery. The final focused run passed 40 tests.

Root typecheck passed, including mobile and scripts. The lifecycle suite passed 185 tests. Live fanout and corner projection suites passed 39 tests, including parent invalidation for queued work, merge holds and worker reassignment; five revised HTTP corner scenarios passed. Existing reviewer dispatch/list, opening watches, commander wake batching, presence and database consumer suites passed. API-contract tests passed 468; client tests passed 399; corrected relay corner reader/projection tests passed 53; MCP corner/read tests passed 52. Workflow path lint and diff whitespace checks passed. No mobile component files changed.

## Browser proof limitation

Trusty Squire opened `web.usebeeline.app` read-only in the existing lunchboxfortwo session. The truthful-corner-states list row and corner header both displayed WORKING during the active turn. This is a production baseline observation, not evidence that this branch is deployed.

The required reviewer-bypass proof of the fixed production behavior was **not obtained**. On the follow-up, Connectors listed `beeline-reviewer-bypass` with label `play-review-login-link`; its metadata confirms a vaulted value restricted to the Beeline web hosts. The browser remained in the existing owner session. The exposed navigation tool takes a plaintext URL, while sealed vault slots can fill form controls; a sealed login-link navigation route was not available. No raw value was fetched. The concrete remaining proof is to run the corner list/header paths in an authorized reviewer session against this exact change after deployment. No production deploy was performed.

Follow-up verification: `npm run corner:prepare`, root typecheck and the 40-test focused state/attention matrix passed again. The production header again showed `JELLYBEAN · working` during the active turn, as baseline evidence only.

Dead-code analysis passed with 91 existing findings and none introduced. Reminder dismissal commits its stop receipt with the Needs-you mark, so delivery does not need a historical dismissal scan.

Inbox-wide wake batching is PR 2 and is not included in this change.
