# Relay interaction performance

Measured 2026-08-12 against the mobile screen SDK call graphs. The probe is
`packages/buzz-client/src/relay-interaction-performance.test.ts`; it uses an
authenticated `BuzzClient`, four Rooms, DM discovery, and a serialized 30 ms
relay hop to expose request fan-out that a localhost relay hides.

| Screen path | Before requests | Before wall | After requests | After wall | Request reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Workspace home / Room list (4 Rooms, including DM discovery) | 48 | 1,554 ms | 8 | 308 ms | 83% |
| Room or DM chat | 20 | 653 ms | 5 | 180 ms | 75% |
| Agents | 10 | 327 ms | 3 | 106 ms | 70% |

The relay itself was not the bottleneck. Bootstrap reads already used the
authenticated HTTP bridge and did not wait for WebSocket setup. The cost came
from each independent `queryEvents` call becoming a separate signed POST across
several sequential screen-loading phases. `Promise.all` reduced phase latency
but did not reduce relay round trips.

The HTTP bridge now coalesces all partitionable NIP-01 filters started in one JS
turn into one authenticated POST, then applies the filters and per-filter limits
to partition the union response back to each caller. Mutable projections remain
uncached, publish still invalidates cached reads, and unsupported filter shapes
stay isolated.

Backfill was already bounded to 50 events for Room/DM chat, 30 for Room and DM
previews, and 50 per Corner lifecycle. One over-fetch remained: Corner discovery
read up to 500 ordinary parent messages per Room only to locate merge summaries.
It now asks the relay for `t=merge-summary` directly, preserving the 500-summary
correctness bound without downloading unrelated transcript or activity events.

`BuzzRigTransport` also pools its lazy `BuzzClient` by relay URL and identity.
HTTP-only navigation still opens no WebSocket. Once a chat starts the NIP-42
subscription connection, later screen transports reuse that same client/socket
owner instead of reconnecting and re-authenticating.
