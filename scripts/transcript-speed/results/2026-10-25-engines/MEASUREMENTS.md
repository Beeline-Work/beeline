# List engine measurements

Three alternating blocks per engine/platform. Each cell is parenthesized. JS values are animation-frame intervals, not execution times. HWUI jank is not a count of physically dropped frames. Open and memory cells show median; minimum–maximum.

## android

| Engine | Flow status | JS p50 / p95, ms | Worst JS gap, ms | Missed JS opportunities | HWUI janky / rendered; missed vsync | Warm open settled, ms | Memory, MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flatlist | FAIL: concurrent-streams-visible | (16.67 / 23.54) | (211.37) | (1563) | (232 / 3354; 4.00) | (1094.00; 1087.00–1095.00) | (269.07; 267.48–272.15) |
| flashlist | Harness passed | (16.67 / 25.40) | (280.02) | (1485) | (258 / 3322; 8.00) | (974.00; 966.00–980.00) | (242.94; 238.40–251.17) |
| legendlist | FAIL: concurrent-streams-visible | (16.67 / 23.81) | (242.08) | (1337) | (310 / 3221; 27.00) | (969.00; 959.00–1064.00) | (243.31; 229.91–244.12) |

Memory is app process PSS after the repeated Room-switch scenario.

| Scenario | Engine | Trial JS p95 median; min–max, ms | Worst gap median; min–max, ms | Row commits median; min–max |
| --- | --- | ---: | ---: | ---: |
| keystroke | flatlist | (17.17; 16.77–34.55) | (17.70; 16.92–44.58) | (0.00; 0.00–0.00) |
| keystroke | flashlist | (17.30; 16.81–17.73) | (18.45; 16.86–25.20) | (0.00; 0.00–0.00) |
| keystroke | legendlist | (17.06; 16.79–17.73) | (17.63; 17.12–27.26) | (0.00; 0.00–0.00) |
| scroll | flatlist | (22.04; 21.53–23.02) | (53.96; 39.76–105.75) | (6.00; 6.00–6.00) |
| scroll | flashlist | (21.87; 21.35–39.16) | (62.02; 54.83–68.26) | (1.00; 1.00–1.00) |
| scroll | legendlist | (37.24; 35.51–52.25) | (146.32; 142.47–164.04) | (2.00; 2.00–2.00) |
| fling | flatlist | (28.22; 27.10–29.13) | (121.91; 121.34–137.93) | (29.00; 28.00–29.00) |
| fling | flashlist | (31.08; 29.22–38.26) | (109.29; 86.93–117.94) | (29.00; 29.00–29.00) |
| fling | legendlist | (34.62; 34.40–37.36) | (92.42; 86.78–110.61) | (25.00; 25.00–25.00) |
| history-prepend | flatlist | (27.11; 26.81–29.84) | (202.29; 187.54–211.37) | (139.00; 136.00–139.00) |
| history-prepend | flashlist | (29.37; 28.01–31.72) | (170.15; 137.97–180.39) | (128.00; 127.00–128.00) |
| history-prepend | legendlist | (25.01; 24.85–34.11) | (135.56; 118.37–159.62) | (120.00; 120.00–122.00) |
| incoming | flatlist | (16.79; 16.78–16.82) | (55.25; 40.87–61.20) | (1.00; 1.00–1.00) |
| incoming | flashlist | (17.31; 17.29–18.02) | (58.37; 54.53–69.72) | (2.00; 2.00–2.00) |
| incoming | legendlist | (16.97; 16.87–24.20) | (62.71; 59.86–93.34) | (1.00; 1.00–5.00) |
| concurrent-streams | flatlist | (27.62; 26.91–29.12) | (176.12; 127.69–200.19) | (21.00; 19.00–21.00) |
| concurrent-streams | flashlist | (29.49; 27.38–31.91) | (191.96; 177.64–280.02) | (25.00; 23.00–28.00) |
| concurrent-streams | legendlist | (27.44; 27.25–53.37) | (169.91; 168.58–242.08) | (12.00; 9.00–12.00) |
| optimistic-send | flatlist | (36.92; 24.27–40.96) | (73.26; 68.92–84.32) | (4.00; 4.00–4.00) |
| optimistic-send | flashlist | (26.23; 25.79–29.31) | (71.77; 71.07–102.36) | (5.00; 5.00–5.00) |
| optimistic-send | legendlist | (22.89; 19.98–62.57) | (64.84; 63.58–173.83) | (3.00; 3.00–3.00) |
| warm-room-switches | flatlist | (19.61; 19.04–21.99) | (143.45; 141.31–160.60) | (380.00; 380.00–380.00) |
| warm-room-switches | flashlist | (19.08; 18.59–25.40) | (120.04; 118.19–204.82) | (266.00; 266.00–266.00) |
| warm-room-switches | legendlist | (17.24; 17.06–22.40) | (109.38; 94.34–235.68) | (46.00; 46.00–83.00) |

| Engine | Cold process settled, ms | Cache miss settled, ms |
| --- | ---: | ---: |
| flatlist | (3450.00; 2898.00–3603.00) | (1459.00; 1453.00–1463.00) |
| flashlist | (3356.00; 3171.00–3791.00) | (1345.00; 1315.00–1384.00) |
| legendlist | (3559.00; 2479.00–5009.00) | (1614.00; 1591.00–2018.00) |

