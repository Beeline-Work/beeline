# PR runner capacity

`.github/workflows/checks.yml` uses the isolated `beeline-ci` Linux pool for
credential-free PR work. Desktop, Mac helper acceptance, privileged Body setup,
PostgreSQL timing, Docker build/lint and production-corpus replay retain their
existing platform or hosted runners. Main pushes run full Checks on the same bounded pool, retaining hosted
privileged/timing jobs, and publish coverage from those server executions. Required check names stay stable.

## Routing and resource budget

All ten listeners are active. Instance `01` has one CPU and the
`beeline-ci-control` role for detection, cache preparation, selection and
verdicts. Instances `02`–`09` have the `beeline-ci-heavy` role for eight server
shards, shared tests, typecheck and companion checks, each capped at two CPUs / 8 GiB. Instance `10` has only the
`beeline-ci-workspace` role, capped at three CPUs / 12 GiB with CPUWeight 300.
It runs the mobile suite with two workers in its own job and checkout. The **parent
slice shares a ten-CPU hard quota across every listener and PR**, with
MemoryHigh 48 GiB / MemoryMax 60 GiB; per-service maxima are not additive
capacity. Ordinary listeners have MemoryHigh 6 GiB, the workspace listener
10 GiB. Verify both service and parent limits before activation.

| Checks work | Pull requests | Merge groups / manual dispatch |
| --- | --- | --- |
| Eight server shards, shared tests, TYPECHECK | `beeline-ci, beeline-ci-heavy` (02–09) | `ubuntu-latest` |
| Dead-code, fingerprint and export | `beeline-ci, beeline-ci-heavy` (02–09) | Same bounded heavy pool |
| Mobile suite execution | `beeline-ci, beeline-ci-workspace` (10) | `ubuntu-latest` |
| Detection, preparation, selection, required verdicts, README, app associations | `beeline-ci, beeline-ci-control` (01) | `ubuntu-latest` |
| Privileged Body setup, PostgreSQL timing, Docker build/lint, corpus replay | `ubuntu-latest` | `ubuntu-latest` |

Each server shard runs its balanced file assignment and one of the existing
eight integration batches. Held voice playback and durable socket replay run
in fresh worker processes. On PRs, width, room-read latency and completion
latency budgets run with one worker in the existing hosted PRODUCTION-CORPUS
REPLAY job, outside the shared quota. A shard moves
them only when that required hosted gate is enabled; merge/dispatch runs
retain isolated shard coverage. Socket replay retains all 300 messages,
ordering/deduplication checks and its original deadlines. Completion tracing
matches the exact real pre-query clock read rather than requiring two clock
observations within ten milliseconds; its 500 ms budget stays unchanged.
The feedback-triage scope fixture keeps seven external workspaces and 201
internal messages (more than its 200-row page), preserving receipt and privacy
assertions without seeding 29,650 unrelated internal messages. Its original
job consumed 13m34s in this file and timed out during integration; the smaller
fixture removes that setup bottleneck without raising a deadline.
PRs consume SELECT SERVER TESTS; an unavailable selection fails closed to the
full suite. Main coverage remains full. No integration batch is removed or
repeated.

Ordinary server files use Vitest's single-fork mode with module isolation;
eight smaller shards recover parallelism while amortizing process startup.
A regression checks module/mock resets and process reuse. Mobile retains two
separate per-file workers: grouping mobile files exposed state held by native
storage mocks despite module resets. Other Vitest commands use at most two
workers, control jobs use one, and timing/integration tests retain one.
Node test-file concurrency, Turbo tasks, libuv and Metro are also bounded.
Server setup yields to Node's real event loop between tests: PGlite query
chains otherwise starve worker IPC long enough to expire Vitest progress
RPCs under the shared quota. `scripts/ci-shards.test.mjs` exercises this with
microtask-only tests and fake timers; RPC deadlines and error reporting stay
unchanged.

The temporary migrated database template is an uncompressed tar image, shared
immutably within each worker by its unique run path. Every test database still
has its own PGlite filesystem and mutable state. Eight feature fixtures also
clone that schema instead of rerunning migrations before every case; explicit
migration and backfill proofs still run their migrations. Object-service
fixtures close each database after the test. The snapshot helper retains gzip
as its default for persisted callers. Snapshot round-trip tests cover both
formats, independent copies and rollback. Large read-history fixtures
keep their rows and query-plan assertions while avoiding unrelated write
fanout during bulk seeding; foreign keys remain active and hooks resume
before the behavior under test.

