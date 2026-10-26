# CI host access bootstrap

One owner-approved run of `install.py` installs immutable CI scripts and a
single polkit rule. It stops the ten existing experimental units during
migration and leaves them stopped. It does not touch production runners,
create an App/key, change fork policy or enable CI routing.

Agent commands after installation (no sudo, shell elevation or new owner tap):

```sh
systemctl start beeline-ci-registration.socket
systemctl restart beeline-ci-shard-1.service
systemctl --no-pager status beeline-ci-shard-1.service
/opt/beeline-ci/sync
```

The fixed `lunchbox` host account may start/stop/restart only the four existing
runner services, their four engines and the registration socket/service. The
rule names each unit literally. Status reads already require no privilege.
Unit edits, manager-environment changes and operations on other units are
refused by the rule. It grants no pkexec, sudo, transient shell or arbitrary
command privilege. Existing unrelated host authorization is not expanded.

The only additional start permission is `beeline-ci-sync.service`, the fixed
root updater. Its wrapper rejects arguments; its unit provides the absolute
Python command with `-I -B`, fixed root user/group and no caller environment.
It cannot receive a commit, checkout, executable, URL or systemd property from
an agent. The wrapper's systemctl call uses the host system bus, so it avoids
trying to elevate a process inside the agent's filesystem/user namespace.

All executable sources reside under root:root `/opt/beeline-ci`, with no group
or other writes. Units bind this root-owned tree read-only into their jails.
Every Python unit command uses `-I -B`; preparation invokes the same root-owned
entry script for configuration. No unit executes a corner/cache script. The
old root-owned helpers may remain on disk but no managed unit invokes them.
Installer and updater refuse unexpected unit drop-ins rather than silently
combining them with the new service definitions.

`sync.py` is the immutable trust gate, installed once alongside the wrapper and
policy. It fetches a fixed public HTTPS upstream into its own root-only bare
repository, with a fresh fixed environment, no user Git config/hooks or
submodule recursion. It resolves fetched origin/main, verifies ancestry and
reads only a fixed list of regular blobs directly from Git objects. It never
reads a working tree. Runtime scripts and the same ten unit files can then be
updated from merged main. The permission rule, updater, wrapper and updater
unit are not updated from that payload; extending privilege needs separate
owner authorization. A file edited in a corner or an unmerged commit cannot
be installed through this gate. The initial reviewed bootstrap is the single
explicit owner-approved exception for unmerged bytes.

Sync serializes updates, stages scripts in a root-controlled release directory,
stops all ten experimental units, installs their fixed unit paths, atomically
switches `current` and reloads systemd. It leaves units stopped so the agent
starts only the intended runners. An already-installed main commit is a no-op.
Failures remain visible in `systemctl --no-pager status beeline-ci-sync.service`.

## Validation before owner execution

```sh
node scripts/ci-host-access/policy.test.cjs
python3 scripts/ci-host-access/sync.test.py
systemd-analyze verify scripts/ci-host-access/beeline-ci-sync.service scripts/ci-host-access/units/*.service scripts/ci-host-access/units/*.socket
```

CI-ACCESS-1 executes the shipped polkit JavaScript with polkit's action/subject
API and verifies the exact positive and negative authorization decisions.
CI-SYNC-1/2 use real Git commits to refuse an unmerged commit and a merged
symlink, and prove local edits do not affect returned bytes. CI-SYNC-3 installs
those bytes into a disposable unprivileged filesystem fixture, checks modes,
checks all unit command paths and verifies stop/reload ordering. Ownership
metadata alone is substituted for the fixture; host destinations and systemctl
mutations are redirected. No test performs a host-root action.

These checks prove the policy/code boundary; they do not claim a live restart
through the newly installed host polkit daemon. After the owner-authorized
installer runs, verify a runner restart from an agent session and refusal of
an unrelated unit/arbitrary root command before continuing CI load/timing
proofs. Default system-bus read access must remain available to the session.

`INSTALL-SHA256.json` lists every installed regular file's initial destination,
mode and SHA-256. The `current` symlink points to `releases/bootstrap`; all
parent directories are root:root and mode 0755. No credentials are installed.
The requested command runs only the reviewed hash-pinned installer; it has
not been executed with host root by the implementer.

References: [polkit rule API](https://www.freedesktop.org/software/polkit/docs/latest/polkit.8),
[systemd authorization](https://www.freedesktop.org/software/systemd/man/247/org.freedesktop.systemd1.html).
