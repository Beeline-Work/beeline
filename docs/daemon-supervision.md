# Beeline daemon supervision contract

Beeline's daemon is a thin, foreground process. On Linux, `beeline pair` and
`beeline start` install and enable the user unit
`beeline-agent@<agent-pubkey>.service`; `beeline stop` disables it. The daemon
does not detach, respawn itself, or own a second health process when
`BEELINE_MANAGED_BY_SYSTEMD=1`.

## Thin-core boundary

The core has exactly six in-process responsibilities:

1. own one authenticated relay socket and its existing reconnect policy;
2. route Workspace, Room, and corner events;
3. drive bounded Room/corner ACP children and durable context;
4. invoke the deterministic signed-approval verifier (blanket per corner);
5. publish presence and supervision status; and
6. delegate out-of-turn Git to a disposable worker (JSON arguments in, JSON
   stdout out, hard deadline, process-group kill).

Repository resolution, review publication, approval verification, and the
existing `Body` Room/corner state loader remain leaf modules. The retired
operational path is the old detached supervisor plus its self-spawn update
handoff; `beeline daemon` now instantiates `ThinDaemonCore` directly.

## Portable lifecycle semantics

- `READY=1` means configuration and safety checks passed and the core progress
  loop exists. It is never conditional on a relay connection or Room health.
- `WATCHDOG=1` and `STATUS=` are emitted together, only after a complete core
  tick. A relay outage produces a degraded status and continued watchdog
  progress. No independent heartbeat timer exists.
- `SIGTERM` quiesces intake, drains accepted turns, and then exits. Drain has an
  absolute nine-minute deadline; remaining ACP process groups are killed after
  it, leaving one minute inside systemd's ten-minute stop ceiling for cleanup.
  Durable inbox/corner state makes the next process resume unfinished work with
  an explicit restart note.
- Exit status 78 means deliberate agent removal and is excluded from restart.
- Desired-release drift writes a resumable handoff and exact desired release,
  quiesces, drains, then exits. The service manager starts the successor. READY
  is accepted only when `loaded_release` equals that desired release. Failure
  before READY rolls back once under the cross-process install lock.
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
`KillMode=control-group`, and `RestartPreventExitStatus=78`. `NotifyAccess=all`
allows the bounded `systemd-notify` helper child to deliver the main process's
notifications.

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
read in place; there is no data migration.
