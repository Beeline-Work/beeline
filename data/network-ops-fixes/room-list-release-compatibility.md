# Room-list release investigation

Firstmate instruction 063; investigation on 2026-11-04 UTC. **Resolved by the UI lane (firstmate instruction 064): its failing build contained stale local `net/dist`; rebuilding fresh main loads the Room list.** This is a build-output mismatch, not an expected client/server release-window failure. The independent local main/main and release-window checks below also pass. The native resolution is reported by firstmate; this lane did not rerun that device proof.

## Evidence and limits

The supplied UI proof used main `483ea07d07d2c747b026f3c9e7c4b95cd85a5d94` on the unchanged runtime40 APK, with a locally inserted profiling update, against the production v142 server. It reached the Room-list screen, then displayed a connection error. The original v142 update restored the same proof account's 12 Rooms. This is a real observed difference, but not an OTA delivery proof.

The supplied `current-main-load-failure.md`, `current-session.log` and `launch-diagnostic.log` were read without modifying that worktree or touching its device. Neither log records the failing Room-list operation, socket close reason, or owner initialization exception. They contain generic push registration connection-closed warnings, plus a later sign-in-required warning. Those warnings do not establish why the Room list failed.

## Executable local matrix

This matrix was executed by a local historical-source harness. The one-off harness is omitted from the shipped tree; the results and scope are retained here and in the PR description.

The harness archived exact historical source, started each actual server handler on loopback with its database migration, and ran each actual mobile shared connection, production router bridge/owner, `RoomViewClient`, `ChatListStore`, SurfaceRegistry and surface-storage implementation. It asserted all **12 synthetic Room IDs**, and asserted the candidate/candidate case uses `readRouterSnapshot` in router mode. It saved frame traces and source provenance in `.beeline-proof/room-list-release-*/matrix.json`; any failed combination exited nonzero. No production identity or Workspace is used. Client sockets must use that fixture's loopback origin; HTTP requests fail.

| Client source | v142 server | Pinned main server | Activation candidate server |
| --- | --- | --- | --- |
| v142 `98c2a49a4f3df909e8fd3fc32ae39129f6f8367b` | 12 Rooms, legacy | 12 Rooms, legacy | 12 Rooms, legacy |
| Main `483ea07d07d2c747b026f3c9e7c4b95cd85a5d94` | 12 Rooms, legacy | 12 Rooms, legacy | 12 Rooms, legacy in this run |
| Activation candidate with negotiation fix | 12 Rooms, legacy | 12 Rooms, legacy | 12 Rooms, router |

All nine cases passed. The candidate is the working tree for https://github.com/Beeline-Work/beeline/pull/3482 including the transport follow-up described below. Pinned main has router policy off, matching its server composition; the candidate composes the enabled runtime.

This is a **historical-source Node/PGlite proof**, not an installed-native40 proof or a production-image test. Each client bundles its corresponding archived shared SDK source. Server external/workspace dependencies come from the current installation. Authentication, Android host services and MMKV native storage are synthetic host implementations; actual React rendering, Hermes, native credentials, production account data, deployment proxy and production server configuration are outside this proof. The server runs the actual HTTP/WebSocket factory and migrations, not the full service entrypoint and its background services.

Together with the fresh-build native result reported by firstmate, the matrix shows no unavoidable Room-list protocol break from releasing server and OTA together, server first, or OTA first in this fixture. It cannot establish that every user's native build will work or explain away the original failure.

## Independent activation defects found and fixed

The actual wire trace showed `readWorkspaces` replying before `router-capabilities`. The client treated **any RPC reply** as evidence of an old server, permanently chose legacy for that socket, and ignored the later capability reply. RPC handling can race the ordered negotiation/control queue. This explained why the initial candidate matrix loaded through legacy despite universal activation; it did **not** explain the native failure, since the legacy Room list loaded locally.

`live-connection.ts` now selects legacy only from the existing ordered `sync-ok`/`subscribed` barrier. Ordinary replies still settle their requests but cannot downgrade negotiation. No timeout, retry or extra network call was added. Old-server acknowledgement fallback remains covered.

The same receiver also omitted both advertised Tray families from its allowlist. It now preserves `needs-you-tray` and `needs-you-saved-page` only with both command deduplication and authority-fence support, matching Scheduled Work's capability requirements.

Validation after the fixes:

- Mobile `live-connection.test.ts`: **96 passed**, including the reordered Workspace reply and all four command/authority combinations for Tray.
- Server `router-mobile-transport.integration.test.ts`: **2 passed**, covering policy-off and legacy-sync recovery.
- Full root `npm run typecheck`: passed, including all 14 workspace tasks, mobile and scripts.
- Phone scanner: **72/72**; router boundaries: **158**; no inventory or enforcement weakened.
- Twelve-Room local matrix: **9/9 passed**, including the actual candidate router path.

## Native investigation handoff and resolution

The UI proof lane needs one failing-build capture containing socket open/close code and reason, RPC operation and result/error code, and exceptions from capability loading/owner initialization. Do not log bearer tokens, credentials or response payloads. In particular, capture `connect()`'s rejected capability import and the rejection handler around `router.negotiated()`, which currently hide their detailed reasons from the supplied log. Then rerun that same native build against the local release stack or a synthetic-account equivalent. This was the requested diagnostic handoff before instruction 064 identified stale local `net/dist` and confirmed that fresh main loads. No source workaround for that stale-build failure was added. The activation negotiation fixes above address separate defects discovered by the local matrix. Activation CI failures remain a separate follow-up; this report does not declare those gates green.
