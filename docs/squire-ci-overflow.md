# Current status: overflow rolled back

The overflow host setup has been removed. All proposed overflow job selectors
now use `ubuntu-latest`; the new instruction to fix and push failed checks
authorized this routing rollback. Historical setup and measurements follow.

# Temporary squire CI overflow

This is temporary capacity for same-repository PRs while #2803 consolidates
CI. Remove it after that change ships and queue times return to normal.
This is a capacity feature, not a defect report.

## Routing and rollback

Seven Linux job definitions in `checks.yml` can use `squire-ci`: typecheck,
shared packages, dead code, server suite shards, mobile suite, mobile export
and native fingerprint. Integration shards and the production corpus latency
gate use GitHub-hosted capacity: integration exceeded the slot memory cap,
and CPU throttling invalidated the corpus latency measurements.
Fork PRs, dispatches, pushes and other events use `ubuntu-latest`. Body's
sudo setup, Docker-dependent jobs, verdict-only jobs, desktop, prompt cases
and all release workflows retain their existing runners.

For an immediate routing override, a repository administrator can set the
Actions variable `SQUIRE_CI_DISABLED=true`. This corner's App cannot write
repository variables (the create endpoint returned `403 Resource not
accessible by integration`), so its independently usable rollback is:

```sh
node scripts/squire-ci/disable.mjs
```

Commit that diff and submit it through the normal PR review and merge gate.
The routing regression accepts either all overflow definitions or a complete
rollback. A variable change affects newly evaluated jobs, not jobs already
queued; cancel/rerun those only after routing has been restored. Do not stop
the runners while jobs still depend on them.

## Host design

`beeline-ci` is a system account, with no home, no login shell, no sudo or
Docker group. It runs only inside the system service sandbox defined in
`scripts/squire-ci/supervisor.mjs`. The supervisor runs as the operator,
requests a new short-lived registration token through the corner GitHub
launcher for every launch, and passes that token over stdin. It does not
copy the App key, operator environment or vault into a runner.

There are exactly four slots. Each has CPUQuota=150%, MemoryMax=6G,
MemorySwapMax=0 and TasksMax=512 (combined maximum: six CPU cores and
24 GiB). Each service ends after at most 45 minutes. No default runner labels
are registered; the sole label is `squire-ci`, so existing self-hosted release
selectors cannot select these runners.

Every registration uses `--ephemeral --disableupdate`. A private `/tmp`
contains the extracted runner, HOME, tool cache and workspace. systemd removes
it on exit, kills the unit's remaining processes and creates a fresh namespace
for the replacement. `/run` on squire is noexec, so the executable workspace
must be in private `/tmp`, not RuntimeDirectory. The supervisor also removes
leftover registrations following timeout or failure.

ProtectHome hides every home, including the operator's vault and agent
directories and the production runner home. ProtectSystem makes the system
read-only. `/opt`, `/var/lib`, `/run/user`, Docker, containerd and system bus
sockets are inaccessible. PrivateDevices, no capabilities, NoNewPrivileges
and RestrictSUIDSGID prevent sudo and device access. This is process/filesystem
isolation, not a separate machine or network namespace. Loopback remains
available to the server tests. Rootless containers were not used: podman is
absent and exposing the host Docker socket would violate isolation. No
production runner directory, user, label, unit or release file was changed.

The account's protection is enforced by its mandatory service namespace;
this does not claim host-wide DAC changes to other users' homes. Do not run
jobs directly with `sudo -u beeline-ci` outside this sandbox.

## Installation and command record (22 October)

All host calls used the existing local operator path. No SSH was used.
The following variables abbreviate the exact paths used:

```sh
ci_tree=/home/lunchbox/.local/state/beeline/corners/f16f64e8-fecc-4742-8d7b-d793e6049406
ci_node=/home/lunchbox/.local/share/fnm/node-versions/v24.16.0/installation/bin/node
ci_gh=/home/lunchbox/.local/state/beeline/agents/7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877/rooms/f16f64e8-fecc-4742-8d7b-d793e6049406/agent-home/beeline-github-bin/gh
```

Host setup commands, in execution order (repeated installs below reflect
fixes during validation):

