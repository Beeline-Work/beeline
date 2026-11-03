# Squire CI budget

These drop-ins change resource accounting only. Preserve the existing
credential-free `beeline-ci` user, mount namespace, runner labels and all
release/production services. There is no new service or workflow gate.

The pool has ten active listeners and one job per listener. Instance 01 has
one CPU for control work. Instances 02–09 have two CPUs / 8 GiB for server
shards, shared-package tests, TYPECHECK and independent companion checks. Instance 10 has three CPUs / 12 GiB
and CPUWeight 300 for MOBILE SUITE. Each job owns its checkout; parallel checks
never share a mutable working tree. The slice shares `CPUQuota=1000%` / `MemoryMax=60G` across all
listeners; individual maxima are not additive capacity. Limits cover every
child process. Existing credential isolation and production/release services
are preserved. The cache tar wrapper uses a shared file lock; no service is added.

## Activation order

1. Wait for the separate server integration-test memory fix to merge, then
   rebase the CI branch on main. Do not restore the runners against the
   leaking integration suite.
2. With the CI listeners still stopped, install `beeline-ci@.service.d/50-budget.conf`
   `beeline-ci.slice.d/50-budget.conf`, and the instance-specific
   `beeline-ci@01.service.d/60-control-budget.conf` and
   `beeline-ci@10.service.d/60-workspace-budget.conf` beneath `/etc/systemd/system/`.
   Run `systemctl daemon-reload`. Installation requires host-write authority;
   a worktree-only worker can prepare these files but cannot apply them.
3. Verify `systemctl show beeline-ci.slice` reports a ten-CPU quota, 48 GiB
   MemoryHigh and 60 GiB MemoryMax. Verify every instance 01 through 10 has
   a two-CPU quota (one CPU for 01), 6 GiB MemoryHigh, 8 GiB MemoryMax and
   the correct slice. Instance 10 overrides this to three CPUs, CPUWeight 300,
   MemoryHigh 10 GiB / MemoryMax 12 GiB.
   Existing resource drop-ins must not override these values. Verify the
   parent slice does not impose an unexpected tighter limit.
4. Enable/start `beeline-ci@01.service` through `beeline-ci@10.service`. Confirm
   names remain `beeline-ci-squire-01` through `-10`, with the `beeline-ci`
   label. Verify ten are online and the parent quota remains ten CPUs. Instance 01
   also has `beeline-ci-control`; 02–09 have `beeline-ci-heavy`; 10 has
   `beeline-ci-workspace` and must not also have the heavy role. PR gates select
   those roles explicitly so preparation cannot queue behind long suites.
5. Run a monitored real-PR trial. Firstmate accepted the initial rollout at
   27m20s; the follow-up targets reliable green checks and server shards at or
   below twenty minutes while CI stays inside the same pool. Firstmate controls landing; subsequent three-PR proof uses real PRs carrying
   this routing and the leak fix. An older PR head still runs its own old workflow;
   rerunning it does not test the new routing. Coordinate those heads with
   their owners, without rewriting another worker's branch.

## Measurement and abort

Before the load test, record `uptime`, available memory, active listener count
and effective service/slice limits. Capture load and memory at least every
five seconds throughout all three runs. Use `systemctl show beeline-ci.slice
-p ControlGroup --value` to locate the live cgroup instead of assuming its
path. Record its `memory.current`, `memory.peak`, `memory.events`, `cpu.stat`
and `cpu.max`, and each listener's resource counters. Record a host idle
baseline separately because Beeline agents contribute to whole-host load.

Record host load as context: Beeline agents, Gradle and emulators contribute
independently of CI, so host load alone does not trigger cancellation. Abort
validation if CI exceeds its ten-CPU/60-GiB pool budget, sustained memory
pressure or an OOM appears, or the `beeline-helper` user-service watchdog fires.
Capture `memory.pressure`, available host memory, OOM counters and the helper
service result/restart count alongside pool usage. Cancel only the recorded
run IDs using `gh-axi run cancel RUN_ID` and keep sampling until work drains.
Do not stop or restart Beeline agents or the shared no-mistakes daemon. If the
pool does not drain after cancellation, report the condition to firstmate.

For each run, retain its URL, PR head, creation time, Linux job start/finish
and runner names using `gh-axi api repos/Beeline-Work/beeline/actions/runs/RUN_ID/jobs?per_page=100`.
Compute required Linux wall time from run creation to the last required Linux
completion, including hosted preparation, queue time and verdicts; report Mac
helper and desktop timings separately. A failed or cancelled run is not a
passing timing result. Report maximum sampled whole-host one-minute load,
minimum available memory, peak pool memory and OOM/throttling deltas.

The follow-up targets each server shard at or below twenty minutes, with CI
pool usage inside ten CPUs and 60 GiB and no OOM kills. Report measured per-PR
wall time, remaining unexplained failures and concurrent workload. The captain now targets as close to ten minutes per PR as possible through
selection and cache/setup reuse, with no additional paid runners. Host load is context; it is not the CI CPU
budget. A ten-CPU quota alone does not prove wall-time capacity.
Confirm required check names against the base workflow and verify main's
required checks remain green. Record actual after measurements in the PR;
leave unmeasured claims explicitly pending.
