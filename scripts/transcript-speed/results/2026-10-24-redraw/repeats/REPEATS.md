# Repeated Android regression checks

Reproduction `TRANSCRIPT-REDRAW-2`. These retained captures were collected on the original leased Android 15 emulator (`emulator-5566`), with the same deterministic fixture, release APKs, reset sequence and private control port (19896). Each arm reinstalls the selected APK and resets generated fixture traffic. The exact driver is [paired-regressions.sh](paired-regressions.sh). Arm order: before, after, after, before, before, after. No trial is dropped.

## Alternating scroll and incoming captures

Each cell is median per-trial p95 in milliseconds, followed by the complete min–max spread in parentheses. There are three independent app-reset trials per arm. JS rAF intervals and Android HWUI aggregate histogram percentiles measure different things.

| Scenario | JS before | JS after | UI before | UI after |
| --- | ---: | ---: | ---: | ---: |
| fling | 36.66 (31.60–45.25) | 32.90 (24.74–36.99) | 48.00 (36.00–53.00) | 38.00 (34.00–44.00) |
| incoming | 24.62 (22.52–58.47) | 23.97 (20.94–25.42) | 32.00 (25.00–65.00) | 32.00 (17.00–34.00) |

The alternating runs do not reproduce a directional regression: both JS medians improve, incoming UI median is unchanged and fling UI median improves. The original fast-scroll point estimate (23.9 → 34.8 ms) is smaller than the observed baseline trial spread (13.65 ms). This supports measurement variability rather than a demonstrated scroll-specific cause; three trials cannot prove equivalence or exclude a small regression.

Incoming row commits before: 72, 42, 42; after: 1, 1, 1. The first baseline trial includes extra commits, retained as observed. All paired after keystrokes commit zero rows.

## Other full-suite repeats

These captures are retained to avoid selecting favorable runs. `after-repeat.json.gz` ended before the final send; it has no final provenance envelope and is incomplete, so it cannot qualify as an acceptance suite. `before-repeat.json.gz` and `after-repeat-final.json.gz` completed. Their chronological full-suite timing varies substantially and is not an alternating control. Do not combine them with the paired runs to claim every path passed.

| Scenario | JS before | JS after | UI before | UI after |
| --- | ---: | ---: | ---: | ---: |
| incoming | 17.82 (16.93–22.19) | 27.96 (22.18–28.80) | 17.00 (16.00–30.00) | 31.00 (19.00–69.00) |
| keystroke | 17.72 (16.78–18.84) | 18.89 (16.94–32.92) | 16.00 (6.00–19.00) | 16.00 (16.00–48.00) |
| warm-room-switches | 160.61 (146.71–240.89) | 19.92 (19.26–22.93) | 101.00 (101.00–117.00) | 150.00 (133.00–150.00) |
| optimistic-send | 41.27 (30.94–59.36) | 83.57 (58.96–84.87) | 73.00 (16.00–73.00) | 85.00 (65.00–101.00) |
| concurrent-streams | 39.48 (34.09–61.99) | 119.59 (105.04–153.07) | 25.00 (25.00–34.00) | 65.00 (61.00–81.00) |
| fling | 23.20 (22.85–36.31) | 49.77 (45.72–57.21) | 27.00 (23.00–44.00) | 53.00 (40.00–57.00) |

The completed later full-suite after run is materially slower for send, concurrent replies and fast scroll. This prevents a blanket no-regression acceptance claim from the saved data. Host-load snapshots are included, but load correlation alone does not establish cause. Fresh matched full-suite captures are needed before review.

See [PROFILE-NOTES.md](PROFILE-NOTES.md) for separate Hermes samples and source locations of the suspected costs. Profiling was not enabled during acceptance timing.

## Fresh complete suite after resuming this wake

Both complete arms ran serially on the same newly launched, corner-owned Android 15 `se_api35` instance (`127.0.0.1:5555`), with isolated host control port (19906), identical fixture fingerprint, reset sequence and APK hashes from the original comparison. This instance replaced the absent old process; do not pool it with the original device trials. Each scenario has three repeats; typing has 21. No builds or tests ran during timing. Both captures contain the final provenance envelope, all 42 samples, visible incoming messages and settled sends. The exact driver is [recheck-full.sh](recheck-full.sh).

| Scenario | JS before | JS after | UI before | UI after | Median row commits before / after |
| --- | ---: | ---: | ---: | ---: | ---: |
| incoming | 25.97 (24.95–54.52) | 23.93 (21.53–25.87) | 53.00 (48.00–57.00) | 32.00 (32.00–34.00) | 42 / 1 |
| keystroke | 22.15 (18.02–41.57) | 18.49 (17.64–25.89) | 32.00 (11.00–150.00) | 16.00 (16.00–32.00) | 2 / 0 |
| warm-room-switches | 19.55 (19.27–19.78) | 110.46 (29.15–158.83) | 150.00 (133.00–150.00) | 133.00 (133.00–150.00) | 1620 / 1142 |
| optimistic-send | 90.61 (37.24–163.61) | 42.02 (23.04–69.27) | 77.00 (73.00–150.00) | 48.00 (32.00–61.00) | 62 / 6 |
| concurrent-streams | 215.88 (111.76–250.40) | 60.00 (46.42–91.31) | 81.00 (65.00–81.00) | 38.00 (32.00–61.00) | 249 / 23 |
| fling | 72.97 (43.50–74.07) | 46.02 (34.97–62.12) | 65.00 (61.00–69.00) | 53.00 (48.00–57.00) | 62 / 31 |

Fast scroll and incoming p95 do not reproduce the original slowdown, including Android UI percentiles. Send and concurrent-reply medians improve. The redraw win holds in every after incoming trial (one row) and every after keystroke (zero rows). Baseline typing includes zero commits in the first trial and extra transition commits at the start of later trials; all values remain in the raw capture.

### Room-switch p95 conflict — review remains blocked on a decision

Room-switch JS p95 is worse in this fresh run, outside its baseline trial spread, while Android UI p95, row commits, missed JS frame opportunities and worst gaps improve. Do not label the whole table a no-regression PASS.

The exact same harness can report a smaller p95 for a more heavily stalled run: multi-second gaps consume wall time but contribute only one interval each. Baseline Room-switch samples contain only 499 / 569 / 537 intervals over the sampling windows, with 17 / 19 / 17 gaps above 50 ms. After contains 840 / 759 / 990 intervals, with 56 / 36 / 58 gaps above 50 ms. The baseline gaps above 50 ms are below five percent of all recorded intervals, so p95 misses them; the after gaps exceed that cutoff. These raw distributions explain the metric reversal without proving a causal product regression.

| Room-switch diagnostic, each trial | Before | After |
| --- | ---: | ---: |
| Maximum JS interval (ms) | 2638.11 / 2517.91 / 3095.84 | 664.81 / 997.18 / 491.73 |
| Missed JS frame opportunities | 1303.00 / 1231.00 / 1265.00 | 964.00 / 1041.00 / 823.00 |

Decision needed: retain the strict p95 requirement and keep this PR in draft for further measurement work, or approve a Room-switch acceptance rule that also accounts for missed JS frame opportunities and maximum stalls. Do not roll back the row-local rendering based on this percentile reversal alone. No speculative product optimization, compiler activation or list-engine change was made in this investigation. The PR is not ready for review under the current literal requirement.
