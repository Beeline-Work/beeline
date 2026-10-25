"""Install isolated ephemeral runners; execute only with a fresh host grant."""
import hashlib
import os
from pathlib import Path
import pwd
import re
import subprocess
import urllib.request

if os.geteuid() != 0:
    raise SystemExit('Host root grant required')
source = Path(__file__).with_name('prepare-ephemeral-ci-runner.py')
expected = '4f54a1866b36fe0d1789ec7f406f49468f2097160abe250712f8665e7a5dab75'
if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
    raise SystemExit('Pre-job script differs from reviewed bytes')
units = Path('/etc/systemd/system')
users = [pwd.getpwnam(f'beeline-ci-shard-{i}') for i in range(1, 5)]
for user in users:
    unit = (units / (user.pw_name + '-docker.service')).read_text()
    if unit.count('Environment=_DOCKERD_ROOTLESS_CHILD=1') != 1:
        raise SystemExit('Expected exactly one rootless environment marker')
    if (units / (user.pw_name + '.service')).exists():
        raise SystemExit('Runner service already exists')
archive = Path('/var/lib/beeline-ci-runner.tar.gz')
url = 'https://github.com/actions/runner/releases/download/v2.338.1/actions-runner-linux-x64-2.338.1.tar.gz'
with urllib.request.urlopen(url, timeout=120) as response:
    data = response.read(400 * 1024 * 1024)
if hashlib.sha256(data).hexdigest() != '08e9ccb3604d2462c24b5e33604dc30810296ca15cc65f23cffd4317eb144c37':
    raise SystemExit('Runner archive checksum mismatch')
archive.write_bytes(data)
archive.chmod(0o600)
install = Path('/usr/local/lib/beeline-ci')
install.mkdir(mode=0o755, exist_ok=True)
(install / 'prepare.py').write_bytes(source.read_bytes())
(install / 'prepare.py').chmod(0o600)
uids = ', '.join(str(user.pw_uid) for user in users)
rules = f'''table inet beeline_ci {{
 chain output {{
  type filter hook output priority 0; policy accept;
  meta skuid {{ {uids} }} ip daddr {{ 100.64.0.0/10, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 }} counter drop
  meta skuid {{ {uids} }} ip6 daddr {{ fd7a:115c:a1e0::/48, fc00::/7, fe80::/10 }} counter drop
 }}
}}
'''
firewall = install / 'network.nft'
firewall.write_text(rules)
subprocess.run(['nft', '-c', '-f', str(firewall)], check=True)
(units / 'beeline-ci-network.service').write_text(f'''[Unit]
Before=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f {firewall}
RemainAfterExit=yes
''')
relay = Path('/run/beeline-ci-registration')
relay.mkdir(mode=0o700, exist_ok=True)
os.chown(relay, 1000, 1000)
Path('/etc/tmpfiles.d/beeline-ci-registration.conf').write_text('d /run/beeline-ci-registration 0700 1000 1000 -\n')
for index, user in enumerate(users, 1):
    name = user.pw_name
    daemon = units / (name + '-docker.service')
    slice_name = f'beeline-ci{index}.slice'
    (units / slice_name).write_text('[Slice]\nMemoryMax=12G\nCPUQuota=300%\n')
    unit = daemon.read_text().replace('[Service]', f'[Service]\nSlice={slice_name}')
    daemon.write_text(unit)
    unit = re.sub(r'^ExecStart=.*$', 'ExecStart=/ci/runner/bin/Runner.Listener run', unit, flags=re.M)
    unit = unit.replace('Environment=_DOCKERD_ROOTLESS_CHILD=1',
        f'NoNewPrivileges=yes\nRootDirectoryStartOnly=yes\nWorkingDirectory=-/ci/runner\n'
        f'ExecStartPre=+/usr/bin/python3 {install}/prepare.py {index}\n'
        'Environment=DOCKER_HOST=unix:///ci/run/docker.sock')
    unit = unit.replace('Restart=on-failure', 'Restart=always').replace('RestartSec=10', 'RestartSec=30')
    (units / (name + '.service')).write_text(unit + '\n[Unit]\nRequires=beeline-ci-network.service\nAfter=beeline-ci-network.service\nStartLimitIntervalSec=0\n[Install]\nWantedBy=multi-user.target\n')
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'start', 'beeline-ci-network.service'], check=True)
print('Installed but not started: approve external-contributor policy and start token relay first.')
