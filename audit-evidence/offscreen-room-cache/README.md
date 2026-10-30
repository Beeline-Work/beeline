# Reproduction latency-night-2026-10-30

The approved brief records nightly run `night-2026-10-30-EG85he` on `e20fb93a`: all (80) new-message opens missed the Room cache and fetched before draw; all (20) warm opens hit. New-message p50 ranged from (371–573 ms), compared with about (260 ms) on October 20. These baseline figures come from the brief, not a new capture in this corner.

The server now sends complete offscreen message deltas through (2048 UTF-8 bytes), including message metadata and deletion replacements. At the earlier NET-HOL-1 stress bandwidth (1.6 Mbps), this caps serialization at about (10 ms) per complete delta; its (128 KiB) offscreen stimulus still becomes a preview. Active Rooms and clients without the preview capability retain their existing delivery path. No new wire event shape is introduced.

The mobile list applies complete deltas through its existing Room reconciliation and cache registry. A large preview removes the cached Room response, fencing outstanding restores and avoiding partial rows, including edits/deletions that cannot be detected from the newest message id alone.

## Contract reproduction

`apps/server/src/server.test.ts`, “sends complete small messages to opted-in offscreen Room caches”, starts the real server WebSocket endpoint, subscribes offscreen with preview capability, publishes a message invalidation, and feeds the resulting wire frame directly into the mobile cache handler and real SurfaceRegistry. Opening the cached response finds the complete new row.

Temporarily restoring preview-only delivery made this test fail waiting for the complete frame. Restoring the fix made it pass. The server suite also preserves large-preview, legacy-client and viewed-Room coverage. Mobile tests cover one/five complete arrivals and cache invalidation on preview. Contract tests cover the exact byte boundary and multibyte text.

## Device proof

The unchanged local-attempt.sh completed on be8ddcf8d; see repair-rig/report.md and report.json. Every arrival case recorded (20/20) cache hits and zero pre-draw Room GETs. Counts join cache-read-end markers within each device attempt window and Room GET starts before the native paint timestamp. Push samples include one other prepaint HTTP request; that is not a Room fetch.

| Case | Before cache hits | After cache hits | After pre-draw Room fetches | After p50 |
| --- | --- | --- | --- | --- |
| Room list, one new | 0/20 | 20/20 | 0/20 | 332 ms |
| Room list, five new | 0/20 | 20/20 | 0/20 | 602 ms |
| Push, one unseen | 0/20 | 20/20 | 0/20 | 443 ms |
| Push, five unseen | 0/20 | 20/20 | 0/20 | 382 ms |

The before p50 range is (371–573 ms), from the approved nightly baseline. After p50 has not returned to approximately (260 ms); the rig budget verdict fails. Warm p50 is (433 ms), send-text p50 (215 ms). The server shard overlapped the first portion of capture, so these timing figures are not an uncontended comparison. All raw capture remains at /tmp/emberus-rig-repair; the report and host-load summary are committed. Active-reply timing under large offscreen traffic remains unproven. No timing metric or rig method was changed.

## Contract test location

The registry, clock and Room reconciliation remain in mobile. The mobile suite's
`offscreen-room-contract.test.ts` starts the actual server, subscribes offscreen,
and feeds its WebSocket frame into the mobile Room cache. The server suite also
asserts that small offscreen messages retain the full frame. No mobile runtime
code is moved into the shared package.