## web

| Engine | Flow status | JS p50 / p95, ms | Worst JS gap, ms | Missed JS opportunities | HWUI janky / rendered; missed vsync | Warm open settled, ms | Memory, MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| flatlist | Harness passed | (16.70 / 16.70) | (66.60) | (14) | (unmeasured) | (784.59; 766.50–802.32) | (39.41; 37.21–41.94) |
| flashlist | FAIL: history-prepend, scroll | (16.70 / 16.80) | (50.00) | (83) | (unmeasured) | (855.39; 845.13–861.88) | (51.34; 43.42–52.32) |
| legendlist | FAIL: history-prepend, scroll | (16.70 / 16.80) | (49.90) | (14) | (unmeasured) | (782.97; 775.20–795.91) | (45.82; 45.79–45.91) |

Memory is Chrome JS heap used after capture; this is not browser process PSS.

| Scenario | Engine | Trial JS p95 median; min–max, ms | Worst gap median; min–max, ms | Row commits median; min–max |
| --- | --- | ---: | ---: | ---: |
| keystroke | flatlist | (16.70; 16.70–16.80) | (16.70; 16.70–16.80) | (0.00; 0.00–0.00) |
| keystroke | flashlist | (16.70; 16.70–16.80) | (16.70; 16.70–16.80) | (0.00; 0.00–0.00) |
| keystroke | legendlist | (16.70; 16.70–16.80) | (16.70; 16.70–16.80) | (0.00; 0.00–0.00) |
| scroll | flatlist | (16.70; 16.70–16.80) | (16.80; 16.80–16.80) | (15.00; 15.00–15.00) |
| scroll | flashlist | (16.70; 16.70–16.80) | (16.80; 16.80–16.80) | (0.00; 0.00–0.00) |
| scroll | legendlist | (16.70; 16.70–16.80) | (16.80; 16.80–16.80) | (0.00; 0.00–0.00) |
| fling | flatlist | (16.80; 16.70–16.80) | (16.80; 16.80–16.80) | (0.00; 0.00–0.00) |
| fling | flashlist | (16.70; 16.70–16.80) | (16.80; 16.80–16.80) | (0.00; 0.00–0.00) |
| fling | legendlist | (16.80; 16.80–16.80) | (16.80; 16.80–16.80) | (0.00; 0.00–0.00) |
| history-prepend | flatlist | (16.80; 16.80–16.80) | (33.40; 33.30–66.60) | (42.00; 34.00–42.00) |
| history-prepend | flashlist | (16.80; 16.70–16.80) | (16.80; 16.80–33.30) | (54.00; 52.00–54.00) |
| history-prepend | legendlist | (16.70; 16.70–16.80) | (16.80; 16.70–16.80) | (1.00; 1.00–1.00) |
| incoming | flatlist | (16.80; 16.70–16.80) | (16.80; 16.80–16.80) | (1.00; 1.00–1.00) |
| incoming | flashlist | (16.80; 16.70–16.80) | (16.80; 16.80–16.80) | (2.00; 2.00–2.00) |
| incoming | legendlist | (16.80; 16.70–16.80) | (16.80; 16.80–33.40) | (1.00; 1.00–1.00) |
| concurrent-streams | flatlist | (16.80; 16.70–16.80) | (49.90; 33.40–50.00) | (20.00; 20.00–20.00) |
| concurrent-streams | flashlist | (16.80; 16.80–16.80) | (50.00; 33.40–50.00) | (22.00; 22.00–22.00) |
| concurrent-streams | legendlist | (16.70; 16.70–16.80) | (33.40; 33.30–49.90) | (12.00; 10.00–13.00) |
| optimistic-send | flatlist | (16.80; 16.70–16.80) | (16.80; 16.80–33.40) | (18.00; 18.00–18.00) |
| optimistic-send | flashlist | (16.80; 16.80–16.80) | (33.40; 33.30–50.00) | (4.00; 4.00–4.00) |
| optimistic-send | legendlist | (16.80; 16.70–16.80) | (33.30; 33.30–33.40) | (3.00; 3.00–3.00) |
| warm-room-switches | flatlist | (16.70; 16.70–16.70) | (16.80; 16.80–16.80) | (154.00; 154.00–154.00) |
| warm-room-switches | flashlist | (16.80; 16.80–16.80) | (50.00; 50.00–50.00) | (47.00; 47.00–47.00) |
| warm-room-switches | legendlist | (16.70; 16.70–16.80) | (33.30; 33.20–33.40) | (8.00; 8.00–8.00) |

| Engine | Cold process settled, ms | Cache miss settled, ms |
| --- | ---: | ---: |
| flatlist | (1597.16; 1596.11–1620.99) | (1507.74; 1435.29–1545.22) |
| flashlist | (1648.11; 1630.87–1648.56) | (1442.43; 1430.34–1448.53) |
| legendlist | (1611.90; 1610.34–1668.08) | (1437.55; 1437.08–1461.09) |
