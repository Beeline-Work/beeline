"""Draft permanent root-only, socket-activated organization runner broker."""
import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

ORG = 'Beeline-Work'
REPO = 'Beeline-Work/beeline'
SOCKET = '/run/beeline-ci-registration/relay.sock'


def log(message):
    print(message, flush=True)


def cleanup():
    path = Path(SOCKET)
    if path.exists() or path.is_symlink():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise RuntimeError('Relay path is not a socket')
        with socket.socket(socket.AF_UNIX) as probe:
            probe.settimeout(2)
            try:
                probe.connect(SOCKET)
            except OSError as error:
                if error.errno != errno.ECONNREFUSED:
                    raise RuntimeError('Cannot establish stale socket') from None
            else:
                raise RuntimeError('Relay listener is alive; refusing unlink')
        path.unlink()
    path.parent.mkdir(mode=0o700, exist_ok=True)
    os.chown(path.parent, 0, 0)
    path.parent.chmod(0o700)


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def jwt():
    now = int(time.time())
    body = encode(b'{"alg":"RS256","typ":"JWT"}') + '.' + encode(json.dumps(
        {'iat': now - 60, 'exp': now + 540, 'iss': os.environ['GITHUB_APP_ID']}).encode())
    key = Path(os.environ['CREDENTIALS_DIRECTORY']) / 'github-app-key'
    fd = os.memfd_create('github-app-signing', 0)
    try:
        os.write(fd, key.read_bytes())
        os.lseek(fd, 0, 0)
        result = subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-sign', f'/proc/self/fd/{fd}'],
                                input=body.encode(), capture_output=True, pass_fds=(fd,), timeout=10)
        if result.returncode:
            raise RuntimeError('App signing failed')
        return body + '.' + encode(result.stdout)
    finally:
        os.close(fd)


def api(path, token, body=None):
    request = urllib.request.Request('https://api.github.com/' + path,
        data=None if body is None else json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'beeline-ci-broker'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def registration():
    token = api(f'app/installations/{int(os.environ["GITHUB_INSTALLATION_ID"])}/access_tokens', jwt(), {})['token']
    started = time.monotonic()
    try:
        policy = api(f'repos/{REPO}/actions/permissions/fork-pr-contributor-approval', token)
        if policy.get('approval_policy') != 'all_external_contributors':
            raise RuntimeError('External approval policy is unsafe')
    finally:
        log(f'policy_seconds={time.monotonic() - started:.3f}')
    group = int(os.environ['GITHUB_RUNNER_GROUP_ID'])
    settings = api(f'orgs/{ORG}/actions/runner-groups/{group}', token)
    repos = api(f'orgs/{ORG}/actions/runner-groups/{group}/repositories', token)
    if (settings.get('visibility') != 'selected' or not settings.get('allows_public_repositories')
            or settings.get('name') != 'beeline-server-ci' or repos.get('total_count') != 1
            or [row['full_name'] for row in repos.get('repositories', [])] != [REPO]):
        raise RuntimeError('Runner group repository restriction is unsafe')
    return api(f'orgs/{ORG}/actions/runners/registration-token', token, {})['token']


def serve():
    if os.geteuid() != 0 or int(os.environ.get('LISTEN_PID', '0')) != os.getpid() or os.environ.get('LISTEN_FDS') != '1':
        raise RuntimeError('Expected root and one systemd listening socket')
    with socket.socket(fileno=3) as server:
        while True:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(30)
                _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != 0:
                    log('denied non-root peer')
                    continue
                try:
                    token = registration()
                    log('registration_sha256=' + hashlib.sha256(token.encode()).hexdigest())
                    connection.sendall((token + '\n').encode())
                    log('registration authorization delivered')
                except urllib.error.HTTPError as error:
                    log(f'GitHub request failed status={error.code}; authorization withheld')
                except Exception as error:
                    log(f'broker failed type={type(error).__name__}; authorization withheld')


if __name__ == '__main__':
    cleanup() if sys.argv[1:] == ['--cleanup-stale'] else serve()
