# PR CI baseline — November 1, 2026

Captured 2026-11-01T22:28:59.103Z from the GitHub Actions API for `Beeline-Work/beeline`. Requested the latest sixty completed successful or failed PR Checks runs from the most recent hundred API results; obtained 60. Canceled and unfinished runs are excluded. Window: 2026-11-01T01:16:21Z through 2026-11-01T22:07:40Z (UTC).

Rerun with `node scripts/ci-baseline.mjs 60 > docs/ci-baseline-data.json` using authenticated `gh` with Actions read access. [Raw snapshot](ci-baseline-data.json) records commit SHAs, attempts, links and all measurements. The script reads workflow runs, paginated attempt jobs and logs through the GitHub API; it changes no workflows or runs.

Wall time is `updated_at - run_started_at`, including queueing between jobs, rerun waiting and GitHub finalization. Runner minutes sum each non-skipped job’s `completed_at - started_at` across all attempts, including failed jobs and self-hosted runners. These are execution minutes, not billed minutes or OS multipliers. This mixed PR sample has different path filters and is an observational baseline, not a controlled speedup claim.

Median wall time: **20.57 minutes**; median runner time: **96.59 minutes**. Total runner time: **5940.68 minutes**.

| Run date (UTC) | Run | Result | Attempts | Wall minutes | Runner minutes |
| --- | --- | --- | ---: | ---: | ---: |
| 2026-11-01T22:07:40Z | [41355519211](https://github.com/Beeline-Work/beeline/actions/runs/41355519211) | failure | 1 | 18.17 | 97.42 |
| 2026-11-01T21:44:45Z | [41353568218](https://github.com/Beeline-Work/beeline/actions/runs/41353568218) | success | 1 | 16.60 | 86.18 |
| 2026-11-01T21:44:29Z | [41353547156](https://github.com/Beeline-Work/beeline/actions/runs/41353547156) | success | 1 | 27.35 | 94.07 |
| 2026-11-01T21:18:21Z | [41351321895](https://github.com/Beeline-Work/beeline/actions/runs/41351321895) | success | 1 | 18.82 | 101.75 |
| 2026-11-01T21:15:00Z | [41351024960](https://github.com/Beeline-Work/beeline/actions/runs/41351024960) | success | 1 | 16.30 | 64.08 |
| 2026-11-01T20:46:55Z | [41348604746](https://github.com/Beeline-Work/beeline/actions/runs/41348604746) | success | 1 | 23.50 | 81.93 |
| 2026-11-01T20:44:44Z | [41348410856](https://github.com/Beeline-Work/beeline/actions/runs/41348410856) | success | 1 | 27.22 | 81.98 |
| 2026-11-01T20:33:04Z | [41347426352](https://github.com/Beeline-Work/beeline/actions/runs/41347426352) | success | 1 | 28.65 | 87.05 |
| 2026-11-01T20:30:33Z | [41347202907](https://github.com/Beeline-Work/beeline/actions/runs/41347202907) | success | 1 | 24.83 | 48.47 |
| 2026-11-01T20:27:27Z | [41346939653](https://github.com/Beeline-Work/beeline/actions/runs/41346939653) | success | 1 | 16.08 | 51.48 |
| 2026-11-01T20:26:43Z | [41346877573](https://github.com/Beeline-Work/beeline/actions/runs/41346877573) | success | 1 | 12.43 | 20.15 |
| 2026-11-01T20:26:28Z | [41346858113](https://github.com/Beeline-Work/beeline/actions/runs/41346858113) | success | 1 | 5.73 | 10.23 |
| 2026-11-01T17:16:50Z | [41330658748](https://github.com/Beeline-Work/beeline/actions/runs/41330658748) | success | 1 | 14.35 | 23.25 |
| 2026-11-01T17:06:15Z | [41329720295](https://github.com/Beeline-Work/beeline/actions/runs/41329720295) | success | 1 | 27.62 | 103.67 |
| 2026-11-01T17:06:03Z | [41329703171](https://github.com/Beeline-Work/beeline/actions/runs/41329703171) | success | 1 | 21.63 | 99.75 |
| 2026-11-01T16:59:57Z | [41329155817](https://github.com/Beeline-Work/beeline/actions/runs/41329155817) | success | 1 | 19.67 | 107.68 |
| 2026-11-01T16:41:58Z | [41327654477](https://github.com/Beeline-Work/beeline/actions/runs/41327654477) | success | 1 | 22.68 | 100.95 |
| 2026-11-01T16:36:10Z | [41327175182](https://github.com/Beeline-Work/beeline/actions/runs/41327175182) | success | 1 | 7.52 | 10.60 |
| 2026-11-01T16:35:05Z | [41327079056](https://github.com/Beeline-Work/beeline/actions/runs/41327079056) | success | 1 | 21.78 | 86.25 |
| 2026-11-01T16:31:47Z | [41326793773](https://github.com/Beeline-Work/beeline/actions/runs/41326793773) | failure | 1 | 20.28 | 105.68 |
| 2026-11-01T16:27:52Z | [41326459478](https://github.com/Beeline-Work/beeline/actions/runs/41326459478) | failure | 1 | 7.45 | 11.83 |
| 2026-11-01T15:51:42Z | [41323344567](https://github.com/Beeline-Work/beeline/actions/runs/41323344567) | success | 1 | 19.77 | 96.70 |
| 2026-11-01T15:42:45Z | [41322601750](https://github.com/Beeline-Work/beeline/actions/runs/41322601750) | failure | 2 | 8.48 | 187.30 |
| 2026-11-01T15:29:30Z | [41321481647](https://github.com/Beeline-Work/beeline/actions/runs/41321481647) | failure | 1 | 20.03 | 86.05 |
| 2026-11-01T15:25:39Z | [41321163853](https://github.com/Beeline-Work/beeline/actions/runs/41321163853) | success | 1 | 22.40 | 99.45 |
| 2026-11-01T15:12:53Z | [41320072817](https://github.com/Beeline-Work/beeline/actions/runs/41320072817) | success | 1 | 24.37 | 93.13 |
| 2026-11-01T15:07:44Z | [41319622284](https://github.com/Beeline-Work/beeline/actions/runs/41319622284) | success | 1 | 18.82 | 115.30 |
| 2026-11-01T15:04:47Z | [41319359449](https://github.com/Beeline-Work/beeline/actions/runs/41319359449) | success | 1 | 7.13 | 12.02 |
| 2026-11-01T14:46:54Z | [41317877356](https://github.com/Beeline-Work/beeline/actions/runs/41317877356) | success | 1 | 25.17 | 97.03 |
| 2026-11-01T14:41:04Z | [41317407477](https://github.com/Beeline-Work/beeline/actions/runs/41317407477) | success | 1 | 21.55 | 108.63 |
| 2026-11-01T14:11:35Z | [41314954891](https://github.com/Beeline-Work/beeline/actions/runs/41314954891) | success | 1 | 21.60 | 95.83 |
| 2026-11-01T13:55:33Z | [41313598760](https://github.com/Beeline-Work/beeline/actions/runs/41313598760) | success | 1 | 31.05 | 96.47 |
| 2026-11-01T13:54:18Z | [41313499958](https://github.com/Beeline-Work/beeline/actions/runs/41313499958) | success | 2 | 13.80 | 154.03 |
| 2026-11-01T13:44:56Z | [41312745015](https://github.com/Beeline-Work/beeline/actions/runs/41312745015) | success | 1 | 22.40 | 83.97 |
| 2026-11-01T13:32:52Z | [41311784853](https://github.com/Beeline-Work/beeline/actions/runs/41311784853) | failure | 1 | 20.90 | 107.25 |
| 2026-11-01T13:16:58Z | [41310499885](https://github.com/Beeline-Work/beeline/actions/runs/41310499885) | success | 1 | 27.67 | 104.35 |
| 2026-11-01T13:15:59Z | [41310418080](https://github.com/Beeline-Work/beeline/actions/runs/41310418080) | failure | 1 | 17.13 | 76.47 |
| 2026-11-01T12:58:02Z | [41308955753](https://github.com/Beeline-Work/beeline/actions/runs/41308955753) | success | 1 | 28.05 | 103.60 |
| 2026-11-01T12:57:32Z | [41308918718](https://github.com/Beeline-Work/beeline/actions/runs/41308918718) | success | 2 | 11.65 | 190.43 |
| 2026-11-01T12:48:10Z | [41308207996](https://github.com/Beeline-Work/beeline/actions/runs/41308207996) | success | 2 | 12.40 | 156.75 |
| 2026-11-01T09:08:44Z | [41287596541](https://github.com/Beeline-Work/beeline/actions/runs/41287596541) | success | 1 | 5.58 | 10.47 |
| 2026-11-01T06:56:07Z | [41282771450](https://github.com/Beeline-Work/beeline/actions/runs/41282771450) | success | 1 | 20.90 | 100.22 |
| 2026-11-01T06:49:50Z | [41282377607](https://github.com/Beeline-Work/beeline/actions/runs/41282377607) | success | 2 | 15.78 | 164.32 |
| 2026-11-01T06:24:35Z | [41280713991](https://github.com/Beeline-Work/beeline/actions/runs/41280713991) | success | 1 | 19.48 | 90.45 |
| 2026-11-01T06:19:22Z | [41280352164](https://github.com/Beeline-Work/beeline/actions/runs/41280352164) | success | 1 | 19.28 | 93.72 |
| 2026-11-01T05:51:33Z | [41278527974](https://github.com/Beeline-Work/beeline/actions/runs/41278527974) | success | 1 | 20.88 | 91.92 |
| 2026-11-01T05:50:31Z | [41278465861](https://github.com/Beeline-Work/beeline/actions/runs/41278465861) | success | 1 | 20.13 | 79.97 |
| 2026-11-01T05:43:11Z | [41278004976](https://github.com/Beeline-Work/beeline/actions/runs/41278004976) | success | 1 | 19.10 | 95.13 |
| 2026-11-01T05:06:41Z | [41275632509](https://github.com/Beeline-Work/beeline/actions/runs/41275632509) | success | 2 | 10.68 | 225.30 |
| 2026-11-01T04:37:31Z | [41273820157](https://github.com/Beeline-Work/beeline/actions/runs/41273820157) | failure | 1 | 37.80 | 145.53 |
| 2026-11-01T04:35:52Z | [41273713199](https://github.com/Beeline-Work/beeline/actions/runs/41273713199) | failure | 1 | 28.33 | 113.95 |
| 2026-11-01T03:46:57Z | [41270526212](https://github.com/Beeline-Work/beeline/actions/runs/41270526212) | failure | 3 | 27.73 | 307.58 |
| 2026-11-01T03:16:03Z | [41268479951](https://github.com/Beeline-Work/beeline/actions/runs/41268479951) | failure | 1 | 20.85 | 76.90 |
| 2026-11-01T02:52:53Z | [41266948180](https://github.com/Beeline-Work/beeline/actions/runs/41266948180) | success | 1 | 7.62 | 13.50 |
| 2026-11-01T02:51:53Z | [41266886894](https://github.com/Beeline-Work/beeline/actions/runs/41266886894) | failure | 1 | 22.88 | 111.65 |
| 2026-11-01T02:01:09Z | [41263434619](https://github.com/Beeline-Work/beeline/actions/runs/41263434619) | success | 3 | 19.30 | 285.33 |
| 2026-11-01T01:26:30Z | [41261102189](https://github.com/Beeline-Work/beeline/actions/runs/41261102189) | success | 1 | 36.07 | 93.67 |
| 2026-11-01T01:19:58Z | [41260642610](https://github.com/Beeline-Work/beeline/actions/runs/41260642610) | success | 1 | 40.22 | 100.43 |
| 2026-11-01T01:19:23Z | [41260604049](https://github.com/Beeline-Work/beeline/actions/runs/41260604049) | success | 1 | 37.38 | 101.00 |
| 2026-11-01T01:16:21Z | [41260389196](https://github.com/Beeline-Work/beeline/actions/runs/41260389196) | success | 1 | 23.08 | 100.43 |

## Flaky test evidence

The script compares failed jobs with a later successful attempt of the same named job in the same run (the commit cannot change between attempts). A test file is counted only when its failed Vitest `FAIL` verdict appears in the first log and a passing file verdict appears in the later log. This identifies flaky test files, not individual test cases or root causes. Separate workflow runs and failures repaired by a new commit are excluded. A short window can miss rare flakes; an empty list does not prove a flake-free suite.

No test files met that evidence rule in this sample.

Same-commit job retries without a confirmed test-file verdict (not counted as flakes):

- https://github.com/Beeline-Work/beeline/actions/runs/41308918718: SERVER SUITE SHARD 2 failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41308918718: SERVER SUITE failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41308918718: SERVER INTEGRATION failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41282377607: SERVER SUITE SHARD 2 failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41282377607: SERVER INTEGRATION failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41282377607: SERVER SUITE failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41275632509: SERVER SUITE SHARD 2 failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41275632509: SERVER SUITE failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41275632509: SERVER INTEGRATION failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41263434619: SERVER SUITE failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41263434619: SERVER INTEGRATION failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41263434619: SERVER SUITE SHARD 1 failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41263434619: SERVER SUITE failed then passed; no matching Vitest file verdict available (not counted as a flaky test).
- https://github.com/Beeline-Work/beeline/actions/runs/41263434619: SERVER INTEGRATION failed then passed; no matching Vitest file verdict available (not counted as a flaky test).

## Setup and selection guards

Checks now shares workspace setup with Intel Mac acceptance and all three on-demand workspace lanes. macOS retains Rust setup and uses Node 22, matching the shared action. Mobile on-demand lanes request the mobile dependency tree. The TypeScript-only selector remains exempt because it needs no workspace install or build. Native fingerprint inspection fetches only its base commit; full history remains only for merge-group path filtering and coverage-map ancestry/distance, with one-line reasons in the workflow and a guarded allowlist.

The existing selector already includes changed test files and tests missing from its map. Regression coverage now explicitly checks added, modified and renamed server tests with known and missing coverage entries. Required check names and all test invocations remain intact. No scheduled workflow is added.
