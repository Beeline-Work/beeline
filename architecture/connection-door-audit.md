# Phone connection ownership audit

Inventory taken before edits on 2026-11-04, after the single connection-death
change reached `origin/main`. Locations below refer to that snapshot.

| Door or exception | Decision and evidence |
| --- | --- |
| `apps/mobile/sources/sync/transport/live-connection.ts:162,201` exported constructor | Remove production construction authority. All production callers use `sharedLiveConnection`; constructor injection is used only by transport tests. |
| Same file `:423,1228` public `dispose` returned by the singleton | Remove from the production capability. No production caller disposes it; the method closes the socket and unregisters identity/network listeners. Retain owner-held cleanup for tests. |
| Same file `:1279` exported singleton reset | Restrict to the guarded test seam; there are no production callers. Identity changes already enter through `subscribeClientReset` and the private identity handler. |
| Same file `:541,1275` Retry | Keep. It opens only an absent socket with demand; it cannot close or replace a present socket. Explicit user Retry restores exhausted offline recovery without a timer. |
| Same file `:551` connection death | Keep privately. Native close/error and the five-second unanswered ping are transport evidence; Room failures now request covering reads. |
| Same file `:613,624` identity change and drop | Keep privately. Sign-out/account/relay changes must discard the old authorization and cursors; liveness recovery cannot serve this trust-boundary transition. |
| `apps/server/src/server.ts:654` shutdown termination | Keep. HTTP shutdown waits for upgraded sockets; it must terminate them before draining. |
| Same file `:825,840` close/terminate | Keep only inside the helper branch. Helper backpressure and protocol heartbeat belong to a distinct machine/agent protocol; phone liveness is client-owned. |
| Same file `:668-809` raw upgrade rejection and older helper replacement | Keep before phone admission. Invalid/unauthenticated upgrades have no phone session; replacing an older daemon registration is helper authority. |
| Same file `:805` catch-all `socket.destroy()` after upgrade | Restrict to pre-admission failures. A synchronous phone setup exception can reach this catch after upgrade; an admitted phone must remain open. A socket integration test throws during setup and verifies a native ping/pong still works. |
| Same file `:873-1608` phone handler, `phone-live-output.ts:4`, `phone-socket.ts:12` raw socket parameters | Remove close-capable handles. Phone handlers need send, state and close/error observation only. Backpressure produces missed-update coverage; request/admission failures return bounded refusals. |
| `scripts/check-architecture.mjs:47-53` warning-only relaxation | Remove. A candidate that expands an exception budget, owner set or scan boundary must fail against base. The captain explicitly authorized this policy change. |
| Same file `:13` base-runner claim | Correct. TYPECHECK executes the candidate runner (`scripts/ci-workspace-tasks.sh:25`). Editing guard code is reviewable source, not itself proof that a rule was relaxed. |
| `architecture/invariants.json:235-281` name budgets | These cover unrelated installed-data migrations, display defaults and generated vendor code as well as other workers' seams; see `seam-sweep-b.md`. They cannot prove capability ownership. Zero-budget capability rules now cover connection ownership, server phone admission, and the already-merged server-read owner without editing that worker's implementation. Removed declarations must also lower the existing name counts when integrated. Do not delete supported migrations merely to change a name count. |
| `scripts/phone-network-channels.mjs:410-480`, `scripts/router-boundaries.mjs:109-358` primitive inventories/owner checks | Extend the existing checks to reject lifecycle capability escapes regardless of manifest entries. Counted network primitives alone miss a second constructor, singleton reset or owner-handle leak. |

No production reason justifies exporting phone disposal, construction or reset.
Test dependency injection remains explicitly confined by the existing scanners.
