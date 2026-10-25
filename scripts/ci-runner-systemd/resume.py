"""Reviewed resume only: reuse the existing App/key; never enroll a new App."""
import hashlib
import types
import os
from pathlib import Path
import signal
import socket
import stat
import time

ROOT = Path(__file__).resolve().parent
EXPECTED_PID = 3427506
EXPECTED_INSTALLATION = 175234307
EXPECTED_SLUG = 'beeline-squire-ci-lmiac-g0'
OLD_ARGV = [b'/usr/bin/python3', b'/home/lunchbox/.local/state/beeline/corners/d0dedb54-162b-4185-a9ef-0e241540a1d4/scripts/activate-isolated-ci-runners.py']
SOCKET_PATH = '/run/beeline-ci-registration/relay.sock'
PINS = {'rollout.py': 'c5cba3648c0fb3aba39f2bd6f553e8c7418705443e7a5e8fb1735f8b1c25d95d', 'broker.py': 'a416af17af98a1e79d8017f7fe03ddfc0dac2c97d0732ad2d47a4aedf6d1926e'}


def load(name):
    path = ROOT / name
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != PINS[name]:
        raise RuntimeError('Reviewed source digest mismatch: ' + name)
    module = types.ModuleType('resume_' + path.stem)
    module.__file__ = str(path)
    exec(compile(data, str(path), 'exec'), module.__dict__)
    return module


def socket_inode():
    matches = []
    for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
        row = line.split()
        if len(row) == 8 and row[7] == SOCKET_PATH:
            # 00010000 denotes a listening UNIX stream socket.
            if row[3] != '00010000' or row[4] != '0001':
                raise RuntimeError('Relay path is present without the expected listener state')
            matches.append(row[6])
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one live relay listener')
    return matches[0]


def verify_old_listener(pid):
    process = Path('/proc') / str(pid)
    if process.stat().st_uid != 0:
        raise RuntimeError('Old helper is not root-owned')
    if process.joinpath('cmdline').read_bytes().rstrip(b'\0').split(b'\0') != OLD_ARGV:
        raise RuntimeError('Old helper command differs; refusing to signal it')
    if not os.path.samefile(process / 'exe', '/usr/bin/python3'):
        raise RuntimeError('Old helper executable differs')
    expected = 'socket:[' + socket_inode() + ']'
    holders = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if any(os.readlink(fd) == expected for fd in (entry / 'fd').iterdir()):
                holders.append(int(entry.name))
        except FileNotFoundError:
            continue
    if holders != [pid]:
        raise RuntimeError('Relay socket is not held solely by the verified old helper')
    return expected


