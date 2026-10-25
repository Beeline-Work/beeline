"""One-shot reviewed rollout of two isolated runners; fail closed on any error.

Uses the existing corner GitHub App gh wrapper as the owner, never personal gh.
The detached broker fails closed if the corner authorization becomes unavailable.
Its lifetime beyond corner closure is not a durable operational guarantee.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import runpy
import socket
import struct
import subprocess
import sys
import time
from unittest.mock import patch

REPO = 'repos/Beeline-Work/beeline'
ROOT = Path(__file__).resolve().parent
SOCKET = '/run/beeline-ci-registration/relay.sock'
TOKEN_PIPE = None
GH_WRAPPER = '/home/lunchbox/.local/state/beeline/agents/7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877/rooms/d0dedb54-162b-4185-a9ef-0e241540a1d4/agent-home/beeline-github-bin/gh'
NODE = '/home/lunchbox/.local/share/fnm/node-versions/v24.16.0/installation/bin/node'


def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=240, **kwargs)
    if result.returncode:
        # Do not print tool output that could contain authorization.
        raise RuntimeError(f'Command failed ({result.returncode}): {argv[0]}')
    return result.stdout


def api(path, post=False):
    command = ['runuser', '-u', 'lunchbox', '--', NODE, GH_WRAPPER, 'api']
    if post:
        command += ['--method', 'POST']
    return json.loads(run(command + [REPO + path]))


def policy():
    if api('/actions/permissions/fork-pr-contributor-approval')['approval_policy'] != 'all_external_contributors':
        raise RuntimeError('External-contributor policy is not ready')


def broker():
    # No filesystem authentication fallback is permitted.
    os.environ['GH_CONFIG_DIR'] = '/nonexistent-beeline-ci-gh-config'
    policy()
    if os.path.lexists(SOCKET):
        raise RuntimeError('Existing relay socket; refusing replacement')
    server = socket.socket(socket.AF_UNIX)
    server.bind(SOCKET)
    os.chmod(SOCKET, 0o600)
    server.listen(4)
    issued_count = 0
    while True:
        client, _ = server.accept()
        with client:
            _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != 0:
                continue
            try:
                policy()
                token = api('/actions/runners/registration-token', True)['token']
                if issued_count < 2:
                    os.write(TOKEN_PIPE, (token + "\n").encode())
                issued_count += 1
                client.sendall((token + '\n').encode())
            except Exception:
                # Expired App authorization must stop registration, never use owner auth.
                continue


def jailed(index, args):
    name = f'beeline-ci-shard-{index}'
    command = ['systemd-run', '--wait', '--pipe', '--collect',
        f'--unit={name}-rollout-proof', '-p', f'User={name}',
        '-p', f'RootDirectory=/var/lib/{name}/root', '-p', 'MountAPIVFS=yes',
        '-p', 'BindReadOnlyPaths=/usr /etc/ssl/certs /etc/ld.so.cache',
        '-p', f'BindPaths=/var/lib/{name}/state:/ci', '-p', 'NoNewPrivileges=yes', *args]
    result = subprocess.run(command, capture_output=True, text=True, timeout=5 if args[-1] == 'info' else 240)
    if result.returncode:
        raise RuntimeError(f'Jailed command failed ({result.returncode}): {args!r}; stderr: {result.stderr[-2000:]}')
    return result.stdout


def main():
    global TOKEN_PIPE
    if os.geteuid() != 0:
        raise RuntimeError('Root required')
    if not Path(GH_WRAPPER).is_file():
        raise RuntimeError('Corner GitHub App wrapper is unavailable; no personal fallback')
    os.environ['GH_CONFIG_DIR'] = '/nonexistent-beeline-ci-gh-config'
    policy()
    expected = {
        ROOT / 'prepare-ephemeral-ci-runner.py': 'ff9a084d9431719b579c45aae381bf4321a608347fd3d1cb8f0cb0c3e718f033',
        Path('/usr/local/lib/beeline-ci/prepare.py'): 'b3373576fb59016b050ab60c8ca7a1d7bf24deee379a880e7416223bcb02e835',
    }
    for path, digest in expected.items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Preflight digest mismatch')
    # Upgrade only the previously verified installed preflight, without setup.
    installed = Path('/usr/local/lib/beeline-ci/prepare.py')
    installed.write_bytes((ROOT / 'prepare-ephemeral-ci-runner.py').read_bytes())
    installed.chmod(0o600)
    if hashlib.sha256(installed.read_bytes()).hexdigest() != 'ff9a084d9431719b579c45aae381bf4321a608347fd3d1cb8f0cb0c3e718f033':
        raise RuntimeError('Installed preflight update mismatch')
    for index in [1, 2]:
        name = f'beeline-ci-shard-{index}'
        if subprocess.run(['systemctl', 'is-active', '--quiet', name + '.service']).returncode == 0:
            raise RuntimeError('Runner is already active')

    # Exercise actual installed reset twice before any real registration. Only
    # token acquisition and the final configure command are replaced in this
    # stand-in; engine stop, residual-process kill, state deletion, extraction
    # and engine start execute unchanged on the host.
    class FakeRelay:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def settimeout(self, timeout): pass
        def connect(self, path):
            if path != SOCKET: raise RuntimeError('Unexpected relay path')
        def makefile(self, mode):
            import io
            return io.StringIO('BEELINE_RESET_PROOF_SENTINEL\n')

    real_run = subprocess.run
    def reset_run(argv, **kwargs):
        if argv[0] == 'systemd-run' and 'configure' in argv:
            if 'configure' not in argv or '--ephemeral' not in argv:
                raise RuntimeError('Unexpected preflight command')
            return subprocess.CompletedProcess(argv, 0, stdout='Configuration deliberately skipped in reset proof\n')
        return real_run(argv, **kwargs)

    for index in [1, 2]:
        name = f'beeline-ci-shard-{index}'
        state = Path('/var/lib') / name / 'state'
        user = pwd.getpwnam(name)
        for cycle in [1, 2]:
            for directory in ['home', 'work', 'runner', 'docker']:
                folder = state / directory
                folder.mkdir(exist_ok=True)
                marker = folder / 'beeline-reset-proof'
                marker.write_text('must disappear')
            jailed(index, ['/usr/bin/docker', '--host=unix:///ci/run/docker.sock', 'volume', 'create', 'beeline-reset-proof'])
            residual = subprocess.Popen(['runuser', '-u', name, '--', '/usr/bin/sleep', '180'])
            original_argv = sys.argv
            try:
                sys.argv = ['prepare.py', str(index)]
                with patch('socket.socket', FakeRelay), patch('subprocess.run', reset_run):
                    runpy.run_path('/usr/local/lib/beeline-ci/prepare.py', run_name='__main__')
            finally:
                sys.argv = original_argv
            residual.wait(timeout=10)
            for directory in ['home', 'work', 'runner', 'docker']:
                if (state / directory / 'beeline-reset-proof').exists():
                    raise RuntimeError('Reset marker survived')
            deadline = time.monotonic() + 60
            while True:
                try:
                    jailed(index, ['/usr/bin/docker', '--host=unix:///ci/run/docker.sock', 'info'])
                    break
                except (RuntimeError, subprocess.TimeoutExpired) as error:
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f'Docker readiness timed out: {error}') from error
                    time.sleep(min(1, max(0, deadline - time.monotonic())))
            volumes = jailed(index, ['/usr/bin/docker', '--host=unix:///ci/run/docker.sock', 'volume', 'ls', '-q'])
            if 'beeline-reset-proof' in volumes:
                raise RuntimeError('Docker volume survived reset')
            if (state / 'runner').stat().st_uid != user.pw_uid:
                raise RuntimeError('Runner ownership changed')
            print(name, 'reset cycle', cycle, 'PASS', flush=True)

    if os.path.lexists(SOCKET):
        raise RuntimeError('Existing relay socket; refusing replacement')
    # Keep broker in a separate process so runner re-registration can continue
    # after this command returns. Authorization remains short-lived in memory.
    read_pipe, TOKEN_PIPE = os.pipe()
    child = os.fork()
    if child == 0:
        # Keep a read end open so future broker writes fail closed by capacity
        # rather than raising SIGPIPE when the parent exits.
        os.setsid()
        with open('/dev/null', 'rb') as source, open('/dev/null', 'ab') as sink:
            os.dup2(source.fileno(), 0)
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
        broker()
        os._exit(0)
    os.close(TOKEN_PIPE)
    os.set_blocking(read_pipe, False)
    for _ in range(50):
        if os.path.exists(SOCKET): break
        time.sleep(0.1)
    else:
        raise RuntimeError('Broker did not become ready')
    try:
        run(['systemctl', 'start', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'])
        for _ in range(60):
            rows = api('/actions/runners')['runners']
            active = [r for r in rows if r['name'] in ['beeline-ci-shard-1', 'beeline-ci-shard-2'] and r['status'] == 'online']
            if len(active) == 2: break
            time.sleep(2)
        else:
            raise RuntimeError('Two dedicated runners did not become online')
        issued = os.read(read_pipe, 65536).decode().splitlines()
        if len(issued) < 2:
            raise RuntimeError('Missing token audit values')
        # Only the initial two registration tokens enter the audit pipe.
        for index in [1, 2]:
            name = f'beeline-ci-shard-{index}'
            journal = run(['journalctl', '-u', name + '.service', '-u', name + '-configure.service', '--no-pager', '-o', 'cat'])
            # Runner-generated diagnostics must redact authorization markers.
            import re
            if any(token in journal for token in issued) or re.search(r'ACTIONS_RUNNER_INPUT_TOKEN=\S+|"token"\s*:\s*"[^*\s][^"]{10,}"', journal, re.I):
                raise RuntimeError('Possible unredacted authorization in journal')
            diagnostics = Path('/var/lib') / name / 'state/runner/_diag'
            for log in diagnostics.glob('*.log'):
                content = log.read_text(errors='replace')
                if any(token in content for token in issued):
                    raise RuntimeError('Registration token found in runner diagnostics')
            print(name, 'online and journal/diagnostic token check PASS', flush=True)
        print('Two runners online; reset passed twice each. Actual-job reset, concurrent load and three-PR timing remain required.', flush=True)
    except BaseException:
        subprocess.run(['systemctl', 'stop', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'], capture_output=True)
        os.kill(child, 15)
        raise


if __name__ == '__main__':
    main()
