# Beeline latency rig report

- Commit: be8ddcf8d8fd2c66af49cfde4ddd78ce616aec2d
- Device: squire; se_api35; x86_64; 2560 MiB; 4 cores
- Network: local HTTP; 100 ms RTT; 0 jitter; 10 Mbps
- Clock calibration: verified; maximum uncertainty 18.5 ms
- Samples: 120

- Push measurement: Activity entry to target text native frame commit; native-response phase absent. FCM delivery, notification shade, and foreground JS in-app notice are unmeasured.

| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| route | /beeline/chat/[channelId] | push-unseen-1 | 20 | 443 ms | 633 ms | 803 ms | <450 ms | 1/1 (≤1/≤1) | 0/411 | 77234 | 23/21/16 ms | FAIL |
| route | /beeline/chat/[channelId] | push-unseen-5 | 20 | 382 ms | 489 ms | 595 ms | <450 ms | 1/1 (≤1/≤1) | 0/4 | 26460 | 23/19/18 ms | FAIL |
| route | /beeline/chat/[channelId] | room-list-unseen-1 | 20 | 332 ms | 537 ms | 593 ms | <450 ms | 0/0 (≤1/≤1) | 0/4 | 26327 | 22/18/16 ms | FAIL |
| route | /beeline/chat/[channelId] | room-list-unseen-5 | 20 | 602 ms | 707 ms | 743 ms | <450 ms | 0/0 (≤1/≤1) | 0/4 | 26415 | 22/18/74 ms | FAIL |
| route | /beeline/chat/[channelId] | warm | 20 | 433 ms | 659 ms | 779 ms | <450 ms | 0/0 (≤0/≤0) | 0/3 | 9895 | 19/15/72 ms | FAIL |
| tap | send-text | warm | 20 | 215 ms | 300 ms | 312 ms | <150 ms | 1/1 (≤1/≤1) | 0/7 | 21958 | 35/32/17 ms | FAIL |
