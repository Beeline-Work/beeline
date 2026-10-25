import hashlib
import os
from pathlib import Path
import pwd
import re
import socket
import subprocess
import tarfile
import tempfile
import urllib.request

def run(*argv):
    return subprocess.run(argv, check=True)

if os.geteuid() != 0:
    raise SystemExit('Host root grant required')
for index in range(1, 5):
    base = Path(f'/var/lib/beeline-ci-shard-{index}')
    if not (base / 'root').is_dir() or any((base / 'state/runner').iterdir()):
        raise SystemExit(f'Isolation missing or runner directory occupied: {base}')

url = 'https://github.com/actions/runner/releases/download/v2.338.1/actions-runner-linux-x64-2.338.1.tar.gz'
digest = '08e9ccb3604d2462c24b5e33604dc30810296ca15cc65f23cffd4317eb144c37'
with tempfile.TemporaryFile() as archive:
    with urllib.request.urlopen(url, timeout=120) as response:
        while chunk := response.read(1024 * 1024):
            archive.write(chunk)
    archive.seek(0)
    if hashlib.file_digest(archive, 'sha256').hexdigest() != digest:
        raise SystemExit('Runner archive checksum mismatch')
    for index in range(1, 5):
        name = f'beeline-ci-shard-{index}'
        base = Path('/var/lib') / name
        user = pwd.getpwnam(name)
        runner = base / 'state/runner'
        archive.seek(0)
        with tarfile.open(fileobj=archive) as files:
            files.extractall(runner, filter='data')
        os.chown(runner, user.pw_uid, user.pw_gid)
        with socket.socket(socket.AF_UNIX) as relay:
            relay.connect(str(Path(__file__).resolve().parent.parent / '.ci-reg.sock'))
            token = relay.makefile('r').read().strip()
        if not token:
            raise SystemExit('Empty registration response')
        env = dict(os.environ, ACTIONS_RUNNER_INPUT_TOKEN=token)
        command = ['systemd-run', '--wait', '--pipe', '--collect',
            f'--unit={name}-configure', '-p', f'User={name}',
            '-p', f'RootDirectory={base}/root', '-p', 'BindReadOnlyPaths=/usr /etc/ssl/certs /etc/ld.so.cache',
            '-p', f'BindPaths={base}/state:/ci', '-p', 'WorkingDirectory=/ci/runner',
            '-p', 'NoNewPrivileges=yes', '--setenv=HOME=/ci/home',
            '--setenv=ACTIONS_RUNNER_INPUT_TOKEN', '/ci/runner/bin/Runner.Listener',
            'configure', '--unattended', '--url', 'https://github.com/Beeline-Work/beeline',
            '--name', name, '--labels', 'beeline-ci-shard', '--work', '/ci/work', '--disableupdate']
        result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        print(result.stdout.replace(token, '[redacted]'), flush=True)
        result.check_returncode()
        del env, token
        os.chown(runner, 0, 0)
        hook = base / 'root/etc/ci-clean.sh'
        hook.write_text('#!/bin/sh\nset -eu\nfind /ci/work -mindepth 1 -maxdepth 1 -exec /usr/bin/rm -rf -- {} +\n')
        hook.chmod(0o755)
        daemon = Path('/etc/systemd/system') / f'{name}-docker.service'
        slice_name = f'beeline-ci{index}.slice'
        daemon.with_name(slice_name).write_text('[Slice]\nMemoryMax=12G\nCPUQuota=300%\n')
        unit = daemon.read_text().replace('[Service]', f'[Service]\nSlice={slice_name}')
        daemon.write_text(unit)
        unit = re.sub(r'^ExecStart=.*$', 'ExecStart=/ci/runner/bin/Runner.Listener run', unit, flags=re.M)
        unit = unit.replace('Environment=_DOCKERD_ROOTLESS_CHILD=1',
            'NoNewPrivileges=yes\nWorkingDirectory=/ci/runner\nEnvironment=DOCKER_HOST=unix:///ci/run/docker.sock\n'
            'Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=/etc/ci-clean.sh ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/etc/ci-clean.sh')
        destination = daemon.with_name(name + '.service')
        destination.write_text(unit + f'\n[Unit]\nRequires={name}-docker.service\nAfter={name}-docker.service\n[Install]\nWantedBy=multi-user.target\n')
run('systemctl', 'daemon-reload')
for index in range(1, 5):
    run('systemctl', 'restart', f'beeline-ci-shard-{index}-docker.service')
    run('systemctl', 'enable', '--now', f'beeline-ci-shard-{index}.service')
