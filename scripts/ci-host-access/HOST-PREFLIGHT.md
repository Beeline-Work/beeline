# Unprivileged live host preflight (squire)

Collected using `systemd-run --user --wait --pipe /usr/bin/stat` with explicit
paths, before requesting the revised installer approval. No root command ran.
The first user unit is `run-u124514.service`, invocation
`19be798c24a445c6ab529a481d6fdda0`. The aggregate stat exit is 1 because
nonexistent future install paths and inaccessible protected files were included.

The successful directory/regular-file stats satisfy the ownership guards after
the single root:polkitd exception. The two .service.d directories are root:root
0700 and meet the strict gid-zero check. Shared/runtime overrides were absent.
Future /opt install paths, updater unit, and jail root/opt trees are absent;
the installer creates them, so live metadata cannot yet be verified for them.
Future commit-named releases and Git repository internals likewise do not exist.
Temporary atomic-write files will be securely created in checked directories.

Unprivileged checks that could not complete:

- Stat/existence of /etc/polkit-1/rules.d/00-beeline-ci.rules: EACCES because the
  parent is root:polkitd 0750. The root installer retains its existing-rule guard.
- Stat and content reads of the two registration.conf files: EACCES because their
  parents are 0700. The current files were not freshly read. Reviewed rollout
  source `scripts/ci-runner-systemd/runner-registration.conf` has exactly:

```ini
[Unit]
Requires=beeline-ci-registration.socket
After=beeline-ci-registration.socket
```

It ends with a newline; SHA-256 is
`305a960f09d4e1ecdc5cff46a106428f7e5e50924caa1ba788001e3a81ad82b2`.
`rollout.py` pins those bytes, writes them via private_write, and `resume.py`
compares both installed drop-in hashes before starting runners. The prior
approved v3 recovery reached PASS after that check. This is source/provenance
evidence, not a new root read. The installer still reads/validates each drop-in
on its eventual approved run; unexpected bytes abort rather than weakening it.

Full stat output for the enumerated paths:

```text
/ci | uid=0 gid=0 mode=755 type=directory
/etc/polkit-1/rules.d | uid=0 gid=990 mode=750 type=directory
/etc/systemd/system | uid=0 gid=0 mode=755 type=directory
/etc/systemd/system/beeline-ci-registration.service | uid=0 gid=0 mode=600 type=regular file
/etc/systemd/system/beeline-ci-registration.socket | uid=0 gid=0 mode=600 type=regular file
/etc/systemd/system/beeline-ci-shard-1-docker.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-1.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-1.service.d | uid=0 gid=0 mode=700 type=directory
/etc/systemd/system/beeline-ci-shard-2-docker.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-2.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-2.service.d | uid=0 gid=0 mode=700 type=directory
/etc/systemd/system/beeline-ci-shard-3-docker.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-3.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-4-docker.service | uid=0 gid=0 mode=644 type=regular file
/etc/systemd/system/beeline-ci-shard-4.service | uid=0 gid=0 mode=644 type=regular file
/opt | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-1/root/ci | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-2/root/ci | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-3/root/ci | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-4/root/ci | uid=0 gid=0 mode=755 type=directory
Running as unit: run-u124514.service; invocation ID: 19be798c24a445c6ab529a481d6fdda0
/usr/bin/stat: cannot statx '/etc/polkit-1/rules.d/00-beeline-ci.rules': Permission denied
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-.socket.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-.socket.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-registration.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-registration.socket.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-1-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-1-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-1.service.d/registration.conf': Permission denied
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-2-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-2-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-2.service.d/registration.conf': Permission denied
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-3-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-3-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-3.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-4-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-4-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-shard-4.service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/beeline-ci-sync.service': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/service.d': No such file or directory
/usr/bin/stat: cannot statx '/etc/systemd/system/socket.d': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/releases': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/releases/bootstrap': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/releases/bootstrap/broker.py': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/releases/bootstrap/entry.py': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/releases/bootstrap/prepare.py': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/repository.git': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/sync': No such file or directory
/usr/bin/stat: cannot statx '/opt/beeline-ci/sync.py': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-.socket.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-.socket.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-registration.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-registration.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-registration.socket': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-registration.socket.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-1-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-1-docker.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-1-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-1.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-1.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-2-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-2-docker.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-2-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-2.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-2.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-3-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-3-docker.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-3-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-3.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-3.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-4-.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-4-docker.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-4-docker.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-4.service': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/beeline-ci-shard-4.service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/service.d': No such file or directory
/usr/bin/stat: cannot statx '/run/systemd/system/socket.d': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-1/root/opt': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-1/root/opt/beeline-ci': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-2/root/opt': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-2/root/opt/beeline-ci': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-3/root/opt': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-3/root/opt/beeline-ci': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-4/root/opt': No such file or directory
/usr/bin/stat: cannot statx '/var/lib/beeline-ci-shard-4/root/opt/beeline-ci': No such file or directory
Finished with result: exit-code
Main processes terminated with: code=exited/status=1
Service runtime: 1ms
CPU time consumed: 1ms
Memory peak: 256.0K
Memory swap peak: 0B
```

Supplemental parent checks via `run-u124515.service` (invocation
`b46a0c90ddb4469bb00399ed477d406a`) succeeded with exit 0:

```text
/run/systemd/system | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-1/root | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-2/root | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-3/root | uid=0 gid=0 mode=755 type=directory
/var/lib/beeline-ci-shard-4/root | uid=0 gid=0 mode=755 type=directory
```
