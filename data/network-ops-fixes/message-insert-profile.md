# Activation message-insert profile

Instruction 066 comparison for https://github.com/Beeline-Work/beeline/pull/3482. All measurements use synthetic identities and an isolated loopback PostgreSQL instance. No production data, owner's Workspace, test deadline or lock budget changed.

The seed is the existing `R-PUSH-SCAN-LOCK` statement: 50,000 messages with `repeat('@owner historical message ',100)`. Historical push/live fanout is disabled exactly as in that test. Fresh messages in the full test retain both triggers. The profiling SQL uses `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)` and a 120-second statement ceiling, with `pg_stat_user_functions` enabled. This ceiling measures the seed; the unchanged test's 120 seconds covers setup, seed, delivery, locks and cleanup too.

## Findings and changes

1. Before the activation fixes, every ordinary message retained a distinct Tray advisory lock despite having no deadline. Bulk writes exhausted PostgreSQL lock memory. The INSERT trigger now tests the actual asking/card predicate in SQL before capture. Reconcile/retire also return before locking an absent, empty source. Existing source serialization and ownership fences stay intact.
2. Profiles after that fix show **zero Tray capture calls** for all 50,000 ordinary messages. A paired 2,000-row transaction experiment removed either the filter trigger or the new readiness index in disposable transactions. Warm times were 2.709 seconds with both, 2.909 without the trigger, and 2.830 without the index. These controls do not support removing either feature.
3. The first 2,000-row sample spent 15.613 seconds in the existing `corner_report_answer` trigger; subsequent samples spent about 0.6 seconds. This was cold planning/evaluation of the complete waiting-report projection when no candidate corner existed. `clear_corner_report_blockers` now checks the identical indexed scope predicate before entering that projection. Existing report-answer authorization and temporal conditions remain unchanged. The 50,000-row trigger time fell from 23.230 seconds to 2.682 seconds.
4. Shared-host wall time varied substantially: even unchanged search-document work rose from 22.001 to 32.983 seconds between runs. Repeat measurements therefore record the owned PostgreSQL backend's user+system CPU time as well as wall time. Neither CPU evidence nor seed-only timing substitutes for the full regression gate.

## Recorded runs

| Source | Router | Seed wall time | Backend CPU | Outcome |
| --- | --- | ---: | ---: | --- |
| main `525dfedb5e1f351e4493a8c2bbf52f5d41a49568` | off | 64.593 s | not sampled | Seed complete |
| activation `d9fe7d798`, filtered capture | on | 88.002 s | not sampled | Seed complete |
| activation plus scoped report guard | on | 87.953 s | not sampled | Seed complete; report trigger 2.682 s |
| same main, repeat | off | 120.002 s | 82.940 s | SQL timeout before completion |
| final scoped guard, clean database | on | 87.177 s | 67.460 s | All 50,000 inserted; report trigger 2.252 s |

Initial profiles used archived source and fresh schemas. An existing migration checks live-trigger names database-wide, so leftover test schemas can suppress installation in a new schema. The historical seed excludes live fanout on both sides; the full regression and final reproducible profile use a clean synthetic database to retain the intended fresh-message proof.

The final activation run completed with less backend CPU than the repeated main run consumed before cancellation. It did not beat the initial 64.593-second main wall-time sample, so these shared-host runs establish reduced report-query work, not a stable wall-time speedup. The full unchanged gate subsequently passed in **112.304 seconds**, including all 300 deliveries and 20 exclusive-lock acquisitions (maximum handoff **18 ms**), with all plan assertions intact.

## Reproduction and validation

The local one-off profiler recorded the source head/dirty state, trigger definitions, EXPLAIN plan, function timings and Linux backend CPU in `.beeline-proof/seed-LABEL-50000.json`. It used exact source roots, isolated loopback databases and a 4096 MB heap cap, and dropped only its generated schema. The profiler is omitted from the shipped tree; measured outcomes remain in this report and the PR description.

Required executable proof remains `apps/server/src/push-outbox.test.ts` (`R-PUSH-SCAN-LOCK`), with its original 120-second deadline, 50,000 historical rows, 300 deliveries, 20 exclusive-lock acquisitions and plan assertions. Existing corner-owed and commander-wake behavior tests verify that relevant reports still become answered. Final results are recorded in [activation CI fixes](activation-ci-fixes.md).
