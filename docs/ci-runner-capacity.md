# PR runner capacity

`.github/workflows/checks.yml` keeps GitHub-hosted runners in parallel with the
credential-free `beeline-ci` Linux pool. `.github/workflows/desktop.yml` keeps
its existing platform runners. Both workflows cancel superseded PR heads;
their non-PR runs have unique concurrency groups and are never cancelled by
another run.

## Routing and CPU budget

The budget files in `infra/ci/` replace the older 16-CPU pool policy below.
Five listeners are active: `01` has one CPU for control work and `02` through
`05` have two CPUs each for tests. Every listener has an 8 GiB hard memory limit. Registered listeners `06` through `10` stay stopped and disabled
as standby. The pool retains its ten-CPU quota and 60 GiB hard memory limit.
Verify those effective limits and the five-listener count before activation.

| Checks work | Pull requests | Merge groups / manual dispatch |
| --- | --- | --- |
| All four server shards, TYPECHECK, MOBILE SUITE | `beeline-ci, beeline-ci-heavy` (02–05) | `ubuntu-latest` |
| DEAD CODE, MOBILE-EXPORT REACHABILITY, PRODUCTION-CORPUS REPLAY, NATIVE FINGERPRINT | `beeline-ci, beeline-ci-heavy` (02–05) | `ubuntu-latest` |
| Detection, shared preparation/tests, selection, verdicts, README, app associations | `beeline-ci, beeline-ci-control` (01) | `ubuntu-latest` |
| Privileged Body setup, PostgreSQL timing, Docker build/lint | `ubuntu-latest` | `ubuntu-latest` |

The PostgreSQL claim-latency job stays hosted. Body's privileged tool setup
stays hosted. Desktop and Mac helper acceptance retain their existing runners.
The main-push server coverage workflow stays hosted and runs the full suite;
PR shards consume SELECT SERVER TESTS and fail closed to the full suite if
selection is unavailable. No check contexts or integration batches change.

Test listeners use at most two Vitest workers; the control listener uses one,
including shared-package tests. Body stays hosted with at most two workers. Integration batches and timing-sensitive isolated tests retain
one worker. Node test-file concurrency, Turbo task concurrency, libuv's thread pool
and Metro export workers are also bounded. Existing lockfile-keyed dependency
caches and exact-commit build caches are reused after shared preparation;
cold workspace builds execute one task at a time on the control producer. Squire
consumers require those prepared caches and fail promptly on a miss, so a
failed shared job cannot trigger parallel cold installs/builds. Compiled outputs
never fall back to another commit. Cache version 2 includes explicit dist
file globs, validates API exports and publishes the build snapshot immediately
after compilation, before tests can change outputs.

The service drop-in caps each active listener and its whole job process tree
to two CPUs, with memory pressure at 6 GiB and a hard limit of 8 GiB. Instance
01 has an additional one-CPU override and only the control role; instances
02–05 have the heavy role. Their maxima total nine CPUs under the ten-CPU cap. The slice
caps the pool at ten CPUs, with pressure at 48 GiB and a hard limit of 60 GiB.
Five active listeners admit at most five simultaneous jobs across all PRs;
workflow matrix limits alone cannot enforce a host-wide bound.

Every CI-only producer and consumer prepends `.github/actions/ci-workspace/bin`
to PATH. Archive compression also uses one zstd worker. Its
`tar` wrapper uses the existing `flock` utility and the shared CI user's home
to serialize cache archive operations across all listeners. Only the cache
action's `cache.tar`, `cache.tgz` and `cache.tzst` files take that lock; tool
probes and ordinary test fixtures run directly. The kernel releases the lock
when tar and its children exit, including cancellation. No service is added.

Two earlier ten-job trials hit the load-15 safety abort, including a run with
valid dependency/build cache hits and parallel tar processes waiting on disk.
That profile used only 6.17 CPUs in its busiest five-second sample, showing
why CPU quotas alone cannot control disk waits or whole-host load. The five-job
profile and serialized cache operations address that measured bottleneck;
concurrent-PR acceptance remains a separate measurement. Judge CI by its
cgroup CPU/memory and Linux job wall time, not whole-host load from agents,
Gradle or emulators. Hosted detection/selection queues previously held server
shards for more than fifteen minutes, so the credential-free control path now
has a reserved local listener. The host-load safety backstop is 25; the resource budget
remains ten CPUs and 60 GiB.

See [`infra/ci/README.md`](../infra/ci/README.md) for activation, measurement and
abort instructions. The new budget is installed, but concurrent PR validation remains pending;
the historical measurements below do not establish the 15-minute target.

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