```sh
systemd-run --user --wait --pipe /usr/bin/id
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/id
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/sbin/useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin beeline-ci
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -d -m 0755 /usr/local/lib/beeline-ci
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_tree/scripts/squire-ci/run-once.sh" /usr/local/lib/beeline-ci/run-once.sh
curl -fL --retry 2 https://github.com/actions/runner/releases/download/v2.338.1/actions-runner-linux-x64-2.338.1.tar.gz -o /tmp/squire-ci-runner.tar.gz
sha256sum /tmp/squire-ci-runner.tar.gz
cp /tmp/squire-ci-runner.tar.gz "$ci_tree/.squire-ci-runner.tar.gz"
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0644 "$ci_tree/.squire-ci-runner.tar.gz" /usr/local/lib/beeline-ci/runner.tar.gz
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_tree/scripts/squire-ci/verify-isolation.sh" /usr/local/lib/beeline-ci/verify-isolation.sh
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_tree/scripts/squire-ci/supervisor.mjs" /usr/local/lib/beeline-ci/supervisor.mjs
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_gh" /usr/local/lib/beeline-ci/github-launcher.mjs
systemd-run --user --wait --pipe "$ci_node" "$ci_tree/scripts/squire-ci/supervisor.mjs" --prove
```

The archive checksum matched the official runner release API's digest:
`08e9ccb3604d2462c24b5e33604dc30810296ca15cc65f23cffd4317eb144c37`.
Before executing the download, `tar -xOf` read its `./config.sh`, `./run.sh`,
`./env.sh` and `./run-helper.sh.template`. No dependency installer was run.

Early attempts exposed ordinary setup mistakes: direct sandbox sudo was
blocked by NoNewPrivileges; the host manager defaulted to Node 18, so the
launcher needed explicit Node 24; relative install paths and sandbox `/tmp`
were not visible to the host; RuntimeDirectory could not execute scripts
because `/run` is noexec. These were corrected with absolute shared-tree
paths and private `/tmp`. The isolation probe initially tested the Docker
socket's file type instead of access; the corrected probe tests read/write
denial. Failed attempts made no production changes.

Start (the outer call crosses from the agent sandbox to the host manager):

```sh
systemd-run --user --wait --pipe /usr/bin/systemd-run --user \
  --unit=beeline-ci-supervisor --property=Restart=on-failure \
  --setenv=PATH=/home/lunchbox/.local/share/fnm/node-versions/v24.16.0/installation/bin:/usr/bin:/bin \
  --setenv=SQUIRE_CI_GH=/usr/local/lib/beeline-ci/github-launcher.mjs \
  "$ci_node" /usr/local/lib/beeline-ci/supervisor.mjs
```

Every child service command and sandbox property is recorded verbatim in
`supervisor.mjs` and the host sudo journal. Start/stop was exercised during
setup; the initial supervisor version needed explicit child stops, now done
by its signal handler. Stopped overflow registrations were removed through
`DELETE /repos/Beeline-Work/beeline/actions/runners/{id}`, selecting only names
beginning `squire-ci-`.

After routing is restored and overflow jobs finish, stop with:

```sh
systemd-run --user --wait --pipe /usr/bin/systemctl --user stop beeline-ci-supervisor
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/systemctl stop beeline-ci-1 beeline-ci-2 beeline-ci-3 beeline-ci-4
```

Absent child units are already stopped. Confirm no overflow registrations
remain with the runner-list API; delete any remaining `squire-ci-` IDs only.
Remove `/usr/local/lib/beeline-ci` and the `beeline-ci` account after that.
The supervisor and launcher scripts are installed outside the worktree so
corner archival does not remove them. The launcher refreshes App access
through the existing operator runtime and parent Room (its token call is
Room-scoped); no key is embedded in the launcher. If that runtime or Room's
repository access is removed, restore hosted routing and stop overflow. It
does not install a new long-lived credential or enable boot persistence.

## Verification and measurements

`verify-isolation.sh` runs through exactly the production slot properties.
Two consecutive runs denied traversal of `/home/lunchbox`,
`/home/beeline-runner`, `/root`, `/opt`, `/var/lib` and `/run/user`, denied
Docker socket read/write, denied sudo, proved system files unwritable and
proved both runtime and private-tmp markers absent on the next launch.
The private-tmp executable probe also passed.

