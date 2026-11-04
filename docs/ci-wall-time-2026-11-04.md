# Checks wall time investigation — 2026-11-04

Target: all required PR checks finish within **15 minutes of push**, over the
first ten PR runs carrying this fix under the real concurrent workload. This
report does **not** claim that target has been met.

## Measured baseline

The Actions API returned 191 Checks runs for November 4. Job inventories were
collected for 63 runs: every successful run that day and every run created
since 18:00 UTC. Successful-job timings are deliberately separate from queue
observations and incomplete runs. This is a runtime-sizing sample, not an
unbiased estimate of PR success rate. The checked-in
[summary](../data/ci/wall-time-2026-11-04.json) retains the run IDs, sample counts,
empirical p99 values and collection policy. Latest-attempt job snapshots can
contain start timestamps earlier than job creation; negative queue observations
are excluded rather than reported as negative wait.

| Observation | Before |
| --- | ---: |
| Hosted job queue p99 / maximum | 41.92 / 50.80 minutes |
| Squire job queue p99 / maximum | 19.43 / 19.47 minutes |
| Materialized PR selectors since 19:00 UTC | 13 skipped, 1 cancelled |
| Successful full server shard maximum | 26.07 minutes |
| Successful mobile suite maximum | 19.10 minutes |
| Successful PR completions created after 19:00 at collection | 1 |

The [completed PR run](https://github.com/Beeline-Work/beeline/actions/runs/41893349697)
took 15.13 minutes from creation through its last non-skipped job. Its
preparation log says `Workspace selection: full; Added production input,
deleted or renamed input`; SELECT SERVER TESTS then skipped. The server
coverage selector was gated on the Body/mobile dependency graph returning a
subset, even though the server selector has its own conservative full-suite
fallbacks. The code PR selector now runs independently and in parallel with
workspace preparation.

Cancellation was already enabled in current main and in a queued branch's
actual workflow revision. The [superseded run](https://github.com/Beeline-Work/beeline/actions/runs/41899018716)
was cancelled. The patch preserves that policy and its regression test. A new
push does not need a new cancellation mechanism; old branch workflows and
runner cleanup must be distinguished from a missing cancellation setting.

## Changes and limits

| Area | Before | Candidate |
| --- | --- | --- |
| Server selection | Disabled by another selector's full fallback; waits for preparation | Every code PR runs its own coverage selector alongside preparation; missing/unsafe maps still run full |
| Squire nominal CPU demand | 8 heavy × 2 + control 1 + mobile 3 = 20 CPUs under a 10-CPU parent cap | 6 heavy × 1 + control 1 + mobile 3 = 10 CPUs |
| Active listeners | 01–10 | 01–07 and 10; 08/09 drained and disabled |
| Runner admission | Generic CI/role labels | Additional `beeline-ci-balanced` label, exact roster and role validation |
| Push supersession | PR cancellation enabled, main runs independent | Preserved and verified |
| Required checks | Existing IDs, names and assertions | Identical; no new gate |

The resource sum and roster exclusion are regression-tested. Host limits and
labels have **not** been applied by this worktree-only task. Activation must
follow [the existing host-authorized procedure](../infra/ci/README.md). Until
then, unconverted listeners lack the balanced label and the planner uses
hosted fallback. Code review alone is not a throughput measurement.

Reduced timeouts use the successful-job empirical p99 plus two minutes,
rounded up. With fewer than 100 samples for a job, this empirical p99 is its
observed maximum; it is not a statistical guarantee about future runs.

| Job | Observed p99 (minutes) | New limit (minutes) |
| --- | ---: | ---: |
| Prepare workspace caches | 4.10 | 7 |
| TYPECHECK | 12.48 | 15 |
| SHARED PACKAGE TESTS | 5.40 | 8 |
| DEAD CODE | 5.88 | 8 |
| BODY SUITE | 8.27 | 11 |
| SELECT SERVER TESTS | 3.27 | 6 |
| SERVER SUITE SHARD 1–8 | 18.22 / 24.43 / 26.07 / 18.12 / 18.85 / 20.42 / 18.45 / 15.78 | 21 / 27 / 29 / 21 / 21 / 23 / 21 / 18 |
| SERVER CLAIM LATENCY | 9.88 | 12 |
| MOBILE SUITE | 19.10 | 22 |
| MOBILE-EXPORT REACHABILITY | 6.28 | 9 |
| NATIVE FINGERPRINT | 8.33 | 11 |
| PRODUCTION-CORPUS REPLAY | 11.65 | 14 |
| ACTIONLINT | 2.02 | 5 |
| Build auth container | 9.95 | 12 |

Timeouts bound hung work; they do not make a full suite finish in 15 minutes.
Full-contract, configuration, missing-map and otherwise unprovable selections
retain the full suite. Their observed runtime already exceeds the target.
Actual acceptance depends on less repeated work and the measured rollout;
no assertion or conservative selector fallback was removed to claim success.

## After measurement

The local regression proves that a PR with a Body/mobile `full` selection
still runs the independent server selector. Required job IDs/names and the
cancellation policy match the base workflow. Resource accounting proves the
candidate's active service maxima sum to ten CPUs. These are structural
before/after results; production wall-time results remain pending.

After merge and host activation, run:

```sh
node scripts/ci-wall-time.mjs --since <merge-time-ISO> --contains <full-merge-SHA> --limit 10
```

This read-only report uses the Actions API through `gh-axi`. It selects the
first ten PR runs whose head contains the fix, measures original run creation
to the last check (including queue and rerun delay), and separates job/pool
queue and successful runtime percentiles. Failed, cancelled, pending,
skipped-only and undersampled cohorts cannot pass. Old branch workflow
revisions are excluded by ancestry. The tool exits for API/data errors rather
than claiming a fast run from incomplete evidence. It is not a CI gate.

A baseline invocation against current main sampled ten PR runs since 19:00 UTC:
**0/10 were green within 15 minutes** at 20:13:48 UTC. Several were still queued
or running, so their elapsed times are lower bounds. The same report must be
retained for the first ten eligible runs after rollout before declaring the
performance target complete.
