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

`ThinDaemonCore` owns READY/progress callbacks, periodic reconciliation, retry timing, update
handoff, and shutdown. `RoomRuntimeCoordinator` reads `getDaemonBootstrap`, starts/stops Room
loops, confirms membership removal twice before teardown, and owns the shared session scheduler.
Each `MonolithRoomTurnLoop` polls the authenticated daemon API for Room messages and publishes
presence, receipts, live drafts, and the final reply through that same API.

Shutdown aborts Room intake first, drains active loops to the managed-update deadline, and then
force-suspends remaining ACP children. A confirmed Workspace removal moves the runtime into the
recoverable `deleted-runtimes/` directory.

Coverage lives in `apps/body/src/thin-monolith.test.ts` and
`apps/body/src/daemon-api-client.integration.test.ts`.