Host inspections used `id`, `getent passwd beeline-ci`, `findmnt -T /run`
and `findmnt -T /tmp`, `stat` on parent directories, `systemctl list-units
'actions.runner*'`, and `systemctl show` for the production runner's User
and WorkingDirectory. Debugging used `journalctl --user -u
beeline-ci-supervisor` and root `journalctl -u beeline-ci-1`; resource proof
used root `systemctl show beeline-ci-1`. These read-only commands used the
same `systemd-run --user --wait --pipe` operator wrapper where required.

The GitHub App succeeded at runner listing and registration-token creation.
The preexisting personal connector failed administration access; its browser
repair was abandoned and the browser share closed on Ruby's instruction.
No owner sign-in was needed for the App route.

`node --test scripts/squire-ci/routing.test.mjs` evaluates each actual workflow
selector for same-repo PRs, forks, missing heads, pushes, dispatches,
pull_request_target, merge_group and the kill switch. It is also run by
TYPECHECK. Workflow-path checks and existing change-filter regressions pass.

Before routing deployment (19:50:44 UTC), the paginated GitHub API showed
queued workflow runs (13), including Checks (10). The median wall-clock of
the latest successful Checks runs (30) was seconds (4499). This includes
queue time, measured from created_at to updated_at. `metrics.mjs` reproduces
the query and emits sample run IDs; compare with a later sample after jobs
have actually completed. A moving historical median is context, not causal
proof of the overflow's effect. Actual PR job evidence and the after sample
must be reported once CI has run on this workflow.

PR #2809's [SHARED PACKAGE TESTS job](https://github.com/Beeline-Work/beeline/actions/runs/39844383372/job/120053669802)
passed on `squire-ci-2-dde4bbc6-e184-4e8f-9fb5-028d71b98f73`.
The after sample (19:58:21 UTC) still showed queued runs (13), queued Checks
(10), and median successful Checks wall-clock seconds (4499) over runs (30).
This initial sample demonstrates operation, not a queue-time improvement:
overflow routing is only present on this PR until it merges. DEAD CODE on
the first head identified missing Knip operator entry points; they are now
declared explicitly rather than added to the unused-code baseline.

The server suite runs one Vitest worker per overflow slot, retaining two on
GitHub-hosted runners. On head `a187c88644c6`, shard six was canceled when
the slot hit its memory limit: the host journal recorded `oom-kill` and a
6.0G peak at 21:21:04 UTC. This worker limit keeps the resource cap intact.
Diagnosis used the operator wrapper with `sudo -n journalctl -u beeline-ci-1
-u beeline-ci-2 -u beeline-ci-3 -u beeline-ci-4 --since '2026-10-22
21:19:00 UTC' --until '2026-10-22 21:22:00 UTC' --no-pager -n 100`.
The same shard completed locally with one worker in seconds (565), with
tests passing (215), skipped (2), and failing (2). Both failures are the
existing `production-corpus-width.test.ts` room-list latency assertions
(p95 242ms and median 173ms against a 150ms budget). This is not a green
suite result; CI still needs to confirm the bounded runner path.
An immediate standalone rerun of that file with one worker passed all tests
(4) in seconds (15), confirming the latency failures vary with host load.


## Failure investigation on head 043754174 (22 October)

The authenticated personal GitHub API returned each job log; signed log
redirects were downloaded to `/tmp/jellybean-ci-<job-id>.log`.

- SERVER INTEGRATION SHARD 5 (job 120101891886): exit 143 and runner shutdown;
  host systemd logs show the overflow memory cap being reached. Additional
  integration shards (1, 3 and 7) failed the same way at 22:16 UTC with
  `oom-kill` and 6.0G peaks. Route these jobs to hosted runners rather than
  weaken tests or increase the overflow budget.
- MOBILE SUITE (job 120101891659): browser proofs failed with EACCES launching
  `/usr/bin/google-chrome`, whose target is under inaccessible `/opt`.
  Install a root-owned copy of only Chrome outside that hidden directory and
  set CHROME_BIN in the ephemeral runner. No private host paths are exposed.
