# Persistent free-agent boot recovery

Reproduction `free-agent-persistent-boot`, October 22, 2026.

## Before the fix

An isolated script imported the checkout's built `runtime.js`, wrote its own
live PID and matching process start ticks into a temporary runtime's owner
record, and called `runtimeDaemonPid`. The process was not a Beeline daemon,
but the lookup returned its PID. This reproduces a legacy persisted record
whose PID and ticks collide after reboot. The affected user's machine was
not changed, and the precise identity of its reused PID remains unverified.

The entrypoint also started any installed launcher without checking the
published release first. Its prior regression explicitly required no download
for an installed helper.

## Disposable Fly proof

Created test Machine `861d27ae563518` in `beeline-free-agents`, using the same
production image digest `fc5e3236992b1ff2a362801042f1ed8a56bf50cd7c68d001748ffe38d97654bb`,
with persistent rootfs and restart policy `no`. No production agent identity,
bootstrap token or server connection was provisioned.

Injected the changed entrypoint, bundled runtime owner validation and a small
launcher fixture into the test machine. The installer fixture replaces an old
launcher with a Node script that exercises owner validation and records
readiness. This substitutes for the public installer and a connected agent;
the shell entrypoint, owner validation, persistent disk and Fly stop/start are
real. Full helper bundle and image construction were checked separately.

First boot recorded boot ID `64b89f0d-00ba-45f7-ace2-53882cc27626` and confirmed
refresh before launcher execution. The running fixture left an old launcher
on disk and saved its birth identity. Stopped the Machine through the Fly API,
waited for `stopped`, then started it again without changing its configuration.

Second boot recorded boot ID `ddda32c5-b1c4-4bdf-8d47-ee94690ab451`, read the
previous boot's saved identity and confirmed:

- The persisted old launcher was replaced before execution.
- A saved owner with the previous boot ID, current live PID and current start
  ticks was rejected.
- A legacy tick-only owner record matching the unrelated live process was
  rejected.
- The launcher reached readiness.

The second boot returned `staleOwnerRejected: true` and
`refreshedBeforeLaunch: true`. Destroyed the disposable Machine after reading
the result; the API confirmed deletion.

## Repeatable regressions

- `node --test infra/free-agent/entrypoint.test.mjs`: installed-helper refresh,
  failed-download fallback, terminal watchdog exit, hung installer, old helper
  without a watchdog, repeated startup failures and readiness cancellation.
- Body `start-command.test.ts`: matching legacy start ticks and matching start
  ticks from another boot cannot authorize an unrelated owner.
- Body `machine-helper.test.ts`: the same stale-owner collisions reach serving
  without signaling the unrelated live process; an unestablished free agent
  reports once and exits with status 78, while readiness cancels the deadline.
