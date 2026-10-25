"""Reviewed manifest-to-systemd rollout. Never print credentials or API bodies."""
import base64
import hashlib
import html
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import resource
import secrets
import socket
import stat
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
STATUS = Path('/run/beeline-ci-rollout/status')
STATUS_FD = None
ORG = 'Beeline-Work'
REPO = ORG + '/beeline'
GROUP = 'beeline-server-ci'
PERMISSIONS = {'organization_self_hosted_runners': 'write', 'administration': 'read'}
CONFIG = Path('/etc/beeline-ci-registration.conf')
CIPHER = Path('/etc/credstore.encrypted/beeline-ci-app-key')
PINS = {'broker.py': 'a416af17af98a1e79d8017f7fe03ddfc0dac2c97d0732ad2d47a4aedf6d1926e', 'prepare.py': 'a47222ddb645a0ee84f28d741b01de6469657027588e3b2d2f6430138e4a0469', 'beeline-ci-registration.socket': '018548b5b8a06e1107474d563b96653200f95bf16dc7371532b2905664b64133', 'beeline-ci-registration.service': '3c6ee43b4065384a87cff8b80f0c127c63923741cd4261578a18b6d6f0780675', 'runner-registration.conf': '305a960f09d4e1ecdc5cff46a106428f7e5e50924caa1ba788001e3a81ad82b2'}


class Failure(Exception):
    pass


def setup_status():
    global STATUS_FD
    STATUS.parent.mkdir(mode=0o755, exist_ok=True)
    info = STATUS.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        raise Failure('Status directory must be root-owned and not a symlink')
    STATUS.parent.chmod(0o755)
    fd = os.open(STATUS, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o644)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
        os.close(fd)
        raise Failure('Status file must be a single root-owned regular file')
    os.fchmod(fd, 0o644)
    STATUS_FD = fd


def log(message):
    print(message, flush=True)
    if STATUS_FD is not None and message.startswith(('OWNER_OPEN ', 'OWNER_INSTALL ', 'policy_seconds=', 'ROLLOUT PASS', 'ROLLOUT FAILED')):
        os.write(STATUS_FD, (message + '\n').encode())
        os.fsync(STATUS_FD)


def refuse_existing_app():
    if CIPHER.exists() or CIPHER.is_symlink() or CONFIG.exists() or CONFIG.is_symlink():
        raise Failure('Existing App configuration; refusing a duplicate enrollment')


def run(argv, data=None, timeout=180):
    try:
        result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failure('Command timed out: ' + Path(argv[0]).name) from None
    if result.returncode:
        # Never echo API, encryption or signing output, including stderr.
        raise Failure(f'Command failed: {Path(argv[0]).name} exit={result.returncode}')
    return result.stdout


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise Failure('GitHub API redirect rejected')


def api(path, token=None, body=None, method=None):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'beeline-ci-rollout',
               'X-GitHub-Api-Version': '2022-11-28'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request('https://api.github.com/' + path,
        headers=headers, data=None if body is None else json.dumps(body).encode(), method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise Failure(f'GitHub API failed status={error.code}') from None
    except (urllib.error.URLError, TimeoutError):
        raise Failure('GitHub API transport failed') from None


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def jwt(pem, app_id):
    now = int(time.time())
    body = encode(b'{"alg":"RS256","typ":"JWT"}') + '.' + encode(json.dumps(
        {'iat': now - 60, 'exp': now + 540, 'iss': str(app_id)}).encode())
    fd = os.memfd_create('beeline-ci-signing', 0)
    try:
        os.write(fd, pem)
        os.lseek(fd, 0, 0)
        signature = subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-sign', f'/proc/self/fd/{fd}'],
            input=body.encode(), pass_fds=(fd,), capture_output=True, timeout=10)
        if signature.returncode:
            raise Failure('App signing failed')
        return body + '.' + encode(signature.stdout)
    finally:
        os.close(fd)


def private_write(path, content):
    # Only ciphertext or non-secret identifiers are passed here.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def manifest(state, url):
    return {'name': 'Beeline squire CI ' + state[:8], 'url': 'https://github.com/' + REPO,
        'redirect_url': url + '/callback', 'public': False,
        'hook_attributes': {'url': 'https://github.com/' + REPO, 'active': False},
        'default_events': [], 'default_permissions': PERMISSIONS,
        'request_oauth_on_install': False, 'description': 'Dedicated isolated squire CI registration'}


