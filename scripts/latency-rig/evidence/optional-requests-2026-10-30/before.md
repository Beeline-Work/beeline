# Beeline latency rig report

- Commit: b6112caeef3eaecfd4f59657af12c321ad8a3964
- Device: squire; se_api35; x86_64; 2560 MiB; 4 cores
- Network: local HTTP; 100 ms RTT; 0 jitter; 10 Mbps
- Clock calibration: verified; maximum uncertainty 13.5 ms
- Samples: 120

- Push measurement: Activity entry to target text native frame commit; native-response phase absent. FCM delivery, notification shade, and foreground JS in-app notice are unmeasured.

| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| route | /beeline/chat/[channelId] | push-unseen-1 | 20 | 655 ms | 769 ms | 883 ms | <450 ms | 2/2 (≤1/≤1) | 0/410 | 77854 | 23/20/18 ms | FAIL |
| route | /beeline/chat/[channelId] | push-unseen-5 | 20 | 688 ms | 1439 ms | 1458 ms | <450 ms | 3/2 (≤1/≤1) | 0/208 | 84382 | 23/21/16 ms | FAIL |
| route | /beeline/chat/[channelId] | room-list-unseen-1 | 20 | 691 ms | 1310 ms | 5000 ms | <450 ms | 6/5 (≤1/≤1) | 0/4 | 26336 | 24/19/70 ms | FAIL |
| route | /beeline/chat/[channelId] | room-list-unseen-5 | 20 | 822 ms | 968 ms | 1535 ms | <450 ms | 5/3 (≤1/≤1) | 0/4 | 26665 | 24/20/12 ms | FAIL |
| route | /beeline/chat/[channelId] | warm | 20 | 486 ms | 702 ms | 730 ms | <450 ms | 0/0 (≤0/≤0) | 0/3 | 9900 | 19/17/19 ms | FAIL |
| tap | send-text | warm | 20 | 194 ms | 244 ms | 499 ms | <150 ms | 1/1 (≤1/≤1) | 0/7 | 21869 | 35/29/18 ms | FAIL |

Timeout values are five-second censoring caps, not observed paint times. Any timeout fails the verdict.
Timed-out samples: room-list-unseen-1: 1/20
