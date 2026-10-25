# Alternating row trials

Order: before (1), after (1), before (2), after (2), before (3), after (3).
Each arm resets scenario traffic and starts the supplied release APK.
Hermes sampling is off; Fabric marker recording is on in both arms.
No builds or tests ran during these captures. All trials are retained.

JS columns measure frame intervals. Native columns are paired marker wall
durations with millisecond precision. Commit, layout and mount overlap.

## history-prepend

| Arm/trial | JS p50/p95 (ms) | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits | Commit p50/p95 (ms) | Layout p50/p95 (ms) | Mount p50/p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before (1) | (16.68 / 34.38) | (461.88) | (336) | (93) | (110) | (2 / 31) | (1 / 8) | (0 / 1) |
| before (2) | (16.7 / 35.76) | (408.54) | (368) | (73) | (142) | (2 / 22) | (1 / 6) | (0 / 1) |
| before (3) | (16.73 / 50.59) | (553.58) | (435) | (101) | (107) | (3 / 34) | (1 / 7) | (0 / 1) |
| after (1) | (16.71 / 30.83) | (382.99) | (275) | (89) | (110) | (2 / 23) | (1 / 6) | (0 / 1) |
| after (2) | (16.7 / 35.02) | (552.12) | (336) | (81) | (106) | (3 / 33) | (2 / 8) | (0 / 1) |
| after (3) | (16.7 / 33.65) | (584.97) | (327) | (81) | (110) | (2 / 26) | (1 / 7) | (0 / 1) |

Median across the three trials:

| Arm | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits |
| --- | ---: | ---: | ---: | ---: |
| before | (461.88) | (368) | (93) | (110) |
| after | (552.12) | (327) | (81) | (110) |

## optimistic-send

| Arm/trial | JS p50/p95 (ms) | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits | Commit p50/p95 (ms) | Layout p50/p95 (ms) | Mount p50/p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before (1) | (16.72 / 62.67) | (346.6) | (66) | (93) | (5) | (4 / 23) | (1 / 4) | (0 / 2) |
| before (2) | (16.76 / 83.12) | (205.16) | (52) | (109) | (8) | (5 / 23) | (1 / 6) | (0 / 3) |
| before (3) | (16.67 / 38.6) | (165.86) | (43) | (57) | (6) | (2 / 9) | (1 / 2) | (0 / 1) |
| after (1) | (16.68 / 39.34) | (140.03) | (40) | (150) | (5) | (2 / 21) | (1 / 3) | (0 / 2) |
| after (2) | (16.68 / 48.09) | (213.52) | (47) | (69) | (5) | (3 / 23) | (1 / 4) | (0 / 3) |
| after (3) | (16.67 / 45.79) | (131.45) | (32) | (48) | (5) | (2 / 15) | (1 / 2) | (0 / 1) |

Median across the three trials:

| Arm | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits |
| --- | ---: | ---: | ---: | ---: |
| before | (205.16) | (52) | (93) | (6) |
| after | (140.03) | (40) | (69) | (5) |

## concurrent-streams

| Arm/trial | JS p50/p95 (ms) | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits | Commit p50/p95 (ms) | Layout p50/p95 (ms) | Mount p50/p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before (1) | (18.5 / 157.85) | (598.74) | (202) | (85) | (20) | (7 / 29) | (1 / 6) | (0 / 3) |
| before (2) | (26.69 / 208.85) | (446.59) | (206) | (81) | (23) | (7 / 22) | (1 / 6) | (0 / 2) |
| before (3) | (17.44 / 78.94) | (402.48) | (165) | (61) | (19) | (4 / 17) | (1 / 4) | (0 / 2) |
| after (1) | (17.96 / 118.41) | (329.17) | (185) | (69) | (23) | (5 / 24) | (1 / 5) | (0 / 3) |
| after (2) | (26.32 / 96.19) | (317.03) | (167) | (48) | (23) | (4 / 15) | (1 / 4) | (0 / 2) |
| after (3) | (19.76 / 85.83) | (540.29) | (155) | (61) | (25) | (4 / 14) | (1 / 4) | (0 / 1) |

Median across the three trials:

| Arm | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits |
| --- | ---: | ---: | ---: | ---: |
| before | (446.59) | (202) | (81) | (20) |
| after | (329.17) | (167) | (61) | (23) |

## fling

| Arm/trial | JS p50/p95 (ms) | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits | Commit p50/p95 (ms) | Layout p50/p95 (ms) | Mount p50/p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before (1) | (16.94 / 32.51) | (236.62) | (56) | (44) | (32) | (1 / 4) | (1 / 1) | (0 / 1) |
| before (2) | (20.23 / 57.64) | (292.56) | (111) | (65) | (31) | (2 / 10) | (1 / 2) | (0 / 1) |
| before (3) | (23.89 / 58.3) | (263.82) | (116) | (65) | (34) | (2 / 10) | (1 / 3) | (0 / 1) |
| after (1) | (16.73 / 28.35) | (221.1) | (45) | (34) | (31) | (1 / 2) | (1 / 1) | (0 / 1) |
| after (2) | (18.77 / 47.86) | (262.08) | (83) | (48) | (33) | (2 / 6) | (1 / 2) | (0 / 1) |
| after (3) | (16.83 / 38.04) | (222.84) | (65) | (46) | (31) | (1 / 8) | (1 / 2) | (0 / 1) |

Median across the three trials:

| Arm | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits |
| --- | ---: | ---: | ---: | ---: |
| before | (263.82) | (111) | (65) | (32) |
| after | (222.84) | (65) | (46) | (31) |

## scroll

| Arm/trial | JS p50/p95 (ms) | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits | Commit p50/p95 (ms) | Layout p50/p95 (ms) | Mount p50/p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before (1) | (16.69 / 26.39) | (57.27) | (16) | (36) | (0) | (1 / 3) | (1 / 1) | (0 / 1) |
| before (2) | (16.69 / 20.94) | (109.93) | (18) | (34) | (0) | (1 / 2) | (1 / 1) | (0 / 1) |
| before (3) | (16.68 / 22.99) | (50.75) | (9) | (32) | (0) | (1 / 3) | (1 / 1) | (0 / 1) |
| after (1) | (16.66 / 22.46) | (68.81) | (12) | (32) | (0) | (1 / 4) | (1 / 1) | (0 / 1) |
| after (2) | (16.74 / 36.65) | (109.12) | (49) | (48) | (0) | (2 / 7) | (1 / 3) | (0 / 1) |
| after (3) | (16.77 / 26.41) | (75.12) | (21) | (36) | (0) | (1 / 3) | (1 / 1) | (0 / 1) |

Median across the three trials:

| Arm | Worst JS (ms) | Missed JS | UI p95 (ms) | Row commits |
| --- | ---: | ---: | ---: | ---: |
| before | (57.27) | (16) | (34) | (0) |
| after | (75.12) | (21) | (36) | (0) |
