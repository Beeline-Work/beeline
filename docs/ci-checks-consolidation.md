# Checks consolidation evidence

This is a CI performance change, not a defect report. It changes scheduling and setup reuse, while retaining the existing test commands and aggregate check contexts.

## Runner demand

`node --test scripts/workflow-change-filter.test.mjs` evaluates the real path filters, decision shell script, job conditions and matrix sizes. Counts below exclude skipped checks and cover `checks.yml` only; Desktop and release workflows are unchanged.

| Representative diff | Before | After |
| --- | ---: | ---: |
| `apps/server/src/index.ts` | 25 | 13 |
| `apps/mobile/sources/buzz/x.ts` | 8 | 8 |
| Server plus mobile component | 27 | 15 |
| Server plus mobile budget/state paths | 29 | 17 |
| `docs/foo.md` | 34 | 3 |

The before workflow is commit `a829fb0a9`. Typecheck and shared-package tests remain mandatory for documentation PRs. Markdown in an app tree retains that tree's conservative module filter. Unknown non-documentation paths still run all suites.

The existing shared-package job prepares caches before its dependents start, avoiding another runner just for preparation. Four server runners replace sixteen: each runs a measured partition of the ordinary suite, followed by two of the original eight integration batches. The isolated claim-latency and PostgreSQL proofs retain their own runner and check context.

## Measured baseline

GitHub API observations collected on 2026-10-22:

