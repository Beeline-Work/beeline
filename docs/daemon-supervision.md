# Daemon supervision

`@beeline/body` is a thin monolith client. Its process tree is:

```text
beeline daemon
  ThinDaemonCore
    RoomRuntimeCoordinator
      MonolithRoomTurnLoop (one per active Room)
        AcpClient (activated lazily)
```

The daemon requires a promoted monolith transport in `runtime.json`. It never opens a relay
socket, signs a relay event, manages a repository, or creates a corner.

`ThinDaemonCore` owns READY/progress callbacks, the recovery reconciliation sweep, retry timing,
update handoff, and shutdown. `RoomRuntimeCoordinator` applies the scoped membership and corner
events the daemon's one live socket pushes — starting, stopping, and closing single Rooms and
corners without re-listing — confirms membership removal twice before teardown, and owns the
shared session scheduler. Its `getDaemonBootstrap` reconciliation is the dropped-socket recovery
net, not the ordinary discovery path. Each `MonolithRoomTurnLoop` takes its work from the commands
pushed over that socket, with a slow durable read as the same kind of net, and publishes presence,
receipts, live drafts, and the final reply through the authenticated daemon API.

Shutdown refuses further pushed membership applies and waits out any in-flight one — on the same
managed-update deadline, so a Room whose start is still running lands in the snapshot instead of
joining after the abort pass — then aborts Room intake, drains active loops to that deadline, and
force-suspends remaining ACP children. A confirmed Workspace removal moves the runtime into the
recoverable `deleted-runtimes/` directory.

## OOM survival

The installed unit (`agentServiceUnit()` in `apps/body/src/systemd.ts`) sets
`OOMPolicy=continue`, so the kernel reclaiming one harness child does not stop the whole unit —
systemd's default `OOMPolicy=stop` would tear down the daemon and every other agent sharing the
host. `OOMScoreAdjust=-1000` keeps the daemon off the kernel's victim list, so the memory-hungry
child is the process reclaimed. A harness killed while a turn is in flight is reported through the
failed turn's reason rather than hanging the turn: `AcpClient` (`apps/body/src/acp.ts`) checks the
cgroup v2 `oom_kill` counter (`apps/body/src/oom-kill.ts`) when a child exits on SIGKILL and names
the OOM killer in the rejection text. A host without cgroup v2 reads no counter and keeps the
ordinary `signal=SIGKILL` wording.

Existing hosts pick up the unit change without a re-pair. `installAgentService` rewrites the
template whenever its content differs, and both update paths — `SelfUpdateManager.apply` and
`ManagedUpdateHandoff.restartRequest` — call `convergeAgentServiceUnit` after activation; the
restart that follows the update starts under the new unit. The property applies on the next unit
start, never mid-process.

Coverage lives in `apps/body/src/thin-monolith.test.ts` and
`apps/body/src/daemon-api-client.integration.test.ts`. OOM survival is covered by
`apps/body/src/systemd.test.ts`, `apps/body/src/oom-kill.test.ts`, `apps/body/src/acp.test.ts`,
and `apps/body/src/self-update.test.ts`.
