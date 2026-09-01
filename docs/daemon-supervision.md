# Beeline daemon supervision contract

Beeline's daemon is a thin, foreground process. On Linux, `beeline pair` and
`beeline start` install and enable the user unit
`beeline-agent@<agent-pubkey>.service`; `beeline stop` disables it. The daemon
does not detach, respawn itself, or own a second health process when
`BEELINE_MANAGED_BY_SYSTEMD=1`.

## Thin-core boundary

The core has exactly seven in-process responsibilities:

1. own one authenticated relay socket and its existing reconnect policy;
2. route Workspace, Room, and corner events;
3. drive bounded Room/corner ACP children and durable context;
4. invoke the deterministic signed-approval verifier (blanket per corner);
5. publish presence and supervision status;
6. own one durable WorkCalendar heap and next-due timer, whose admitted work
   enters the ordinary Room dispatcher without bypassing session capacity; and
7. delegate out-of-turn Git to a disposable worker (JSON arguments in, JSON
   stdout out, hard deadline, process-group kill).

Repository resolution, review publication, approval verification, and the
existing `Body` Room/corner state loader remain leaf modules. The retired
operational path is the old detached supervisor plus its self-spawn update
handoff; `beeline daemon` now instantiates `ThinDaemonCore` directly.

## Portable lifecycle semantics

- `READY=1` means host configuration and safety checks passed and the core
  progress loop exists. It is never conditional on a relay connection or Room
  health. The daemon revalidates a persisted model/effort selection against the
  selected ACP harness's live catalog before starting the core. A confirmed
  catalog miss/provider refusal becomes `model unavailable`; a catalog, harness,
  or authentication outage becomes `model validation unavailable` and is never
  presented as proof that the model was retired. Both are served degraded states
  rather than crash loops: the agent stays connected, reports offline, publishes
  the typed Room line, and refuses ordinary ACP work. On restart, every
  persisted human-authored model setting is live-validated separately for its
  Room before that Room's first presence. A valid override clears only that
  Room's copied startup block; a failed override reports that Room offline even
  when the daemon-wide default is valid. Sibling Rooms remain isolated from one
  another's result.
- A monolith-backed daemon includes its installed bundle version and source SHA
  in every authenticated Room presence heartbeat. The unified release runner
  reads `GET https://server.usebeeline.app/v1/releases/daemon-readiness`, which
  needs no phone bearer or runner secret and exposes only active agent ids,
  presence freshness/state, and bundle identity. Promotion succeeds only when
  every actively registered agent has fresh online presence on the exact
  release. The retired `usebeeline.app/push/health` route is not a release
  authority.
- `WATCHDOG=1` and `STATUS=` are emitted together, only after a complete core
  tick. A relay outage produces a degraded status and continued watchdog
  progress. No independent heartbeat timer exists.
- `SIGTERM` quiesces intake, drains accepted turns, and then exits. Drain has an
  absolute nine-minute deadline; remaining ACP process groups are killed after
  it, leaving one minute inside systemd's ten-minute stop ceiling for cleanup.
  Durable inbox/corner state makes the next process resume unfinished work with
  an explicit restart note.
- Exit status 78 means deliberate agent removal; 79 means the unit names no
  remaining runtime; and 77 means three consecutive starts failed. All three
  are excluded from restart. The latter leaves `daemon-distress.json` beside
  the runtime with the errors an operator needs, instead of silently looping.
- An update has one durable record, `update-attempt.json`: the active anchor
  names the current release and the record names its one previous release,
  candidate, deadline, and outcome. A running daemon observes anchor drift,
  drains, and exits; the service manager starts the stable launcher. The
  successor confirms only after its real ACP session has completed a prompt
  with an agent answer and the native capability mount. A failed or overdue
  attempt atomically restores the prior anchor, records `reverted`, and leaves
  a durable `update-rollback-alert.json` for the operator. No request files,
  per-runtime handoffs, or silent failed-release pins participate.
- Per-Room archive evidence from any path is terminal-inert. Owner-grant
  failures escalate to long jittered backoff after repeated confirmation;
  transport errors use short bounded jittered backoff. Only state transitions
  are logged.

These semantics are the portability layer. A non-systemd host can implement the
same foreground/ready/progress/stop/exit-code contract without a new Beeline IPC
protocol or health server.

## systemd user policy

The installed template uses `Type=notify`, `Restart=always`, a 5–60 second
restart backoff, start limiting, `WatchdogSec=180s`, `TimeoutStopSec=10min`,
`KillMode=control-group`, and `RestartPreventExitStatus=77 78 79`.
`NotifyAccess=all` allows the bounded `systemd-notify` helper child to deliver
the main process's notifications. The template is immutable: it always starts
`%h/.local/bin/beeline`, has no caller-derived `PATH`, and source checkouts
refuse to rewrite it. A manual systemd PATH drop-in is not supported.

## Repository event consumer

Repository event ingestion remains outside `ThinDaemonCore`, but is hosted by
the relay stack's single `materializer` Compose process beside push and snapshot
consumers. Compose owns its lifecycle and bounded SIGTERM drain. The consumer
keeps its dedicated non-agent signing identity while its delivery reservations
live in the materializer's shared Postgres store. Agent units do not receive
GitHub App credentials.
The Room's dedicated merge-gate admin enrolls the service key as a member
during discovery; it is never used to author repository activity. A legacy
Room with no persisted admin remains visibly degraded instead of silently
advancing its GitHub cursor.

The materializer log lists the last successful poll for every discovered
workspace/repository. GitHub failures are isolated and backed off per
repository, while relay deliveries are durably reserved before publication.
Each fleet tick has a 90-second aggregate deadline and rotates repository
priority, so a large group of slow repositories cannot block materializer
shutdown or permanently starve the tail of the queue.
See `apps/body/src/events-service.ts`, `events-state.ts`, and
`github-events.ts`; hosting lives in `apps/push-gateway/src/hosted-events.ts`.

## One-time host migration after merge and deploy

Firstmate should run these commands; the implementation worker must not touch
the two live daemons:

```bash
beeline start --agent 54f4d26167eb606098b6b04c9b9266c8ba0f9cf7a4ac29d33df75bdc7ca94cdd
beeline start --agent a3447f1163edeb8dff75a67c3492c808821fe21b8a0c35d363769e45efeca601
systemctl --user status beeline-agent@54f4d26167eb606098b6b04c9b9266c8ba0f9cf7a4ac29d33df75bdc7ca94cdd.service --no-pager
systemctl --user status beeline-agent@a3447f1163edeb8dff75a67c3492c808821fe21b8a0c35d363769e45efeca601.service --no-pager
```

Each `beeline start` identifies and gracefully drains the legacy detached
process before enabling the unit, so the two generations never serve the same
agent concurrently. Existing `runtime.json`, keys, Room roots, durable corner
records, worktrees, review publications, souls, and standing approvals are
read in place; there is no manual host data migration. A version-1
`body-state.json` is upgraded in memory while preserving its inbox items and
cursors, then written as version 2 on the next durable save.
