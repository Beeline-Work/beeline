# Beeline latency rig report

- Commit: 1a591c5196be16a3b7769855eae6ec7ab7baf8eb
- Device: Android 35 Pixel 5 profile x86_64 emulator; CPU uncalibrated
- Network: 100 ms configured RTT, 0 ms jitter, 10 Mbps, local HTTP
- Samples: 20

Room-only steady-state capture, 20 warm opens after local sign-in. Local HTTP excludes TLS and this emulator has no A15 CPU calibration. The route/tap launch baseline remains incomplete.

| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| route | /beeline/chat/[channelId] | warm | 20 | 88 ms | 115 ms | 143 ms | <450 ms | 0/0 (≤0/≤0) | 0/0 | 0 | 0/0/0 ms | PASS |