Main records function coverage for ordinary server tests. Corpus/latency
budgets, isolated socket/timer suites (including wake-inbox), and monolith
integration batches run without V8 coverage. Instrumentation otherwise slows
budgeted reads and disables the shared database template inside the existing
hook deadline. These files still run with their original assertions and
budgets; without map entries the server selector always includes them.

The workflow suite is split across four files with a shared per-file fixture.
All 170 test names and the original test blocks are retained. Scheduling
weights use the latest observed CI profile; source revision and measurement
time are recorded with the weights. The balancer reserves each
shard's isolated-suite and integration-batch cost before assigning its
ordinary files.

The required TYPECHECK job executes root typecheck and its policy guards.
MOBILE SUITE, DEAD CODE, NATIVE FINGERPRINT and MOBILE-EXPORT REACHABILITY
execute in separate jobs and checkouts on existing bounded listeners. Their
assertions, policy conditions and execution caps remain intact; slow native
work and export no longer serialize behind compiler work. Shared-package
tests also use heavy listeners, leaving control available for preparation and
verdicts. No concurrent jobs mutate one working tree. Browser entries stay in
the OS temporary directory, outside compiler globs. Commands remain in
`scripts/ci-workspace-tasks.sh`; trusted-base architecture/phone/UI checks
remain mandatory, and root typecheck already checks mobile once.

Preparation installs/builds once. Dependencies remain lockfile/manifest keyed.
The separate input-addressed `.turbo/cache` restores deterministic build and
typecheck tasks across commits; test-result caching is disabled. Root compiler
configuration and the external usebeeline builder participate in task hashes.
Mobile compiler incremental state is restored separately; the compiler still
executes and checks current inputs. Job-specific cache writes let completed
typecheck tasks publish after the same head's producer has finished.

Final compiled outputs use the v3 exact-SHA archive, with no foreign-head
fallback. `scripts/ci-build-provenance.mjs` verifies the checked-out SHA, Node
major and hashes of every compiled file, rejecting missing, extra or changed
outputs. API exports are checked before publication. Missing exact-head
archives rebuild with one Turbo task at a time. Consumers require successful
shared preparation, but cache eviction after that success recovers through
lockfile-based `npm ci --prefer-offline`. Cold installs share a kernel file lock
on squire, retain one install worker and the existing runner/pool limits, and
propagate installation failures. Warm consumers keep restoring dependencies.
The selector caches its pinned standalone TypeScript instead of restoring an entire compiled workspace.

`scripts/workspace-test-selection.mjs` discovers the actual Vitest entries
and follows reverse imports across workspace boundaries, including source in
browser-proof strings. Public workspace exports conservatively depend on
provider source; source scanners and opaque/dynamic loaders remain selected.
Shared contracts, migrations, configuration, added production inputs,
deletions, renames and unknown inputs fall back to full suites. Newly
discovered regression tests always run. Unknown asset/data reads also fall back.
Required frame/storage proofs are included when their original gates run.
Per-group selections carry the exact head; missing, malformed, foreign-head
or unknown-file selections execute full suites. Native fingerprint retains
its existing isolated coverage and conditions. TYPECHECK and SHARED PACKAGE
TESTS still execute on every PR.

