import os
from pathlib import Path
import pwd
import shutil
import subprocess
def run(*argv):
    subprocess.run(argv, check=True)
if os.geteuid() != 0:
    raise SystemExit('Host root grant required')
for binary in ['rootlesskit', 'slirp4netns', 'newuidmap', 'newgidmap', 'dockerd']:
    if not shutil.which(binary):
        raise SystemExit(f'Missing prerequisite: {binary}')
for index in range(1, 5):
    name = f'beeline-ci-shard-{index}'
    base = Path('/var/lib') / name
    if base.exists():
        raise SystemExit(f'Existing isolation: {base}')
    try:
        pwd.getpwnam(name)
    except KeyError:
        pass
    else:
        raise SystemExit(f'Existing user: {name}')
for index in range(1, 5):
    name = f'beeline-ci-shard-{index}'
    run('useradd', '--user-group', '--no-create-home', '--home-dir', '/ci/home',
        '--shell', '/usr/sbin/nologin', name)
    user = pwd.getpwnam(name)
    base = Path('/var/lib') / name
    jail = base / 'root'
    state = base / 'state'
    jail.mkdir(parents=True, mode=0o755)
    base.chmod(0o711)
    state.mkdir(mode=0o700)
    os.chown(state, user.pw_uid, user.pw_gid)
    for directory in ['home', 'run', 'docker', 'runner', 'work']:
        path = state / directory
        path.mkdir(mode=0o700)
        os.chown(path, user.pw_uid, user.pw_gid)
    for directory in ['usr', 'etc/ssl/certs', 'proc', 'sys', 'dev', 'run', 'tmp', 'var/tmp', 'ci']:
        (jail / directory).mkdir(parents=True, exist_ok=True)
    (jail / 'tmp').chmod(0o1777)
    (jail / 'var/tmp').chmod(0o1777)
    for directory in ['bin', 'sbin', 'lib', 'lib64']:
        (jail / directory).symlink_to('usr/' + directory)
    (jail / 'etc/passwd').write_text(
        f'root:x:0:0:root:/root:/usr/sbin/nologin\n{name}:x:{user.pw_uid}:{user.pw_gid}::/ci/home:/usr/sbin/nologin\n')
    (jail / 'etc/group').write_text(f'root:x:0:\n{name}:x:{user.pw_gid}:\n')
    (jail / 'etc/nsswitch.conf').write_text('passwd: files\ngroup: files\nhosts: files dns\n')
    (jail / 'etc/hosts').write_text('127.0.0.1 localhost\n::1 localhost\n')
    resolver = Path('/run/systemd/resolve/resolv.conf')
    if not resolver.exists():
        resolver = Path('/etc/resolv.conf')
    (jail / 'etc/resolv.conf').write_text(resolver.read_text())
    for mapping in ['subuid', 'subgid']:
        matching = [line for line in Path('/etc', mapping).read_text().splitlines() if line.startswith(name + ':')]
        if not any(int(line.split(':')[2]) >= 65536 for line in matching):
            raise SystemExit('Missing subordinate IDs')
        (jail / 'etc' / mapping).write_text('\n'.join(matching) + '\n')
    common = f'''User={name}
Group={name}
SupplementaryGroups=
RootDirectory={jail}
MountAPIVFS=yes
BindReadOnlyPaths=/usr /etc/ssl/certs /etc/ld.so.cache
BindPaths={state}:/ci
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/ci /tmp /var/tmp /run
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
UMask=0077
Environment=HOME=/ci/home XDG_RUNTIME_DIR=/ci/run
MemoryMax=12G
CPUQuota=300%
Nice=10
TasksMax=4096
'''
    unit = f'''[Unit]
Description=Isolated rootless Docker for {name}
After=network-online.target
[Service]
{common}
ExecStart=/usr/bin/rootlesskit --state-dir=/ci/run/rootlesskit --net=slirp4netns --disable-host-loopback --port-driver=builtin --copy-up=/etc --copy-up=/run /usr/bin/dockerd --rootless --host=unix:///ci/run/docker.sock --data-root=/ci/docker --exec-root=/ci/run/docker-exec --pidfile=/ci/run/docker.pid --storage-driver=overlay2
Environment=_DOCKERD_ROOTLESS_CHILD=1
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
'''
    service = name + '-docker.service'
    destination = Path('/etc/systemd/system') / service
    if destination.exists():
        raise SystemExit(f'Existing service: {destination}')
    destination.write_text(unit)
run('systemctl', 'daemon-reload')
for index in range(1, 5):
    service = f'beeline-ci-shard-{index}-docker.service'
    run('systemctl', 'start', service)
    run('systemctl', 'is-active', service)
print('Isolation prepared; runners not registered.', flush=True)
