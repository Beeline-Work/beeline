# Reproduction latency-night-2026-10-30

The approved brief records nightly run `night-2026-10-30-EG85he` on `e20fb93a`: all (80) new-message opens missed the Room cache and fetched before draw; all (20) warm opens hit. New-message p50 ranged from (371–573 ms), compared with about (260 ms) on October 20. These baseline figures come from the brief, not a new capture in this corner.

The server now sends complete offscreen message deltas through (2048 UTF-8 bytes), including message metadata and deletion replacements. At the earlier NET-HOL-1 stress bandwidth (1.6 Mbps), this caps serialization at about (10 ms) per complete delta; its (128 KiB) offscreen stimulus still becomes a preview. Active Rooms and clients without the preview capability retain their existing delivery path. No new wire event shape is introduced.

The mobile list applies complete deltas through its existing Room reconciliation and cache registry. A large preview removes the cached Room response, fencing outstanding restores and avoiding partial rows, including edits/deletions that cannot be detected from the newest message id alone.

## Contract reproduction

`apps/server/src/server.test.ts`, “sends complete small messages to opted-in offscreen Room caches”, starts the real server WebSocket endpoint, subscribes offscreen with preview capability, publishes a message invalidation, and feeds the resulting wire frame directly into the mobile cache handler and real SurfaceRegistry. Opening the cached response finds the complete new row.

Temporarily restoring preview-only delivery made this test fail waiting for the complete frame. Restoring the fix made it pass. The server suite also preserves large-preview, legacy-client and viewed-Room coverage. Mobile tests cover one/five complete arrivals and cache invalidation on preview. Contract tests cover the exact byte boundary and multibyte text.

## Device proof

Pending the branch capture. Do not treat contract tests as native paint or active-reply timing evidence.

## Server import boundary repair

The server contract test previously imported mobile `surface-registry.ts` and `cache-room-message-delta.ts`. The registry reached `surface-clock.ts`; the delta handler reached `room-view-presentation.ts`. These runtime modules used shared contracts only, but Vite resolved their nearest `apps/mobile/tsconfig.json`, which extends `expo/tsconfig.base.json`. The presentation module also had erased type-only references to mobile transport, agent display, corners, and PR lifecycle.

The registry, clock, message cache handler, and Room reconciliation now live in `packages/buzz-client`, with mobile re-exports preserving one implementation and one clock. The server imports that package, never the mobile source tree. Existing server tests that read mobile source text (pairing command and corner status formatter) do not load its tsconfig. The server Vitest transform override is removed.

Root typecheck and the focused mobile cache, reconciliation, identity, and Workspace tests pass (52 tests). The standalone server test passes (85 tests). Device proof remains pending CI, as ordered.
