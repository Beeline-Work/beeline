# Squire CI budget

These drop-ins change resource accounting only. Preserve the existing
credential-free `beeline-ci` user, mount namespace, runner labels and all
release/production services. There is no new service or workflow gate.

The balanced pool has eight active listeners: 01 for one-CPU control work,
02–07 for six one-CPU heavy jobs, and 10 for the three-CPU mobile suite.
Their maxima sum to the existing `CPUQuota=1000%`; `MemoryMax=60G` is unchanged.
The other ten cores of the 20-core host remain available to agent work.
Listeners 08 and 09 are drained and disabled. Existing isolation, checkout
ownership and cache locking remain intact.

The additional `beeline-ci-balanced` label is a rollout boundary. Workflows
require it as well as the existing role labels, and routing accepts only the
eight declared listener names in their assigned roles. An older ten-listener
inventory cannot silently receive balanced work. Until activation, execution
falls back to the existing hosted pool; this is not a completed rollout or a
15-minute acceptance result.

## Activation order

1. Wait for active CI work to drain. Disable listeners 08 and 09 without
   interrupting running jobs. Preserve every production/release service.
2. Install the checked-in resource drop-ins beneath `/etc/systemd/system/`
   and reload the manager. The default heavy quota is now one CPU, with the
   existing control and mobile overrides. Installation requires host-write
   authority; a worktree-only worker prepares the change but cannot apply it.
3. Verify the effective parent limit is ten CPUs / 60 GiB, the six heavy
   listeners have one CPU / 8 GiB each, control one CPU, and mobile three CPUs /
   12 GiB. Per-service MemoryHigh and the parent MemoryHigh remain unchanged.
4. Activate only 01–07 and 10. After verifying the limits, add
   `beeline-ci-balanced` to those eight listeners, retaining their current
   `beeline-ci-control`, `beeline-ci-heavy` or `beeline-ci-workspace` role.
   Do not give the rollout label to 08/09 or a production/release listener.
5. After landing, measure the first ten PR runs carrying the fix from push/run
   creation through the final check, including queues and rerun delay. Record
   job queues and runtime by pool. Failed, cancelled, pending and undersampled
   runs cannot establish the target. An old branch workflow is not a trial of
   this policy. No required check is added or renamed.

## Measurement and abort

Before the load test, record `uptime`, available memory, active listener count
and effective service/slice limits. Capture load and memory at least every
five seconds throughout the ten-run sample. Use `systemctl show beeline-ci.slice
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

The target is all required checks within fifteen minutes of push on ten
consecutive PR runs under the real concurrent workload, with CI pool usage
inside ten CPUs and 60 GiB and no OOM kills. Report measured per-PR
wall time, remaining unexplained failures and concurrent workload. The captain now targets as close to ten minutes per PR as possible through
selection and cache/setup reuse, with no additional paid runners. Host load is context; it is not the CI CPU
budget. A ten-CPU quota alone does not prove wall-time capacity.
Confirm required check names against the base workflow and verify main's
required checks remain green. Record actual after measurements in the PR;
leave unmeasured claims explicitly pending.
