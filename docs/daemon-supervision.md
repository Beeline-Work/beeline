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

Coverage lives in `apps/body/src/thin-monolith.test.ts` and
`apps/body/src/daemon-api-client.integration.test.ts`.