The existing coverage-map server selector remains authoritative for server
files and always-running source readers. Body and mobile use the workspace
file graph. Main pushes share one active full run and one pending slot through
[GitHub workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
New pending pushes replace older pending pushes; active runs finish their
checks and coverage publication. Ordinary server jobs produce the next map
after all server and corpus checks pass. Timing suites remain uninstrumented;
the on-demand workflow does not duplicate automatic main work.

The existing Nightly Checks reporter consumes completed main runs and reports
failures immediately to the existing fix-loop label without rerunning them.
It ignores a cancelled run only when no attempt acquired a runner and a newer
main push of the same workflow exists. Started or unverified cancellations
remain reportable. Its hosted route and permissions stay the same;
PR/foreign-branch events cannot publish main issues.

All CI-only workspace jobs prepend `.github/actions/ci-workspace/bin` to PATH.
Its tar wrapper serializes only cache archives through the CI user's shared
file lock; normal archives/probes bypass it. Compression uses one zstd worker.
Cancellation releases the kernel lock. No service is added.

Corpus replay stays hosted because cold setup exceeded ten minutes on squire.
The corpus cache is published immediately after a successful replay. After
landing, an on-demand replay dispatched on main also runs hosted and warms the
default-branch corpus cache for later PRs. Schema/corpus source changes still
invalidate it; a cache hit never substitutes for executing the timing tests.

## Current measurement and remaining acceptance

The previous five-listener / four-server-shard trial completed Linux work in
34m14s, with max sampled CI usage 8.01 CPUs / 21.26 GiB and no hard-limit/OOM or
helper restart. The final shard waited 15m08s, restored its workspace in 8s,
then ran balanced tests for 13m21s and integration for 1m58s. Individual server
shards were balanced at 15m40s–17m05s; late admission dominated the final shard.
Hosted Body also waited 15m32s. Replay alone exceeded its ten-minute limit.
The full per-job queue/setup/work breakdown is recorded in
[the optimization PR](https://github.com/Beeline-Work/beeline/pull/3344).

A bounded five-file server probe passed 40 tests in both fork modes. Grouping
reduced CPU time from 71.6s to 60.7s (about 15%); one grouped worker took longer
than two, motivating smaller parallel shards. This is a probe, not a passing
end-to-end performance result. A later eight-shard consolidation run completed
Linux checks in 24m22s, with two progress-RPC failures and a stale fingerprint
workflow assertion. Its maximum sampled CI memory was 36.95 GiB, with no hard
memory-limit/OOM events or helper restarts. The accepted initial landing target
was approximately 24 minutes at ten CPUs. The
[initial passing run](https://github.com/Beeline-Work/beeline/actions/runs/41523839846)
completed in 27m20s with a 37.04 GiB sampled memory peak, no OOM or helper
restart, and all 41 PR-head checks green. Firstmate accepted that delivery.
The [first follow-up trial](https://github.com/Beeline-Work/beeline/actions/runs/41539926797)
passed all 41 head checks in 38m12s under overlapping real CI runs. Server jobs
waited as much as 17m03s for a listener; shard five then executed in 15m44s,
including 7m09s for its largest file, instead of timing out. Approximate
per-job CI CPU attribution was 178.02 CPU-minutes; total pool work was 381.11
CPU-minutes because it includes the other runs. Sampled pool memory peaked at
38.38 GiB, available host memory stayed above 74.37 GiB, and no OOM or helper
restart occurred. Whole-host one-minute load reached 33.89. There was no local
profiling during this trial.

The [second trial](https://github.com/Beeline-Work/beeline/actions/runs/41546769663)
completed in 27m42s with 177.38 attributed CPU-minutes and no OOM or helper
restart. Its completion-trace clock-gap assertion and durable socket replay
wait failed. Neither file used the changed history/schema-clone fixtures.
The trace test now compares the exact real pre-query clock read, preserving
its 500 ms budget and transaction assertions. Socket replay runs in a fresh
worker; all 300 rows, ordering/deduplication assertions and deadlines remain.
Weights account for this reserved work before distributing ordinary files.

The [merged cache/deadline repair run](https://github.com/Beeline-Work/beeline/actions/runs/41565883259)
passed before this follow-up was integrated. Its feedback setup reduction
brought shard five below the job limit at 17m09s. All Linux work completed in
40m34s under overlapping CI; three other shards still exceeded twenty minutes
(longest 25m12s), motivating the measured rebalance here. Attributed work was
197.96 CPU-minutes; the shared pool peaked at 37.37 GiB, with no OOM or helper
restart. This is a reliability result, not a demonstrated pipeline speedup.

The [integrated reliability run](https://github.com/Beeline-Work/beeline/actions/runs/41570674167)
passed all 41 head contexts, including Mac helper and desktop builds. Server
jobs took 17m43s–20m08s (eight seconds above the twenty-minute target), while
Linux wall time was 89m46s amid severe multi-PR queueing. Attributed work was
201.33 CPU-minutes; shared-pool work including other runs was 872.60 CPU-minutes.
Peak sampled pool memory was 43.54 GiB, with no OOM or helper restart. Detection
waited 13m43s; mobile waited 40m14s, and verdicts waited another 8–12 minutes.
These are prior-head reliability measurements, not selective-policy results.
A separate repaired-head PR still reproduced durable-replay `frames: 0`;
process isolation alone does not prove that flake fixed.

The captain's current target is as close to ten minutes per PR as practical,
with no additional paid runners or pool expansion and no weakened assertions.
Measure real server-only, mobile-only and shared-contract PR shapes after the
policy lands. A full-contract workload of roughly 201 attributed CPU-minutes
cannot finish in ten minutes on ten CPUs before further work reduction; queue
and serial costs add to that bound. Keep estimates distinct from measured
passing runs and report the remaining gap. Main full-suite demand also shares
the same pool and must be included when describing contention.

Whole-host load includes independent Beeline agents, Gradle and emulators;
record it as context. Abort trials on CI budget violations, sustained memory
pressure/OOM or a helper watchdog event. Earlier load-15 and load-25 aborts
were superseded by this CI-pool policy. See
[`infra/ci/README.md`](../infra/ci/README.md) for activation and measurement.

## CI-only host isolation

The original 2026-10-31 setup authorized ten repository runners on `squire`, named
`beeline-ci-squire-01` through `beeline-ci-squire-10`, with only the default
`self-hosted, Linux, X64` labels plus `beeline-ci`. Existing release runners,
their labels, and their services were not changed.

The Linux user `beeline-ci` has no supplementary groups, a non-login shell,
and a mode-0700 home at `/var/lib/beeline-ci`. It has no sudo or Docker
membership. A named-user ACL denies traversal of `/home/lunchbox`;
`/home/beeline-runner` already denies this user access.

Each runner has its own persistent directory and systemd unit:

- `/var/lib/beeline-ci/runner-01` through `runner-10`, each with `_work` and
  `_tool`; npm uses the CI user's persistent home cache.
- `/etc/systemd/system/beeline-ci@.service`, instances `01` through `10`.
- The original `/etc/systemd/system/beeline-ci.slice` bounded the pool to 80 GiB, with
  reclaim pressure at 64 GiB, CPU weight 25, and a shared 16-CPU quota on the
  20-CPU host. Each service originally had a 10 GiB memory limit and could use idle CPUs
  within that shared budget. These limits apply only to the new pool.

The services start with `env -i` and only the CI home, system binary path,
locale and per-runner tool-cache path. They run with no capabilities and
`NoNewPrivileges`, a read-only host filesystem, private temporary directories
and devices, and an invisible view of other users' processes. Home directories
and unlisted deployment directories are inaccessible. `/etc`, `/var`, `/run`
and `/opt` are replaced by private filesystems; only the CI home, the public
Chrome package at `/opt/google/chrome`, and an explicit allowlist of public
identity, DNS, dynamic-loader, command-alternative, font and TLS trust files
are mounted back. Chrome and font configuration are read-only; `/opt` exposes
no other installed application. Preserve `/etc/alternatives` read-only: Ubuntu's
`/usr/bin/awk` resolves through it, and the mobile canary's stubbed readiness
tests need that standard command. Masking it made those fixtures poll instead
of parsing adb output. With the command links available, the isolated
`mobileOtaRelease.test.ts` fixture passes all 29 tests in about seven seconds.
Browser proofs need the Chrome package and `/etc/fonts`; hiding the package
breaks `/usr/bin/google-chrome` even though that command lives under `/usr/bin`.
The corrected namespace passes the three `error-rows.browser.test.ts` browser
proofs. Browser profiles and temporary files stay inside CI-owned storage.
Host environment files, systemd units, production credential directories and
the Docker socket are absent from the runner's filesystem view.

Verification entered a running service's mount namespace as the CI UID with
no groups or capabilities. Reads of both production homes, `/root`, `/srv`,
`/etc/environment`, `/etc/systemd/system`, `/var/lib/private`, and the Docker
socket were denied; private `/opt` exposes only the public Chrome package.
All ten actual listener environments were checked
by variable name and contained no token, secret, password or credential
variables. No production credential values were read or copied.

Do not add this label to an existing release runner or grant this user access
to deployment credentials. Runner registration and host configuration require
the owner's authorization. Keep ordinary PR code changes confined to workflow
routing; do not modify existing release services to obtain more capacity.

## Why the earlier local-only pool was slower

The 2026-10-26 Actions history query covers 34 Checks runs created between
13:43:36 and 20:19:12 UTC. Among those runs, 153 successful jobs used the old
`beeline-ci-shard-1` through `beeline-ci-shard-4` pool. Their observed maximum
concurrency was four.

| Successful local work | Jobs | Median queue | Maximum queue | Median execution |
| --- | ---: | ---: | ---: | ---: |
| Detect changes | 31 | 29m59s | 72m43s | 6s |
| Shared package preparation/tests | 31 | 25m51s | 65m19s | 1m49s |
| Server shards | 61 | 51m30s | 133m22s | 12m39s |
| Claim latency | 18 | 42m41.5s | 88m22s | 2m6.5s |
| Server verdict | 12 | 12m50.5s | 69m28s | 3s |

Within successful local server shards, workspace setup took a median 11s
(range 9–42s), balanced tests 9m16s, and the integration batches 2m45s.
Preparation's workspace setup took a median 51s (44–74s). The composite-step
timing includes dependency/build cache restore or installation; it does not
separate npm install from the other setup operations. Detailed logs for the
16:27 example below show a cold preparation with root `npm ci` taking 9.5s,
workspace build 15.8s, and mobile `npm ci` 19.4s. Its server shard restored the
198 MiB dependency cache in about 6.1s and the 6 MiB exact-commit build cache
in about 0.9s; both npm installs were skipped. These are individual log
measurements, not medians over the entire sample.

A later sample of 15 Checks runs created between 21:00 and 23:59 UTC had 38
successful hosted server shards: median queue 19.5s and execution 13m53s.
Thus queue saturation, including queues for six-second detection and
three-second verdict jobs, explains the regression visible in this sample.
The old pool was not slower at executing the median shard. Actions history
does not contain CPU utilization or throttling counters, so it cannot prove
CPU contention. The new pool exposes systemd CPU/memory accounting for future
measurements.

An initial provisioning trial demonstrated why CPU limits belong on the
pool rather than each service: with the host 74% idle, one server job hit
its two-CPU quota in 7,822 of 9,213 periods and accumulated 706s of throttling.
That trial's final configuration removed those per-service caps, retained the pool's
low scheduling weight, and caps the whole pool at 16 CPUs. Test worker counts
remain bounded. The trial was superseded before recording a final full-run
comparison, so that comparison uses the final resource policy throughout.

Example: [the 16:27 local run](https://github.com/Beeline-Work/beeline/actions/runs/40359272561)
waited until 17:32:37 to start shared package preparation, then its first server
shard started at 18:06:53. Its last shard finished at 18:49:54, but the final
three-second server verdict waited until 19:15:19.

These historical samples use different source revisions and traffic levels;
they explain the bottleneck rather than establish a controlled speedup.

## Validation measurements

The completed hosted baseline is
[Checks, 45m49s](https://github.com/Beeline-Work/beeline/actions/runs/41248600918)
and [Desktop, 23m45s](https://github.com/Beeline-Work/beeline/actions/runs/41248600874),
both successful. The checked-out PR merge was
`30c235ee5d66cd398779f0938e1e45845b467179`; compared with this task's base
`7ab8ed06588c26801466b33964a74111d107f9ba`, server, Body, shared-package and CI
workflow sources are identical. Only mobile UI changes differ. Treat overall
timings as an observational comparison: source differences, cache warmth,
runner assignment and repository traffic prevent a controlled speedup claim.

The mixed-pool comparison is recorded in the pull request with run URLs,
end-to-end wall time, per-job queue/execution time and runner names. A fresh
hosted-only run on that PR also supplied supersession evidence: after more
than 27 minutes, eleven Linux jobs were still queued, and the new push
cancelled the old run. That cancelled run is queue/cancellation evidence,
not a completed baseline measurement.

For a completed job while its workflow still runs, fetch its log directly with
`gh-axi api repos/Beeline-Work/beeline/actions/jobs/JOB_ID/logs --full`.
`gh-axi run view --log` waits for the entire workflow to finish.
