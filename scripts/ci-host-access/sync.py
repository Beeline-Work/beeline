"""Immutable root updater: fixed upstream, merged main objects, fixed destinations."""
import fcntl
import grp
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

BASE = Path('/opt/beeline-ci')
UPSTREAM = 'https://github.com/Beeline-Work/beeline.git'
PREFIX = 'scripts/ci-host-access/'
UNITS = tuple(sorted([
    'beeline-ci-registration.socket', 'beeline-ci-registration.service',
    *[f'beeline-ci-shard-{i}{suffix}.service' for i in range(1, 5) for suffix in ['', '-docker']],
]))
FILES = ('runtime/broker.py', 'runtime/prepare.py', 'runtime/entry.py',
         *['units/' + unit for unit in UNITS])
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/var/empty',
       'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
       'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}


def run(argv, **kwargs):
    return subprocess.run(argv, env=ENV, check=True, capture_output=True, timeout=180, **kwargs).stdout


def git(repo, *args):
    return run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null',
                '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never',
                '--git-dir=' + str(repo), *args])


def merged_payload(repo, commit):
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise RuntimeError('Expected a full commit SHA')
    # Includes both object existence and ancestry; never read a worktree file.
    git(repo, 'merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main')
    payload = {}
    for name in FILES:
        path = PREFIX + name
        record = git(repo, 'ls-tree', commit, '--', path).decode().strip()
        if not record or record.split()[0:2] != ['100644', 'blob']:
            raise RuntimeError('Missing or non-regular merged file: ' + name)
        size = int(git(repo, 'cat-file', '-s', commit + ':' + path))
        if size > 1024 * 1024:
            raise RuntimeError('Merged payload exceeds size limit')
        payload[name] = git(repo, 'show', commit + ':' + path)
    return payload


def root_directory(path):
    if path.is_symlink():
        raise RuntimeError('Root directory is a symlink: ' + str(path))
    if not path.exists():
        path.mkdir(mode=0o755)
    info = path.lstat()
    allowed_gid = grp.getgrnam('polkitd').gr_gid if path == Path('/etc/polkit-1/rules.d') else 0
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != allowed_gid or info.st_mode & 0o022:
        raise RuntimeError('Directory is not exclusively root controlled: ' + str(path))


def write(path, data, mode=0o644):
    root_directory(path.parent)
    if path.is_symlink():
        raise RuntimeError('Refusing symlink destination: ' + str(path))
    fd, temporary = tempfile.mkstemp(prefix='.ci-install-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def mount_destinations():
    root_directory(Path('/ci'))
    for i in range(1, 5):
        root_directory(Path(f'/var/lib/beeline-ci-shard-{i}/root/ci'))
        root_directory(Path(f'/var/lib/beeline-ci-shard-{i}/root/opt'))
        root_directory(Path(f'/var/lib/beeline-ci-shard-{i}/root/opt/beeline-ci'))


def verify_units():
    for unit in UNITS:
        path = Path('/etc/systemd/system') / unit
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Existing unit is not root controlled: ' + unit)
        overrides = path.with_name(unit + '.d')
        if overrides.exists():
            root_directory(overrides)
            for child in overrides.iterdir():
                # The old registration-only dependency adds no executable path.
                if child.name != 'registration.conf' or child.is_symlink() or child.read_bytes() != b'[Unit]\nRequires=beeline-ci-registration.socket\nAfter=beeline-ci-registration.socket\n':
                    raise RuntimeError('Unreviewed unit override: ' + str(child))
        for parent in [Path('/run/systemd/system'), Path('/etc/systemd/system')]:
            for shared in ['service.d', 'socket.d', 'beeline-.service.d', 'beeline-ci-.service.d', 'beeline-ci-shard-.service.d', 'beeline-.socket.d', 'beeline-ci-.socket.d', *[f'beeline-ci-shard-{i}-.service.d' for i in range(1, 5)]]:
                if (parent / shared).exists():
                    raise RuntimeError('Shared unit overrides require review: ' + str(parent / shared))
        if (Path('/run/systemd/system') / unit).exists() or (Path('/run/systemd/system') / (unit + '.d')).exists():
            raise RuntimeError('Runtime unit override requires review: ' + unit)


def install_payload(payload, revision):
    if set(payload) != set(FILES) or not re.fullmatch('[0-9a-f]{40}|bootstrap', revision):
        raise RuntimeError('Unexpected payload or revision')
    root_directory(BASE)
    root_directory(BASE / 'releases')
    release = BASE / 'releases' / revision
    if release.exists() or release.is_symlink():
        raise RuntimeError('Release destination already exists')
    root_directory(release)
    # Stage all scripts before changing any running process or unit.
    for name in ['broker.py', 'prepare.py', 'entry.py']:
        write(release / name, payload['runtime/' + name])
    mount_destinations()
    verify_units()
    run(['/usr/bin/systemctl', 'stop', *UNITS])
    for unit in UNITS:
        write(Path('/etc/systemd/system') / unit, payload['units/' + unit])
    temporary = BASE / '.next'
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError('Unexpected pending release link')
    temporary.symlink_to('releases/' + revision)
    os.replace(temporary, BASE / 'current')
    run(['/usr/bin/systemctl', 'daemon-reload'])
    # Units remain stopped: the agent explicitly starts only the desired ones.
    print('Installed CI revision ' + revision + '; all CI units stopped', flush=True)


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0 or os.getegid() != 0:
        raise SystemExit('Root sync takes no arguments')
    root_directory(BASE)
    with (BASE / 'sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        repo = BASE / 'repository.git'
        if not repo.exists():
            run(['/usr/bin/git', 'init', '--bare', str(repo)])
            repo.chmod(0o700)
        root_directory(repo)
        git(repo, 'fetch', '--no-tags', '--no-recurse-submodules', UPSTREAM,
            '+refs/heads/main:refs/remotes/origin/main')
        commit = git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}').decode().strip()
        if (BASE / 'current').is_symlink() and os.readlink(BASE / 'current') == 'releases/' + commit:
            print('Already installed merged main ' + commit)
            return
        payload = merged_payload(repo, commit)
        install_payload(payload, commit)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('CI sync refused: ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
