# Local HTTP baseline

Commit: `1a591c5196be16a3b7769855eae6ec7ab7baf8eb`; captured 2026-10-10T00:36:59.334Z.
Shape: 100 ms configured RTT, 0 ms jitter, 10 Mbps; local HTTP, no TLS.
This is signed local monolith and shaped-proxy response timing. It does not measure Android first frames.

| Operation | n | p50 | p95 | p99 | Max response bytes | Max SQL / depth / pool wait |
|---|---:|---:|---:|---:|---:|---:|
| workspaces | 20 | 106 ms | 109 ms | 109 ms | 870 | 4 / 4 / 1 ms |
| chats-1 | 20 | 107 ms | 109 ms | 113 ms | 733 | 7 / 7 / 7 ms |
| room-1 | 20 | 108 ms | 108 ms | 112 ms | 1256 | 5 / 5 / 2 ms |
| chats-10 | 20 | 108 ms | 109 ms | 109 ms | 3866 | 7 / 7 / 3 ms |
| room-10 | 20 | 109 ms | 110 ms | 110 ms | 1256 | 5 / 5 / 2 ms |
| chats-200 | 20 | 134 ms | 135 ms | 136 ms | 109637 | 7 / 6 / 2 ms |
| room-200 | 20 | 395 ms | 407 ms | 408 ms | 25433 | 5 / 5 / 2 ms |
| corners-300 | 20 | 119 ms | 121 ms | 121 ms | 168171 | 5 / 5 / 4 ms |