- PRODUCTION-CORPUS REPLAY (job 120101891654): corner-facts p95 was 181.2ms
  against its 100ms budget. Keep this timing gate on hosted runners rather
  than measure it under overflow CPU throttling or loosen its threshold.
  Hosted CI must confirm whether any application failure remains.
- FRAME-BUDGET (job 120116852489): failed closed because MOBILE SUITE failed.
- STATE-UPGRADE (job 120116852565): failed closed because MOBILE SUITE failed.

Additional host commands executed, using the same operator wrapper:

```sh
systemd-run --user --wait --pipe /usr/bin/sudo -n journalctl -u beeline-ci-1 -u beeline-ci-2 -u beeline-ci-3 -u beeline-ci-4 --since '2026-10-22 22:02:00 UTC' --no-pager -n 90
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/cp -a /opt/google/chrome /usr/local/lib/beeline-ci/chrome
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_tree/scripts/squire-ci/verify-isolation.sh" /usr/local/lib/beeline-ci/verify-isolation.sh
systemd-run --user --wait --pipe "$ci_node" "$ci_tree/scripts/squire-ci/supervisor.mjs" --prove
```

The first probe refused to start because its old fixed unit name collided
with a running overflow slot; no running job was stopped. Proof units now
use unique names. The corrected probe rendered a real HTML page through
Chrome in the exact service sandbox and passed every existing isolation
check. Workflow selectors and path references passed their regressions.
The updated run-once and supervisor scripts were then installed for future
launches with these commands. No supervisor restart or running job stop was
performed; the live supervisor continues to launch the updated run-once.

```sh
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_tree/scripts/squire-ci/run-once.sh" /usr/local/lib/beeline-ci/run-once.sh
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/install -m 0755 "$ci_tree/scripts/squire-ci/supervisor.mjs" /usr/local/lib/beeline-ci/supervisor.mjs
```


### Authorized supervisor restart after recovery push

After recovery head `8ae03898c` was pushed, Ruby explicitly directed a
supervisor restart. The installed run-once and supervisor scripts were
already updated as recorded above. Executed:

```sh
systemd-run --user --wait --pipe /usr/bin/systemctl --user restart beeline-ci-supervisor
systemd-run --user --wait --pipe /usr/bin/systemctl --user is-active beeline-ci-supervisor
```

The restart completed and the supervisor reported active. The subsequent
delivery instruction authorized committing and pushing this remaining host
command record. No further implementation changes are included. Any check
failure on overflow capacity requires removal of the overflow host setup
and a failed report, as directed by Ruby.


## Authorized rollback after recovery failure

GitHub reported SERVER SUITE SHARD 6 on head 8f16164ec failed with exit
143 and runner shutdown (job 120122980843). Ruby's standing instruction
required rollback on any overflow check failure. No further fix was pushed.
Executed locally:

```sh
systemd-run --user --wait --pipe /usr/bin/systemctl --user stop beeline-ci-supervisor
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/systemctl stop beeline-ci-1 beeline-ci-2 beeline-ci-3 beeline-ci-4
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/rm -rf -- /usr/local/lib/beeline-ci
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/sbin/userdel beeline-ci
systemd-run --user --wait --pipe /usr/bin/systemctl --user show beeline-ci-supervisor --property=ActiveState --property=LoadState
systemd-run --user --wait --pipe /usr/bin/sudo -n /usr/bin/systemctl list-units 'beeline-ci-*' 'actions.runner*' --all --no-pager
systemd-run --user --wait --pipe /usr/bin/test ! -e /usr/local/lib/beeline-ci
getent passwd beeline-ci
```

Supervisor stop succeeded. Explicit child stops found every slot already
absent. Removed the complete overflow installation, including the root-owned
Chrome copy, runner archive, launcher and supervisor scripts, and deleted
the dedicated account. Production runner configuration was not changed.
The personal GitHub API refused runner-list access with HTTP 403 (missing
administration permission). No alternate identity was used after denial;
remote registration cleanup remains unverified. The PR must not land with
active overflow routing after this host rollback. This rollback record is
local only, respecting the prohibition on another push.

The later failed-check repair instruction authorized running
`node scripts/squire-ci/disable.mjs` and pushing the full hosted routing
rollback with this host removal record. No overflow services were recreated.
