# Universal router activation

2026-11-04. Implements firstmate instruction 061: enable the router for every production phone/helper/server path, retaining compatibility and rollback code. No identity/Workspace cohort or staged activation step is introduced. This activation does not relabel the audit closure ledger or claim live/device proofs.

`BEELINE_NETWORK_ROUTER_V1` now defaults on; explicit `0` retains rollback. Protocol negotiation, durable local authority/command storage, object storage and current authority remain actual capability requirements. Installed clients that do not negotiate the router retain their existing protocol.

Production previously supplied neither `routerProjections` nor media capability to the server. `network-router-runtime.ts` now composes all families, command deduplication, Room continuity, Scheduled Work authority, media metadata and one shared build coordinator. Mobile advertises the implemented roster, Tray and saved-page adapters. Helper activation, overlays, usage, turn ownership and MCP delivery share the enabled default.

The release migration installs the existing background ownership, Tray source/readiness, commit-fence and private work-stream schemas, then publishes router schema marker **62**. The historical base marker remains **46**. `index.ts` supplies the existing background lock backend, committed listener and aggregate lease to Tray work. Only returned source deadlines and committed wakes admit work; there is no new timer, connection, retry loop or client inventory. The legacy choice-expiry adapter remains available when explicitly disabled. Rollback uses the same schema-capable image with `BEELINE_NETWORK_ROUTER_V1=0`; preserve source-ownership columns and fences.

## Local validation

All Vitest files ran serially with `NODE_OPTIONS=--max-old-space-size=4096 --maxWorkers=2 --minWorkers=1`. PostgreSQL used the isolated loopback test database and fresh synthetic schemas, never the owner's Workspace.

- Full root `npm run typecheck`: passed (workspaces, mobile, scripts).
- `network-router-runtime.postgres.test.ts`: passed using the real release migration and a two-connection pool, an actual PostgreSQL advisory lock, bounded readiness reconciliation, all-family negotiation and listener-loss retirement. No private test schema installation or substituted SQL functions.
- `network-router-runtime.test.ts`, `router-schema-rollback.test.ts`: default-on, explicit-on/off, all consumer aliases, no composition reads, retained historical marker and strict new-image readiness passed.
- `tray-clock-work.test.ts`, `tray-clock-work.readiness.test.ts`, `tray-clock-availability.test.ts`: 31 tests passed.
- `helper-activation-socket.test.ts`, `helper-usage-socket.test.ts`, `turn-ownership-socket.test.ts`, `daemon-live.test.ts`, `router-socket.projections.test.ts`: 34 tests passed.
- `rooms-mcp-negotiation.test.ts`: six default/override/listener cases passed. The two `MCP-STREAM-RESOURCE` HTTP exchange cases passed (158 unrelated tests excluded).
- Mobile router-owner, router-tray, live-connection, nativeRuntimeImports and voice-transport.ios-compat: 149 tests passed. These are source/runtime regression tests, not a new installed-native40 device proof.
- `node --test scripts/network-codec-bundle.test.mjs`: all three hard budgets passed, including 88 KiB/24 KiB phone owner limits.
- Router boundary regressions: 28 passed. Phone inventory: 72/72. Router inventory: 158. Workflow paths: 140 resolve. No scanner or inventory allowance increased.

The real PostgreSQL activation test is included in the existing isolated PostgreSQL CI step. Group A's independently reviewed projection changes remain in https://github.com/Beeline-Work/beeline/pull/3383 and should land first or alongside activation. Old-path removal remains separate.
