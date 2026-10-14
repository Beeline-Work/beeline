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

## Reminder open versus dismissal correction

Reproduction reminder-open-2472: the tray's open action called `clearNeedsYou` without explicit dismissal intent, and the reminder trigger treated its `cleared_at` as a request to stop daily repeats. The regression initially failed with one dismissed reminder when none was expected.

The operation now carries `dismissReminder` only for the explicit DISMISS controls. A separate `needs_you_marks.reminder_dismissed_at` receipt drives reminder suppression; opening and normal read expiry do not write it. Explicit section CLEAR writes the same receipt. The request remains unresolved and WAITING after dismissal.

Demonstrated Reproduction reminder-open-2472: the real PhoneService clear path opens the first reminder, the next due delivery occurs, then explicit item dismissal or section CLEAR prevents any later delivery. Both variants print the passing result. The focused attention suite passed 19 tests, the tray suite passed 76 with one existing skip, and Needs-you plus expiry suites passed 38 tests. Build and root typecheck passed. This changes command intent only; no mobile visual layout changed.

The original local-browser bundle tested head 1947c62c7. The correction's exact-head browser evidence is posted separately in the corner and referenced in the current PR body; use that newest bundle for merge acceptance.

## Temporary blocker supersession correction

Reproduction reminder-supersession-2472: an open choice older than 24 hours receives its first reminder; a newer needs-decision temporarily becomes the current blocker; when the older reminder comes due, the mismatch branch permanently dismisses it. Answering the newer request restores the original choice to WAITING but deterministic flag insertion cannot revive its reminders. The regression failed before the fix with a non-null dismissal receipt.

Delivery now checks the same indexed blocker eligibility for the older source/person. A still-unanswered superseded source pauses without dismissal; resolved sources are retired. Explicit human dismissal receipts are preserved. The service-path regression sends the human's newer answer through PhoneService, reads the original choice as WAITING, and observes its second reminder with no duplicate. The existing item/section dismissal regressions also pass. The latest exact-head browser bundle in the corner supersedes earlier proof bundles.
