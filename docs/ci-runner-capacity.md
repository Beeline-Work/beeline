# PR runner capacity

`.github/workflows/checks.yml` keeps GitHub-hosted runners in parallel with the
credential-free `beeline-ci` Linux pool. `.github/workflows/desktop.yml` keeps
its existing platform runners. Both workflows cancel superseded PR heads;
their non-PR runs have unique concurrency groups and are never cancelled by
another run.

## Routing

| Checks work | Pull requests and merge groups | Manual dispatch |
| --- | --- | --- |
| Server shards 1 and 3 | `ubuntu-latest` | `ubuntu-latest` |
| Server shards 2 and 4 | `self-hosted, Linux, X64, beeline-ci` | `ubuntu-latest` |
| TYPECHECK and MOBILE SUITE | `self-hosted, Linux, X64, beeline-ci` | `ubuntu-latest` |
| Preparation, verdicts, Body and remaining Linux gates | `ubuntu-latest` | `ubuntu-latest` |

The PostgreSQL claim-latency job and shard 3's timing-sensitive isolated tests
stay hosted. Body requires privileged tool installation and stays hosted.
Mobile Vitest uses two workers on either pool, so ten services do not each
start a worker for every CPU on the shared host. Server shards already bound
Vitest to two workers and execute integration batches in separate processes.
Required check names and all eight integration batches remain unchanged.
Release workflows do not use this pool.

## CI-only host isolation

On 2026-10-31 the owner authorized ten repository runners on `squire`, named
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
- `/etc/systemd/system/beeline-ci.slice` bounds the pool to 80 GiB, with
  reclaim pressure at 64 GiB and CPU weight 25. Each service has a two-CPU
  quota and a 10 GiB memory limit. These limits apply only to the new pool.

The services start with `env -i` and only the CI home, system binary path,
locale and per-runner tool-cache path. They run with no capabilities and
`NoNewPrivileges`, a read-only host filesystem, private temporary directories
and devices, and an invisible view of other users' processes. Home directories
and deployment directories are inaccessible. `/etc`, `/var` and `/run` are
replaced by private filesystems; only the CI home and an explicit allowlist of
public identity, DNS, dynamic-loader and TLS trust files are mounted back.
Host environment files, systemd units, production credential directories and
the Docker socket are absent from the runner's filesystem view.

Verification entered a running service's mount namespace as the CI UID with
no groups or capabilities. Reads of both production homes, `/root`, `/opt`,
`/srv`, `/etc/environment`, `/etc/systemd/system`, `/var/lib/private`, and the
Docker socket were denied. All ten actual listener environments were checked
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