def capture_manifest():
    state = secrets.token_urlsafe(32)
    deadline = time.monotonic() + 1200
    result = {}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass  # Callback query contains a conversion code.
        def reply(self, status, text):
            self.send_response(status)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(text.encode())
        def do_GET(self):
            if self.headers.get('Host') != authority or time.monotonic() >= deadline:
                self.reply(403, 'Local rollout session unavailable')
                return
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == '/' and not result.get('page_served'):
                result['page_served'] = True
                action = 'https://github.com/organizations/' + ORG + '/settings/apps/new?state=' + state
                payload = html.escape(json.dumps(manifest(state, url)), quote=True)
                self.reply(200, '<!doctype html><title>Beeline CI App setup</title>'
                    '<p>Opening GitHub to create a private org App with runner write and administration read.</p>'
                    f'<form method="post" action="{html.escape(action, quote=True)}">'
                    f'<input type="hidden" name="manifest" value="{payload}"></form>'
                    '<script>document.forms[0].submit()</script>')
                return
            if parsed.path != '/callback' or result.get('used'):
                self.reply(410, 'This setup page is one-use')
                return
            query = urllib.parse.parse_qs(parsed.query)
            if (len(query.get('state', [])) != 1 or not secrets.compare_digest(query['state'][0], state)
                    or len(query.get('code', [])) != 1 or not re.fullmatch('[A-Za-z0-9_-]{10,200}', query['code'][0])):
                self.reply(403, 'Callback state or code rejected')
                return
            result['used'] = True
            try:
                conversion = api('app-manifests/' + query['code'][0] + '/conversions', body={})
                pem = conversion.pop('pem').encode()
                app_id = int(conversion['id'])
                # Only the ciphertext is ever written to persistent storage.
                encrypted = run(['/usr/bin/systemd-creds', 'encrypt', '--name=github-app-key', '-', '-'], pem)
                private_write(CIPHER, encrypted)
                private_write(CONFIG, f'GITHUB_APP_ID={app_id}\n'.encode())
                result['pem'], result['app_id'] = pem, app_id
                result['slug'] = conversion['slug']
                conversion.clear()  # Discard unused OAuth and webhook secrets.
                self.reply(200, '<!doctype html><title>App key secured</title><p>App key encrypted on squire. '
                    'Use the printed installation URL; select Only select repositories → Beeline-Work/beeline.</p>')
            except Exception as error:
                result['failure'] = error if isinstance(error, Failure) else Failure('Manifest conversion or encryption failed')
                self.reply(500, 'Setup stopped. See sanitized rollout journal; no key is shown here.')
    class LocalServer(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(5)
            return connection, address
        def handle_error(self, *args):
            log('Local HTTP request failed; request details withheld')
    try:
        listener = LocalServer(('127.0.0.1', 0), Handler)
    except OSError:
        raise Failure('Loopback setup listener unavailable') from None
    authority = f'127.0.0.1:{listener.server_address[1]}'
    url = 'http://' + authority
    with listener as server:
        server.timeout = 1
        log('OWNER_OPEN ' + url + '/')
        while 'pem' not in result and 'failure' not in result and time.monotonic() < deadline:
            server.handle_request()
    if 'failure' in result:
        raise result['failure']
    if 'pem' not in result:
        raise Failure('Manifest callback timed out after 20 minutes')
    return result['pem'], result['app_id'], result['slug']


def check_permissions(values):
    if {key: value for key, value in values.items() if key != 'metadata'} != PERMISSIONS:
        raise Failure('App permissions differ from approved manifest')
    if values.get('metadata', 'read') != 'read':
        raise Failure('Unexpected metadata permission')


def wait_installation(pem, app_id, slug):
    if not re.fullmatch('[a-z0-9-]+', slug):
        raise Failure('Invalid App slug')
    app = api('app', jwt(pem, app_id))
    check_permissions(app['permissions'])
    if app.get('owner', {}).get('login', '').lower() != ORG.lower():
        raise Failure('App is not owned by the approved organization')
    log('OWNER_INSTALL https://github.com/apps/' + slug + '/installations/new')
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        rows = api('app/installations?per_page=100', jwt(pem, app_id))
        if rows:
            if len(rows) != 1:
                raise Failure('Expected exactly one App installation')
            row = rows[0]
            if (row.get('account', {}).get('login', '').lower() != ORG.lower()
                    or row.get('repository_selection') != 'selected' or row.get('suspended_at')):
                raise Failure('Installation must select only the approved org repository, not all repositories')
            check_permissions(row['permissions'])
            token = api(f'app/installations/{int(row["id"])}/access_tokens', jwt(pem, app_id), {})['token']
            repos = api('installation/repositories?per_page=100', token)
            if repos.get('total_count') != 1 or [r['full_name'] for r in repos['repositories']] != [REPO]:
                raise Failure('Installation repository list is not exactly Beeline-Work/beeline')
            return int(row['id']), int(repos['repositories'][0]['id'])
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise Failure('App installation timed out after 20 minutes')


def write_config(values):
    # The initial file was created exclusively by this rollout.
    with CONFIG.open('a') as stream:
        for key, value in values.items():
            stream.write(f'{key}={int(value)}\n')


def group_setup(token, repo_id):
    listing = api(f'orgs/{ORG}/actions/runner-groups?per_page=100', token)
    if listing.get('total_count', 0) > 100:
        raise Failure('Runner group list needs pagination; refusing ambiguous setup')
    matches = [g for g in listing['runner_groups'] if g['name'] == GROUP]
    if len(matches) > 1:
        raise Failure('Duplicate runner groups')
    if not matches:
        group = api(f'orgs/{ORG}/actions/runner-groups', token,
            {'name': GROUP, 'visibility': 'selected', 'selected_repository_ids': [repo_id], 'allows_public_repositories': True})
    else:
        group = matches[0]
    group_id = int(group['id'])
    group = api(f'orgs/{ORG}/actions/runner-groups/{group_id}', token)
    repos = api(f'orgs/{ORG}/actions/runner-groups/{group_id}/repositories?per_page=100', token)
    if (group.get('visibility') != 'selected' or group.get('name') != GROUP
            or not group.get('allows_public_repositories') or group.get('inherited')
            or repos.get('total_count') != 1 or [r['id'] for r in repos['repositories']] != [repo_id]):
        raise Failure('Existing runner group does not match approved restrictions; not modified')
    return group_id


def pinned_bytes(name):
    data = (ROOT / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != PINS.get(name):
        raise Failure('Companion digest mismatch: ' + name)
    return data


def install_files():
    destination = Path('/usr/local/lib/beeline-ci')
    destination.mkdir(mode=0o700, exist_ok=True)
    os.chown(destination, 0, 0)
    destination.chmod(0o700)
    for name in ['broker.py', 'prepare.py']:
        path = destination / name
        if path.is_symlink():
            raise Failure('Installed helper is a symlink')
        path.write_bytes(pinned_bytes(name))
        os.chown(path, 0, 0)
        path.chmod(0o700 if name == 'broker.py' else 0o600)
    for name in ['beeline-ci-registration.socket', 'beeline-ci-registration.service']:
        path = Path('/etc/systemd/system') / name
        if path.exists() or path.is_symlink():
            raise Failure('Permanent broker unit already exists; no replacement')
        private_write(path, pinned_bytes(name))
    for index in [1, 2]:
        folder = Path(f'/etc/systemd/system/beeline-ci-shard-{index}.service.d')
        folder.mkdir(mode=0o755, exist_ok=True)
        private_write(folder / 'registration.conf', pinned_bytes('runner-registration.conf'))
    tmpfiles = Path('/etc/tmpfiles.d/beeline-ci-registration.conf')
    if tmpfiles.is_symlink():
        raise Failure('Registration tmpfiles config is a symlink')
    tmpfiles.write_text('d /run/beeline-ci-registration 0700 root root -\n')
    tmpfiles.chmod(0o600)
    run(['/usr/bin/systemctl', 'daemon-reload'])
    # Socket ExecStartPre alone checks for a live listener before stale removal.
    run(['/usr/bin/systemctl', 'enable', '--now', 'beeline-ci-registration.socket'])


def verify_logs(since):
    journals = run(['/usr/bin/journalctl', '--since', since, '--no-pager', '-o', 'cat',
        '-u', 'beeline-ci-registration.service', '-u', 'beeline-ci-shard-1.service',
        '-u', 'beeline-ci-shard-2.service', '-u', 'beeline-ci-shard-1-configure.service',
        '-u', 'beeline-ci-shard-2-configure.service']).decode(errors='replace')
    fingerprints = set(re.findall(r'registration_sha256=([0-9a-f]{64})', journals))
    if not fingerprints or 'policy_seconds=' not in journals:
        raise Failure('Missing broker token audit or policy timing')
    texts = [journals]
    for index in [1, 2]:
        diagnostics = Path(f'/var/lib/beeline-ci-shard-{index}/state/runner/_diag')
        logs = list(diagnostics.glob('*.log'))
        if not logs:
            raise Failure('Missing runner diagnostic logs')
        texts.extend(p.read_text(errors='replace') for p in logs)
    for text in texts:
        for word in re.findall(r'[A-Za-z0-9_.-]{20,}', text):
            if hashlib.sha256(word.encode()).hexdigest() in fingerprints:
                raise Failure('Registration token found in logs; contents withheld')
        if re.search(r'ACTIONS_RUNNER_INPUT_TOKEN=\S+|-----BEGIN .*PRIVATE KEY-----', text):
            raise Failure('Possible unredacted secret in logs; contents withheld')
    for timing in re.findall(r'policy_seconds=[0-9.]+', journals):
        log(timing)
    log('Journal and runner diagnostic token audit PASS')


def main():
    if os.geteuid() != 0:
        raise Failure('Root required')
    os.umask(0o077)
    setup_status()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    for name in PINS:
        pinned_bytes(name)
    if not PINS:
        raise Failure('Companion digests missing')
    refuse_existing_app()
    # Ensure neither runner can execute while the credentials are provisioned.
    for index in [1, 2]:
        status = subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', f'beeline-ci-shard-{index}.service'], capture_output=True).returncode
        if status != 3:
            raise Failure('Expected an existing inactive runner unit')
    CIPHER.parent.mkdir(mode=0o700, exist_ok=True)
    os.chown(CIPHER.parent, 0, 0)
    CIPHER.parent.chmod(0o700)
    # Recheck immediately before manifest capture: no key from a prior run.
    refuse_existing_app()
    pem, app_id, slug = capture_manifest()
    installation, repo_id = wait_installation(pem, app_id, slug)
    write_config({'GITHUB_INSTALLATION_ID': installation})
    def token():
        return api(f'app/installations/{installation}/access_tokens', jwt(pem, app_id), {})['token']
    group = group_setup(token(), repo_id)
    write_config({'GITHUB_RUNNER_GROUP_ID': group})
    started = time.monotonic()
    policy = api(f'repos/{REPO}/actions/permissions/fork-pr-contributor-approval', token())
    log(f'policy_seconds={time.monotonic() - started:.3f}')
    if policy.get('approval_policy') != 'all_external_contributors':
        raise Failure('External approval policy is unsafe')
    install_files()
    since = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
    try:
        run(['/usr/bin/systemctl', 'enable', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'])
        run(['/usr/bin/systemctl', 'start', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'], timeout=240)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            rows = api(f'orgs/{ORG}/actions/runner-groups/{group}/runners?per_page=100', token())
            expected = {'beeline-ci-shard-1', 'beeline-ci-shard-2'}
            online = {r['name'] for r in rows['runners'] if r['status'] == 'online'}
            if expected <= online:
                break
            time.sleep(2)
        else:
            raise Failure('Both dedicated runners did not become online in the selected group')
        verify_logs(since)
        log('ROLLOUT PASS: runners 1 and 2 online in beeline-server-ci; actual-job/load/timing proofs remain')
    except BaseException:
        # Stop and disable only the new runner units; keep journal and broker evidence.
        subprocess.run(['/usr/bin/systemctl', 'disable', '--now', 'beeline-ci-shard-1.service', 'beeline-ci-shard-2.service'], capture_output=True, timeout=120)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        log('ROLLOUT FAILED: ' + (str(error) if isinstance(error, Failure) else type(error).__name__))
        raise SystemExit(1)
