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

## Cache choice

Use Actions caches rather than a new build-artifact producer job. Dependencies are keyed by OS, Node major, lockfiles and manifests; mobile patches also invalidate the mobile cache. Compiled outputs and Turbo build records are keyed by exact workflow SHA, with no fallback to another commit. The existing shared-package gate populates these caches once before hosted Linux consumers restore them. macOS and on-demand production-host lanes keep their existing setup.

Local compression measurements on squire, with two zstd threads, produced a roughly 200 MiB root dependency archive in 8.66 seconds and decoded it in 0.91 seconds; the roughly 651 MiB mobile archive took 20.10 seconds to pack and 2.44 seconds to decode. These figures exclude upload/download and filesystem extraction. Hosted cache transfer time and end-to-end results must be measured from the new PR run before claiming a speedup.

## Coverage and validation

The ordinary server runner asks Vitest for its current files, excludes only the same three dedicated files as the previous workflow, partitions every discovered file exactly once, and verifies that Vitest selects exactly the assigned paths. Unknown files use the measured median duration. Deleted files do not remain in a fixed test manifest. Integration keeps all eight name-based batches in separate processes, including after a preceding batch fails, so consolidation does not combine their PGlite heaps.

Integration discovery verified 245 unique tests across the same eight batches (31, 31, 31, 31, 31, 30, 30, 30). The first batch passed its existing runner (31 passed, 214 intentionally unselected). All existing non-server test invocations remain in the workflow; the filter regression command gains the shard and workflow contract tests.

The full ordinary server run passed: 205 files, 3,291 discovered tests, 3,277 passed and 14 existing skips, with no failures. `apps/server/scripts/ci-test-timings.json` records each file's measured duration and the hosted integration-step measurements. The four new runner invocations with `--list` discovered and verified the exact assigned files: 50, 52, 51 and 52 files, disjoint and totaling the same 205. Their summed measured file durations are 722.286, 722.285, 722.285 and 722.284 seconds; these are workload weights, not hosted wall times, and each runner uses two workers. The paired integration batches add measured weights of 172, 148, 141 and 172 seconds respectively.

Local checks: root typecheck, workflow lint, workflow test-path lint, dead-code guard, workflow/filter/shard contract tests, the full ordinary server suite, and the existing integration batch runner. The new runner's execution smoke passed via `node scripts/run-ci-shard.mjs 16/16`: 15 passed files and one existing skipped file, 122 passed tests and three existing skips, in 124.85 seconds. Hosted CI exercises all four production partitions.

## Remaining evidence and authority

Hosted results for the new workflow are pending. The job-count table is an evaluated scheduling result, not a measured wall-clock or compute speedup. Before/after hosted timings for the same server, mobile and mixed revisions remain required to finish the brief.

README PARITY, APP LINK ASSOCIATIONS and ACTIONLINT remain separate as Ruby directed. All required aggregate check names are preserved; only the runners under SERVER SUITE and SERVER INTEGRATION are consolidated. No branch-protection change or check-name approval is requested.

The removed matrix contexts are SERVER SUITE SHARD 5–8 and SERVER INTEGRATION SHARD 1–8. SERVER SUITE SHARD 1–4, SERVER SUITE, SERVER INTEGRATION and SERVER CLAIM LATENCY remain. No release workflow changes are included.
