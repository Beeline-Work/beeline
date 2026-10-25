"""Root-only preflight: destroy previous job state and register one fresh job."""
import hashlib
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tarfile
import time


def restore_runner_ownership(runner, user):
    for directory, directories, files in os.walk(runner):
        os.chown(directory, user.pw_uid, user.pw_gid)
        for name in directories + files:
            os.chown(Path(directory) / name, user.pw_uid, user.pw_gid, follow_symlinks=False)
    runner.chmod(0o700)


index = int(sys.argv[1])
if os.geteuid() != 0 or index not in range(1, 5):
    raise SystemExit('Expected root and shard index 1..4')
name = f'beeline-ci-shard-{index}'
base = Path('/var/lib') / name
state = base / 'state'
user = pwd.getpwnam(name)
subprocess.run(['nft', 'list', 'table', 'inet', 'beeline_ci'], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['systemctl', 'stop', name + '-docker.service'], check=True)
result = subprocess.run(['pkill', '-KILL', '-u', str(user.pw_uid)])
if result.returncode not in (0, 1):
    raise SystemExit('Could not stop previous job processes')
# The parent is root-owned; never follow a job-created state directory symlink.
for path in state.iterdir():
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()
for directory in ['home', 'work', 'docker', 'run', 'runner']:
    path = state / directory
    path.mkdir(mode=0o700)
    os.chown(path, user.pw_uid, user.pw_gid)
archive = Path('/var/lib/beeline-ci-runner.tar.gz')
with archive.open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != '08e9ccb3604d2462c24b5e33604dc30810296ca15cc65f23cffd4317eb144c37':
        raise SystemExit('Runner archive changed')
    stream.seek(0)
    with tarfile.open(fileobj=stream) as files:
        files.extractall(state / 'runner', filter='data')
restore_runner_ownership(state / 'runner', user)
subprocess.run(['systemctl', 'start', name + '-docker.service'], check=True)
# Starting the service does not mean the Docker API is ready.
ready_command = ['systemd-run', '--wait', '--pipe', '--collect',
    f'--unit={name}-engine-ready', '-p', f'User={name}',
    '-p', f'RootDirectory={base}/root', '-p', 'BindReadOnlyPaths=/usr',
    '-p', f'BindPaths={state}:/ci', '-p', 'NoNewPrivileges=yes',
    '/usr/bin/docker', '--host=unix:///ci/run/docker.sock', 'info']
deadline = time.monotonic() + 60
while True:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SystemExit('Docker API readiness timed out')
    try:
        ready = subprocess.run(ready_command, capture_output=True, text=True,
                               timeout=min(5, remaining))
        if ready.returncode == 0:
            break
        last_error = ready.stderr[-2000:]
    except subprocess.TimeoutExpired:
        last_error = 'Docker info command timed out'
    if time.monotonic() >= deadline:
        raise SystemExit('Docker API readiness timed out: ' + last_error)
    time.sleep(min(1, max(0, deadline - time.monotonic())))
# The relay is outside every jail and serves only root peer credentials.
with socket.socket(socket.AF_UNIX) as relay:
    relay.settimeout(60)
    relay.connect('/run/beeline-ci-registration/relay.sock')
    token = relay.makefile('r').read(4096).strip()
if not token or '\n' in token:
    raise SystemExit('Registration authorization unavailable')
command = ['systemd-run', '--wait', '--pipe', '--collect', f'--unit={name}-configure',
    '-p', f'User={name}', '-p', f'RootDirectory={base}/root',
    '-p', 'BindReadOnlyPaths=/usr /etc/ssl/certs /etc/ld.so.cache',
    '-p', f'BindPaths={state}:/ci', '-p', 'WorkingDirectory=/ci/runner',
    '-p', 'NoNewPrivileges=yes', '--setenv=HOME=/ci/home',
    '/usr/bin/python3', '/etc/ci-entry.py',
    'configure', '--unattended', '--ephemeral', '--replace', '--disableupdate',
    '--url', 'https://github.com/Beeline-Work/beeline', '--name', name,
    '--labels', 'beeline-ci-shard', '--work', '/ci/work']
result = subprocess.run(command, input=token + '\n',
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
print(result.stdout.replace(token, '[redacted]'), flush=True)
result.check_returncode()
