"""Configure over private stdin, or run in the engine's private network."""
import os
from pathlib import Path
import sys
import time


def wait_for_child():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            pid = int(Path('/ci/run/rootlesskit/child_pid').read_text())
            if pid > 1 and os.path.samefile(f'/proc/{pid}/exe', '/usr/bin/rootlesskit'):
                if all(not os.path.samefile(f'/proc/{pid}/ns/{ns}', f'/proc/self/ns/{ns}')
                       for ns in ['user', 'net']):
                    return pid
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise SystemExit('Engine child namespace not ready after 30 seconds')


def listener_command(pid):
    return ['nsenter', '--user', '--net', '--target', str(pid),
        '--setuid=0', '--setgid=0', '--', '/usr/bin/setpriv',
        '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all',
        '--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked',
        '--no-new-privs', '--', '/ci/runner/bin/Runner.Listener', 'run']

if sys.argv[1] == 'configure':
    token = sys.stdin.readline(4096).strip()
    if not token:
        raise SystemExit('Missing registration authorization')
    os.environ['ACTIONS_RUNNER_INPUT_TOKEN'] = token
    os.execv('/ci/runner/bin/Runner.Listener', ['Runner.Listener', *sys.argv[1:]])
else:
    pid = wait_for_child()
    # Namespace root maps to this shard's unprivileged host UID.
    os.environ['RUNNER_ALLOW_RUNASROOT'] = '1'
    os.execv('/usr/bin/nsenter', listener_command(pid))