def stop_verified_listener():
    # pidfd pins identity across validation and signal delivery; no PID reuse race.
    fd = os.pidfd_open(EXPECTED_PID)
    try:
        before = verify_old_listener(EXPECTED_PID)
        if verify_old_listener(EXPECTED_PID) != before:
            raise RuntimeError('Socket ownership changed during verification')
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        import select
        if not select.select([fd], [], [], 10)[0]:
            raise RuntimeError('Verified helper did not exit; no escalation attempted')
    finally:
        os.close(fd)
    # Systemd socket ExecStartPre handles stale unlink, but only after ECONNREFUSED.
    with socket.socket(socket.AF_UNIX) as probe:
        probe.settimeout(2)
        try:
            probe.connect(SOCKET_PATH)
        except OSError as error:
            import errno
            if error.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                raise RuntimeError('Cannot confirm old listener stopped') from None
        else:
            raise RuntimeError('A relay listener remains alive; refusing takeover')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Root required')
    rollout = load('rollout.py')
    broker = load('broker.py')
    rollout.setup_status()
    try:
        # Systemd supplies the existing encrypted credential in its private mount.
        installation = int(os.environ['GITHUB_INSTALLATION_ID'])
        app_id = int(os.environ['GITHUB_APP_ID'])
        if installation != EXPECTED_INSTALLATION:
            raise RuntimeError('Existing installation ID differs from reviewed evidence')
        credential = Path(os.environ['CREDENTIALS_DIRECTORY']) / 'github-app-key'
        info = credential.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise RuntimeError('Systemd App credential is not root-only')
        app = rollout.api('app', broker.jwt())
        rollout.check_permissions(app['permissions'])
        if (int(app['id']) != app_id or app.get('slug') != EXPECTED_SLUG
                or app.get('owner', {}).get('login', '').lower() != rollout.ORG.lower()):
            raise RuntimeError('Existing App identity or owner mismatch')
        row = rollout.api(f'app/installations/{installation}', broker.jwt())
        if (row.get('repository_selection') != 'selected' or row.get('suspended_at')
                or row.get('account', {}).get('login', '').lower() != rollout.ORG.lower()):
            raise RuntimeError('Existing App installation is not selected-only on the approved org')
        rollout.check_permissions(row['permissions'])
        def token():
            return rollout.api(f'app/installations/{installation}/access_tokens', broker.jwt(), {})['token']
        repos = rollout.api('installation/repositories?per_page=100', token())
        if repos.get('total_count') != 1 or [r['full_name'] for r in repos['repositories']] != [rollout.REPO]:
            raise RuntimeError('Existing installation must select only Beeline-Work/beeline')
        # Installation reached file installation before the prior socket failure.
        for name, digest in rollout.PINS.items():
            if name in ['broker.py', 'prepare.py']:
                installed = Path('/usr/local/lib/beeline-ci') / name
            elif name == 'runner-registration.conf':
                paths = [Path(f'/etc/systemd/system/beeline-ci-shard-{i}.service.d/registration.conf') for i in [1, 2]]
                if any(hashlib.sha256(p.read_bytes()).hexdigest() != digest for p in paths):
                    raise RuntimeError('Installed runner drop-in differs')
                continue
            else:
                installed = Path('/etc/systemd/system') / name
            if installed.is_symlink() or hashlib.sha256(installed.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Installed permanent companion differs: ' + name)
        for index in [1, 2]:
            import subprocess
            status = subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', f'beeline-ci-shard-{index}.service'], capture_output=True).returncode
            if status != 3:
                raise RuntimeError('Expected existing inactive runners')
        verify_old_listener(EXPECTED_PID)  # All checks above are read-only/token issuance only.
        rollout.log('ROLLOUT RESUME: old helper identity and sole socket ownership verified')
        stop_verified_listener()
        folder = Path(SOCKET_PATH).parent
        if not stat.S_ISDIR(folder.lstat().st_mode):
            raise RuntimeError('Relay parent is not a real directory')
        os.chown(folder, 0, 0)
        folder.chmod(0o700)
        rollout.run(['/usr/bin/systemctl', 'reset-failed', 'beeline-ci-registration.socket'])
        rollout.run(['/usr/bin/systemctl', 'enable', '--now', 'beeline-ci-registration.socket'])
        group = rollout.group_setup(token(), int(repos['repositories'][0]['id']))
        if group != int(os.environ['GITHUB_RUNNER_GROUP_ID']):
            raise RuntimeError('Existing recorded runner group ID differs')
        authorization = token()
        started = time.monotonic()
        policy = rollout.api(f'repos/{rollout.REPO}/actions/permissions/fork-pr-contributor-approval', authorization)
        rollout.log(f'policy_seconds={time.monotonic() - started:.3f}')
        if policy.get('approval_policy') != 'all_external_contributors':
            raise RuntimeError('External approval policy changed')
        since = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        try:
            rollout.run(['/usr/bin/systemctl', 'enable', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'])
            rollout.run(['/usr/bin/systemctl', 'start', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'], timeout=240)
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                rows = rollout.api(f'orgs/{rollout.ORG}/actions/runner-groups/{group}/runners?per_page=100', token())
                online = {r['name'] for r in rows['runners'] if r['status'] == 'online'}
                if {'beeline-ci-shard-1', 'beeline-ci-shard-2'} <= online:
                    break
                time.sleep(2)
            else:
                raise RuntimeError('Both runners did not become online in the approved group')
            rollout.verify_logs(since)
            rollout.log('ROLLOUT PASS: resumed existing App; runners 1 and 2 online in beeline-server-ci')
        except BaseException:
            subprocess.run(['/usr/bin/systemctl', 'disable', '--now', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'], capture_output=True, timeout=120)
            raise
    except Exception as error:
        safe = str(error) if isinstance(error, rollout.Failure) or type(error) is RuntimeError else type(error).__name__
        rollout.log('ROLLOUT FAILED: resume: ' + safe)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
