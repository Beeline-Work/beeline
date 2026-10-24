# Room command recovery after a helper restart

Investigated on squire on 2026-10-24 UTC. Production inspection used only the
user journal and SQL inside `BEGIN READ ONLY` transactions with a ten-second
statement timeout. The live helper and Workspace were not changed. All restart
and removal tests ran under the helper suite's isolated homes and user bus.

## Evidence

The helper self-update restarted at 03:29:51. The new process, journal PID
2683765, announced Ruby at 03:29:58 and started her fifteen other top-level
Rooms at 03:30:00, including her DM. That sequence omits her #beeline intake.
Her current Room membership remained active, and the Room was not archived. Her last completed #beeline turn settled
at 03:27:41 with a real helper generation.

Read-only command/turn joins for Ruby show:

| UTC | Place / reason | Execution evidence |
| --- | --- | --- |
| 03:30:50 | DM report | Claimed 03:30:50.627; completed 03:31:32.380 |
| 03:31:02 | #beeline report | Pending; no claim, generation, or lease |
| 03:31:56 | Corner report | Claimed 03:32:05.724; completed 03:33:10.519 |
| 03:33:18, 03:33:29 | #beeline human tags | Pending; no claim, generation, or lease |
| 03:34:38 | #beeline report | Pending; no claim, generation, or lease |
| 03:35:49 | #beeline schedule | Pending; no claim, generation, or lease |
| 03:37:35 | #beeline human tag | Pending; no claim, generation, or lease |
| 03:41:06 | #beeline owner restart | Pending; never claimed |
| 03:41:30 | #beeline report | Pending; no claim, generation, or lease |

The pending input commands had `agent_turns.status='working'` and reserved
`pending:<command id>` generations. These are dispatch reservations, not
executions. The restart command itself did not create a model turn.

The same journal records machine-wide private storage maintenance for #beeline
under other agents' roots at 03:30:10–03:33:54. Such maintenance acquires the
process-wide Room storage lease while inventorying and removing objects. The
journal logs deletions, not lease acquisition, so its first deletion timestamp
is not the start of the lease. Archived-checkout reconciliation continued well
past that release, including cleanup failures at 03:37:57, 03:39:58 and 03:40:22.

Useful read-only evidence queries join `agent_commands` to `agent_turns` by
Room, agent and request, selecting command state, generation, claim and lease
timestamps alongside turn status/generation; filter to the incident agent and
03:27–03:43 UTC. Do not infer execution from `started_at`: the reservation
trigger initializes that timestamp before a helper claim.

## Cause and repair

`RoomRuntimeCoordinator.startRoom` silently skipped a Room while a host or
Room storage lease was held. It remembered the deferred start, but lease release
only woke the full discovery sweep. That sweep could still be waiting on
unrelated archived-checkout cleanup. Already subscribed Rooms kept working;
the missing Room had no command subscription to receive either new work or its
restart command. This explains the selective startup sequence and pending-only
command records. The journal does not contain per-agent lease diagnostics; the
exact lease interleaving is reproduced deterministically in the isolated test.

There was also a second lost-wake path: a subscribed intake could defer input
during local storage maintenance, but lease release did not wake running
intakes. Additionally, the Room loop discarded its stable intake notifier after
a reconciliation or prompt, preventing later maintenance releases from waking
it reliably.

Room intake now subscribes regardless of storage maintenance. Its home is
created only after a permitted claim. Ordinary input/resume claims remain
fenced by host, Room and local maintenance leases; storage release wakes the
existing intake directly without waiting for discovery. The stable notifier
remains installed until intake exits. Stop and restart commands retain their
existing ability to bypass ordinary-turn admission, so an owner can restart an
idle stuck Room during maintenance.

On the server, `routeTaggedLifecycleCommand` treated any `working` turn row as
running, including unclaimed dispatch reservations. Status, diagnostics and
restart wording now require a claimed command with an unexpired lease and the
same real generation as the working turn. Pending reservations, expired leases,
completed commands and mismatched generations cannot produce a false drain
message. A real live claim still reports a running turn. Restart confirmation
continues to require a genuinely new helper lifecycle.

## Regression coverage

- `apps/body/src/thin-core.fast-resume.test.ts`: complete a turn, stop the old
  core, restart during either a host or Room storage lease, hold archived
  cleanup open, deliver new work to both Rooms, release storage and verify
  claim/run without releasing cleanup. Repeat maintenance on the same intake,
  then verify an owner restart claims while input is storage-blocked and no
  model turn is running. The API uses an in-memory command queue and the
  provider prompt is stubbed; core startup, intake, prompt finalization,
  shutdown and storage leases are real.
- `apps/body/src/storage-lifecycle.integration.test.ts`: a newly assigned Room
  subscribes during maintenance without another discovery sweep.
- `apps/server/src/agent-lifecycle-command.test.ts`: lifecycle status,
  diagnostics, restart claim and new-lifecycle confirmation for pending,
  expired, mismatched, completed and live execution states.

Before the fix, both restart/storage cases failed because the Room intake was
missing; four lifecycle cases falsely reported a running turn. The same cases
pass with the repair. Existing command, scheduler, membership, storage,
watchdog and timer-free intake tests cover the surrounding invariants.

## Validation

The focused helper matrix passed 89 tests. Server command and permission
integration passed 113 tests with one optional loopback-PostgreSQL concurrency
case skipped; lifecycle coverage passed all 11 tests. Root `npm run typecheck`
passed, including mobile and scripts. Shared-package suites passed 914 tests.

The full helper run passed all 2,664 assertions across 221 files (three files and
13 tests skipped), but exited nonzero for three unhandled `write EPIPE`
errors from `repository-cache-repair.ts:67`. That file is byte-identical to the
base commit; its child-stdin writer has no stream error listener. An isolated
archive of the unmodified base and an isolated run on this branch each
passed that cache suite's five tests, indicating a timing-sensitive validation
problem rather than a consistently failing assertion. This run is not presented as a green full-suite check.