| Existing run | Runner jobs | Wall clock including queues | Runner minutes |
| --- | ---: | ---: | ---: |
| [PR 2789, run 39818056049](https://github.com/Beeline-Work/beeline/actions/runs/39818056049) | 34 | 64.20 min | 84.77 min |
| [PR 2793, run 39819486388](https://github.com/Beeline-Work/beeline/actions/runs/39819486388) | 34 | 83.37 min | at least 84.02 min |
| [PR 2778, run 39816032959](https://github.com/Beeline-Work/beeline/actions/runs/39816032959) | 26 | 53.73 min | at least 63.73 min |

The latter two job responses omitted one completion timestamp each, so their compute figures are lower bounds. These PRs are examples of observed runs, not exact stand-ins for the synthetic path scenarios above.

In the complete PR 2789 run, root installation took 17–18 seconds per job; the common server build took 17 seconds; isolated mobile installation took 36–38 seconds. The mobile suite spent 588 seconds running tests. Consolidation primarily reduces queue demand and repeated setup; it does not make those test bodies five times faster.

## Completed hosted comparison

Collected on 2026-10-22 from the GitHub Actions jobs API (`GET /repos/Beeline-Work/beeline/actions/runs/{run_id}/jobs?per_page=100`) and `gh run view RUN_ID --log`. Both responses contained all jobs on one page. Wall clock is the last non-skipped job completion minus the earliest job creation; runner-minutes sum completion minus start for non-skipped jobs, without billing rounding. Skipped contexts are excluded from job counts.

| Completed Checks run | Non-skipped jobs | Wall clock including queues | Runner-minutes |
| --- | ---: | ---: | ---: |
| [Before: 39841099608](https://github.com/Beeline-Work/beeline/actions/runs/39841099608), `120a10703059` | 34 | 63.27 min | 81.38 min |
| [After: 39847340575](https://github.com/Beeline-Work/beeline/actions/runs/39847340575), `a9a75f0f6468` | 23 | 42.32 min | 77.13 min |

The baseline is the most recent successful pre-consolidation run in the fetched run history with both server and mobile suites active. The more recent successful run 39843894110 is mobile-only and cannot compare server execution. These are comparable broad mixed runs, not identical revisions or controlled benchmarks. The after run additionally executes MAC HELPER ACCEPTANCE, which the baseline skips; the server consolidation itself replaces sixteen runners with four. Observed wall clock fell by 33.1%, runner-minutes by 5.2%, and job count by 32.4%. Queue conditions, test revisions and the additional macOS lane prevent attributing all differences to this patch. This is not evidence of a fivefold speedup.

### Hosted test summaries

| Suite | Before | After |
| --- | ---: | ---: |
| Ordinary server, summed across shards | 3,295 passed + 14 skipped = 3,309 | 3,333 passed + 14 skipped = 3,347 |
| Integration, unique selected tests across eight batches | 245 passed | 245 passed |
| Dedicated PostgreSQL migration and claim checks | 12 + 3 + 3 passed | 12 + 3 + 3 passed |

Sources: the linked runs' server job logs, steps `Run the server suite shard` / `Run the balanced server suite shard`, and `Run the server integration shard` / `Run two bounded integration batches`. Ordinary baseline per-shard passed totals are 620, 486, 268, 481, 354, 239, 274, 573; after totals are 842, 568, 950, 973. Existing ordinary skips total fourteen in both runs. Integration batches select 31, 31, 31, 31, 31, 30, 30, 30 tests in each run. Vitest reports the other batches' cases as skipped in each process; those are intentionally unselected duplicates, not lost tests.

The ordinary hosted counts are **not identical**: the compared revisions differ in server tests (fourteen test files differ between these commits, including repository-link-success, corner lifecycle, operator System DM and service-review tests). The increase is thirty-eight passing tests; these cross-revision summaries alone do not prove exact same-revision coverage. A same-tree discovery check using the original workflow exclusions found 207 files; the union of all four new `run-ci-shard.mjs N/4 --list` invocations matched those 207 files exactly, with no duplicates or omissions. This proves file-selection parity on the after revision, not another hosted execution or identical historical test totals. Vitest `list --filesOnly` ignores `--shard`, so it was used only for the complete discovery set, not to claim eight individual historical assignments.

## Cache choice

Use Actions caches rather than a new build-artifact producer job. Dependencies are keyed by OS, Node major, lockfiles and manifests; mobile patches also invalidate the mobile cache. Compiled outputs and Turbo build records are keyed by exact workflow SHA, with no fallback to another commit. The existing shared-package gate populates these caches once before hosted Linux consumers restore them. macOS and on-demand production-host lanes keep their existing setup.

Local compression measurements on squire, with two zstd threads, produced a roughly 200 MiB root dependency archive in 8.66 seconds and decoded it in 0.91 seconds; the roughly 651 MiB mobile archive took 20.10 seconds to pack and 2.44 seconds to decode. These figures exclude upload/download and filesystem extraction. Hosted cache transfer time and end-to-end results must be measured from the new PR run before claiming a speedup.

## Coverage and validation

The ordinary server runner asks Vitest for its current files, excludes only the same three dedicated files as the previous workflow, partitions every discovered file exactly once, and verifies that Vitest selects exactly the assigned paths. Unknown files use the measured median duration. Deleted files do not remain in a fixed test manifest. Integration keeps all eight name-based batches in separate processes, including after a preceding batch fails, so consolidation does not combine their PGlite heaps.

Integration discovery verified 245 unique tests across the same eight batches (31, 31, 31, 31, 31, 30, 30, 30). The first batch passed its existing runner (31 passed, 214 intentionally unselected). All existing non-server test invocations remain in the workflow; the filter regression command gains the shard and workflow contract tests.

The full ordinary server run passed: 205 files, 3,291 discovered tests, 3,277 passed and 14 existing skips, with no failures. `apps/server/scripts/ci-test-timings.json` records each file's measured duration and the hosted integration-step measurements. The four new runner invocations with `--list` discovered and verified the exact assigned files: 50, 52, 51 and 52 files, disjoint and totaling the same 205. Their summed measured file durations are 722.286, 722.285, 722.285 and 722.284 seconds; these are workload weights, not hosted wall times, and each runner uses two workers. The paired integration batches add measured weights of 172, 148, 141 and 172 seconds respectively.

Local checks: root typecheck, workflow lint, workflow test-path lint, dead-code guard, workflow/filter/shard contract tests, the full ordinary server suite, and the existing integration batch runner. The new runner's execution smoke passed via `node scripts/run-ci-shard.mjs 16/16`: 15 passed files and one existing skipped file, 122 passed tests and three existing skips, in 124.85 seconds. Hosted CI exercises all four production partitions.

## Remaining evidence and authority

Completed hosted mixed-run measurements and test summaries are recorded above. The representative server-only and mobile-only job counts remain scheduling evaluations; matched hosted timing pairs for those scenarios have not been run. The brief's full same-revision timing and identical-test-count criteria are not claimed complete by this observational comparison.

**Scope 4: done as decided.** README PARITY, APP LINK ASSOCIATIONS and ACTIONLINT remain separate as Ruby directed. There is no REPO LINT job or branch-protection change. All required aggregate check names are preserved; only the runners under SERVER SUITE and SERVER INTEGRATION are consolidated. No check-name approval is requested.

The removed matrix contexts are SERVER SUITE SHARD 5–8 and SERVER INTEGRATION SHARD 1–8. SERVER SUITE SHARD 1–4, SERVER SUITE, SERVER INTEGRATION and SERVER CLAIM LATENCY remain. No release workflow changes are included.
