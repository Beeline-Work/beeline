# Beeline latency rig report

- Commit: 26dcf24391b9d2f09d2ee988dbe02e1115541a2c
- Device: squire; se_api35; x86_64; 2560 MiB; 4 cores
- Network: local HTTP; 100 ms RTT; 0 jitter; 10 Mbps
- Clock calibration: verified; maximum uncertainty 14.5 ms
- Samples: 120

- Push measurement: Activity entry to target text native frame commit; native-response phase absent. FCM delivery, notification shade, and foreground JS in-app notice are unmeasured.

| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| route | /beeline/chat/[channelId] | push-unseen-1 | 20 | 399 ms | 444 ms | 465 ms | <450 ms | 1/1 (≤1/≤1) | 0/411 | 94426 | 30/26/5 ms | PASS |
| route | /beeline/chat/[channelId] | push-unseen-5 | 20 | 468 ms | 499 ms | 500 ms | <450 ms | 1/1 (≤1/≤1) | 0/4 | 26586 | 22/18/7 ms | FAIL |
| route | /beeline/chat/[channelId] | room-list-unseen-1 | 20 | 369 ms | 430 ms | 1012 ms | <450 ms | 1/1 (≤1/≤1) | 0/4 | 26314 | 22/17/14 ms | PASS |
| route | /beeline/chat/[channelId] | room-list-unseen-5 | 20 | 468 ms | 506 ms | 506 ms | <450 ms | 1/1 (≤1/≤1) | 0/4 | 26675 | 22/18/7 ms | FAIL |
| route | /beeline/chat/[channelId] | warm | 20 | 264 ms | 288 ms | 292 ms | <450 ms | 0/0 (≤0/≤0) | 0/3 | 9911 | 19/15/4 ms | PASS |
| tap | send-text | warm | 20 | 151 ms | 188 ms | 350 ms | <150 ms | 1/1 (≤1/≤1) | 0/7 | 21661 | 32/28/24 ms | FAIL |
