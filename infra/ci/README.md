# Squire CI budget

These drop-ins change resource accounting only. Preserve the existing
credential-free `beeline-ci` user, mount namespace, runner labels and all
release/production services. There is no new service or workflow gate.

The pool has ten registered listeners, five active at a time and one job per
active listener. Each service has `CPUQuota=200%` and `MemoryMax=8G`; the slice
has `CPUQuota=1000%` and `MemoryMax=60G`. Limits cover all children, including
test subprocesses. Vitest uses two workers per job. The CI workspace action
serializes cache tar operations using a shared file lock; no service is added.

## Activation order

1. Wait for the separate server integration-test memory fix to merge, then
   rebase the CI branch on main. Do not restore the runners against the
   leaking integration suite.
2. With the CI listeners still stopped, install `beeline-ci@.service.d/50-budget.conf`
   and `beeline-ci.slice.d/50-budget.conf` beneath `/etc/systemd/system/`.
   Run `systemctl daemon-reload`. Installation requires host-write authority;
   a worktree-only worker can prepare these files but cannot apply them.
3. Verify `systemctl show beeline-ci.slice` reports a ten-CPU quota, 48 GiB
   MemoryHigh and 60 GiB MemoryMax. Verify every instance 01 through 10 has
   a two-CPU quota, 6 GiB MemoryHigh, 8 GiB MemoryMax and the correct slice.
   Existing resource drop-ins must not override these values. Verify the
   parent slice does not impose an unexpected tighter limit.
4. Enable/start only `beeline-ci@01.service` through `beeline-ci@05.service`.
   Keep `06` through `10` stopped and disabled, retaining their registrations
   and labels as standby. Confirm all names remain `beeline-ci-squire-01`
   through `-10`, with the `beeline-ci` label. Verify exactly five are online;
   never start the standby instances to compensate for queues.
5. Run one monitored single-PR trial first. After a safe trial, firstmate
   lands the CI change; the three-PR proof uses the next real PRs carrying
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

Use host load only as a safety backstop: Beeline agents, Gradle and emulators
contribute independently of CI. Abort validation immediately when one-minute
host load exceeds 25: cancel only the three recorded run IDs using `gh-axi run cancel RUN_ID`.
Keep sampling until their work drains. Do not stop or restart Beeline agents
or the shared no-mistakes daemon. If the pool does not drain after cancellation,
report the condition to firstmate for intervention.

For each run, retain its URL, PR head, creation time, Linux job start/finish
and runner names using `gh-axi api repos/Beeline-Work/beeline/actions/runs/RUN_ID/jobs?per_page=100`.
Compute required Linux wall time from run creation to the last required Linux
completion, including hosted preparation, queue time and verdicts; report Mac
helper and desktop timings separately. A failed or cancelled run is not a
passing timing result. Report maximum sampled whole-host one-minute load,
minimum available memory, peak pool memory and OOM/throttling deltas.

Accept only three overlapping successful PR runs each at or below 15 minutes,
with CI pool usage inside ten CPUs and 60 GiB and no OOM kills. Report host
load as context; it is not the CI CPU budget. A ten-CPU quota alone does not
prove the wall-time target.
Confirm required check names against the base workflow and verify main's
required checks remain green. Record actual after measurements in the PR;
leave unmeasured claims explicitly pending.
