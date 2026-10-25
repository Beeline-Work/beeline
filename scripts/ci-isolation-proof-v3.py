"""Read-only pre-registration probes; nonzero if any shard fails."""
import subprocess

PROBE = r'''
import errno
from pathlib import Path
import socket
import sys

status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
failed = int(status['CapEff'].strip(), 16) != 0 or status['NoNewPrivs'].strip() != '1'
for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs']:
    print(key, status[key].strip(), flush=True)
# Literal host addresses observed with ip -br addr on squire.
host_addresses = [
    '172.93.111.86', '100.97.62.62', 'fd7a:115c:a1e0::1f34:3e3e',
    '172.23.0.1', '172.17.0.1', '172.26.0.1', '172.18.0.1',
    '172.25.0.1', '172.21.0.1', '172.24.0.1', '172.19.0.1',
    '172.27.0.1', '172.22.0.1', '172.20.0.1',
]
# Every target below has a live listener on squire; slirp4netns maps 10.0.2.2 to squire's loopback.
targets = [('10.0.2.2', 22), ('10.0.2.2', 11434), ('100.97.62.62', 443), ('fd7a:115c:a1e0::1f34:3e3e', 443)]
targets += [(host, 22) for host in host_addresses]
probes = [(host, port, False) for host, port in targets]
probes += [(host, 443, False) for host in ['192.168.1.1', '169.254.169.254']]
probes += [('1.1.1.1', 443, True)]
blocked_errors = {errno.ECONNREFUSED, errno.ETIMEDOUT, errno.ENETUNREACH, errno.EHOSTUNREACH}
for host, port, control in probes:
    reachable = False
    valid_block = False
    try:
        with socket.create_connection((host, port), timeout=2):
            reachable = True
        result = 'REACHABLE'
    except OSError as error:
        valid_block = isinstance(error, TimeoutError) or error.errno in blocked_errors
        result = f'{type(error).__name__} errno={error.errno}'
    passed = reachable if control else (not reachable and valid_block)
    failed |= not passed
    print(host, port, 'CONTROL' if control else 'BLOCK', result, 'PASS' if passed else 'FAIL', flush=True)
sys.exit(1 if failed else 0)
'''

ENTRY = '''
import os
from pathlib import Path
pid = int(Path('/ci/run/rootlesskit/child_pid').read_text())
if pid <= 1 or os.stat(f'/proc/{pid}').st_uid != os.getuid():
    raise SystemExit('Invalid engine child ownership')
if not os.path.samefile(f'/proc/{pid}/exe', '/usr/bin/rootlesskit'):
    raise SystemExit('Unexpected engine child executable')
if any(os.path.samefile(f'/proc/{pid}/ns/{ns}', f'/proc/self/ns/{ns}') for ns in ['user', 'net']):
    raise SystemExit('Engine namespaces are not isolated')
os.execv('/usr/bin/nsenter', ['nsenter', '--user', '--net', '--target', str(pid),
    '--setuid=0', '--setgid=0', '--', '/usr/bin/setpriv',
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
    '--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked',
    '--no-new-privs', '--', '/usr/bin/python3', '-c', PROBE])
'''.replace('PROBE', repr(PROBE))

import socket
LIVE = [('127.0.0.1', 22), ('127.0.0.1', 11434), ('100.97.62.62', 443), ('fd7a:115c:a1e0::1f34:3e3e', 443), ('172.93.111.86', 22),
    ('172.17.0.1', 22), ('172.18.0.1', 22), ('172.19.0.1', 22), ('172.20.0.1', 22), ('172.21.0.1', 22), ('172.22.0.1', 22),
    ('172.23.0.1', 22), ('172.24.0.1', 22), ('172.25.0.1', 22), ('172.26.0.1', 22), ('172.27.0.1', 22), ('100.97.62.62', 22), ('fd7a:115c:a1e0::1f34:3e3e', 22)]
for host, port in LIVE:
    socket.create_connection((host, port), timeout=2).close()
    print('host live', host, port, flush=True)

failed = False
for index in range(1, 5):
    name = f'beeline-ci-shard-{index}'
    print(name, flush=True)
    result = subprocess.run(['/usr/bin/systemd-run', '--wait', '--pipe', '--collect',
        f'--unit={name}-isolation-proof', '-p', f'User={name}',
        '-p', f'RootDirectory=/var/lib/{name}/root', '-p', 'MountAPIVFS=yes',
        '-p', 'BindReadOnlyPaths=/usr', '-p', f'BindPaths=/var/lib/{name}/state:/ci',
        '-p', 'NoNewPrivileges=yes', '/usr/bin/python3', '-c', ENTRY], timeout=120)
    failed |= result.returncode != 0
raise SystemExit(1 if failed else 0)
