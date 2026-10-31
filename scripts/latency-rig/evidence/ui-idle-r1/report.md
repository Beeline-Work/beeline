# Beeline latency rig report

- Commit: 4c33daff8
- Device: squire; se_api35; x86_64; 2560 MiB; 4 cores
- Network: local HTTP; 100 ms RTT; 0 jitter; 10 Mbps
- Clock calibration: verified; maximum uncertainty 7.5 ms
- Samples: 200

- Push measurement: Activity entry to target text native frame commit; native-response phase absent. FCM delivery, notification shade, and foreground JS in-app notice are unmeasured.

| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| route | /beeline/chat/[channelId] | push-unseen-1 | 20 | 294 ms | 370 ms | 420 ms | <450 ms p95 | 0/0 (≤1/≤1) | 0/415 | 94591 | 30/24/8 ms | PASS |
| route | /beeline/chat/[channelId] | push-unseen-5 | 20 | 312 ms | 343 ms | 361 ms | <450 ms p95 | 0/0 (≤1/≤1) | 0/6 | 26944 | 22/17/8 ms | PASS |
| route | /beeline/chat/[channelId] | room-list-unseen-1 | 20 | 285 ms | 329 ms | 369 ms | <450 ms p95 | 0/0 (≤1/≤1) | 0/6 | 27143 | 22/16/15 ms | PASS |
| route | /beeline/chat/[channelId] | room-list-unseen-5 | 20 | 286 ms | 325 ms | 327 ms | <450 ms p95 | 0/0 (≤1/≤1) | 0/6 | 26941 | 22/17/9 ms | PASS |
| route | /beeline/chat/[channelId] | warm | 20 | 308 ms | 358 ms | 430 ms | <450 ms p95 | 0/0 (≤0/≤0) | 0/3 | 10105 | 19/13/5 ms | PASS |
| tap | open-composer | warm | 20 | 59 ms | 74 ms | 77 ms | <150 ms p50 | 0/0 (≤0/≤1) | 0/0 | 0 | 0/0/0 ms | PASS |
| tap | open-corner | warm | 20 | 829 ms | 903 ms | 926 ms | <150 ms p50 | 5/4 (≤1/≤1) | 0/3 | 8510 | 12/12/3 ms | FAIL |
| tap | react-message | warm | 20 | 78 ms | 96 ms | 105 ms | <150 ms p50 | 1/1 (≤1/≤1) | 0/3 | 2387 | 10/10/1 ms | FAIL |
| tap | send-text | warm | 20 | 183 ms | 211 ms | 227 ms | <150 ms p95 | 0/0 (≤1/≤1) | 0/15 | 23228 | 34/31/11 ms | FAIL |
| tap | switch-tabs | warm | 20 | 168 ms | 182 ms | 184 ms | <150 ms p50 | 0/0 (≤0/≤1) | 0/0 | 0 | 0/0/0 ms | FAIL |
