# Existing-App resume for Ruby review

No host mutation or grant request has been made for this draft. Do not rerun
manifest enrollment: the App and encrypted key already exist.

## Read-only diagnosis

The sandbox sees a live UNIX stream listener at
`/run/beeline-ci-registration/relay.sock`, kernel socket inode `1231672978`.
Its parent is lunchbox-owned mode 0700 and dates to 15:06. The sandbox PID
namespace cannot inspect its host descriptors, and a peer-credential connection
was denied. Host process reads through the existing read-only ps grant show:

- Root PID **3427506**, parent **1012**, started **2026-10-25 15:06:16**.
- Exact argv: `/usr/bin/python3` followed by this corner's
  `scripts/activate-isolated-ci-runners.py`.

This confirms the old corner activation process is still alive. Its matching
start time strongly identifies it as the leftover broker, but sole socket
ownership is not yet proven by a descriptor read. The reviewed resume requires
that proof on the host before it can stop anything. No signal has been sent.

The status file independently confirms App creation/installation progressed:
OWNER_INSTALL for `beeline-squire-ci-lmiac-g0`, `policy_seconds=0.436`, followed
by `ROLLOUT FAILED: Command failed: systemctl exit=1`. Ruby reports the socket
unit failed, no broker service started and both shards are inactive. This is
consistent with the guarded socket cleanup refusing the live old listener.

## Minimal future resume path

`launch-resume.py` hash-pins `resume.py` and starts a bounded root systemd task.
It supplies the existing non-secret configuration and encrypted App key using
EnvironmentFile and LoadCredentialEncrypted. No raw PEM is exported or passed
in argv. The root script imports the exact reviewed rollout/broker sources
only after checking their hashes; existing files stay unchanged.

The script validates installation **175234307**, the existing App's ID/slug and
organization owner, exact permissions, selected repository scope and the sole
repository Beeline-Work/beeline. It verifies the installed permanent companions
and inactive runner units. It never calls a manifest conversion endpoint or
writes the App key/configuration.

Before SIGTERM, it opens a pidfd for **3427506**, verifies root ownership,
Python executable, exact old-helper argv, unique listening socket inode, and
that this PID is the sole holder of that inode across host process descriptors.
It rechecks before signaling through the pidfd to avoid PID reuse. Any changed
identity, hidden/ambiguous ownership, shared descriptor or timeout stops the
resume. It uses no broad process-name kill and no SIGKILL escalation.

After process exit it confirms the socket is refused or absent, sets the parent
to root:root 0700, resets only the failed registration socket and enables/starts
it. The existing socket ExecStartPre performs guarded stale unlink; a different
live listener still blocks takeover.

It then creates/verifies the selected-only public-enabled runner group through
the existing App, checks that its ID matches the existing recorded group, checks
fork policy and measures policy_seconds, starts only runners one/two, verifies
both online in that group, and runs the existing journal/_diag token checks.
Failures during enrollment stop/disable only those two runners. No new App,
manifest listener, key, reboot, ownership change outside the relay directory or
old enrollment retry is part of this resume.

Non-secret output appends to /run/beeline-ci-rollout/status and the journal.
A failure before the credential-bearing service starts may appear only in its
unit status; this draft does not claim that unsealing has passed. Actual-job
reset, concurrent load and three-PR timing remain after a successful resume.

## CI-MOUNT-2 recovery revision (review required)

The owner-authorized resume reached the permanent broker, and Ruby's host
journal records shard one registering successfully before rollback. Shard two
failed before preparation at 19:18:55 EDT:

> Failed to mount /var/lib/beeline-ci-shard-2/state to /run/systemd/mount-rootfs/ci: No such file or directory

Its ExecStartPre has no recorded start time; state still dates to 15:06.
`prepare.py` deletes only children of `state`, never `state` or `root/ci`.
The installer combines `RootDirectoryStartOnly=yes`, a privileged pre-start
command and `BindPaths=.../state:/ci`. Systemd skips the jail for pre-start,
but still compiles bind mounts. Thus host `/ci` is also a destination. It
was first created during this launch (19:18), explaining why inspecting only
`root/ci` after failure misses the pre-start boundary. Missing destination
at that boundary is the diagnosis; the exact concurrent systemd creation
sequence has not been captured in a privileged replay.

Sources: systemd v255 [control-process chroot flags](https://github.com/systemd/systemd/blob/v255/src/core/service.c#L1488)
and [unconditional bind-mount compilation](https://github.com/systemd/systemd/blob/v255/src/core/exec-invoke.c#L2771).

The revised recovery creates and validates root-owned host `/ci` and both
jail destinations before either runner starts. Missing bind sources, symlink
sources/jails/destinations and non-root-owned destinations fail closed.
The preflight does not recreate or clear job state.

Retry accepts the installed active permanent socket, or a stopped socket with
no listener; it only considers the old PID if a non-systemd listener is still
alive, retaining all identity/pidfd checks. It reuses the same App, encrypted
key, group and installation. No enrollment endpoint or GitHub UI is involved.
Idle engines three/four are stopped before runner start. Failure cleanup
first disables/stops runners one/two, then stops engines one through four,
then the permanent socket/broker. Cleanup attempts later batches even if an
earlier batch fails, and reports failure rather than claiming shutdown passed.

Proof: `python3 scripts/ci-runner-systemd/rollout.test.py` runs real bind mounts
in an isolated unprivileged user/mount namespace. With existing state and
jail/ci but absent host/ci, the bind fails. The same bind passes after the
recovery preflight, for both host and jail destinations, including a repeat
preflight. This is a missing-path stand-in, not a replay of systemd's concurrent
auto-creation. Resume tests cover reuse of the existing broker and cleanup on
an injected start failure; cleanup tests cover every engine even when stopping
a runner fails. No privileged host retry or idle-engine shutdown was executed
for this revision. Ruby must review before a new approval request is filed.
