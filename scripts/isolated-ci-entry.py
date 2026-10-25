"""Configure over private stdin, or run in the engine's private network."""
import os
from pathlib import Path
import sys

if sys.argv[1] == 'configure':
    token = sys.stdin.readline(4096).strip()
    if not token:
        raise SystemExit('Missing registration authorization')
    os.environ['ACTIONS_RUNNER_INPUT_TOKEN'] = token
    os.execv('/ci/runner/bin/Runner.Listener', ['Runner.Listener', *sys.argv[1:]])
else:
    pid = int(Path('/ci/run/rootlesskit/child_pid').read_text())
    if pid <= 1:
        raise SystemExit('Invalid engine namespace PID')
    # Namespace root maps to this shard's unprivileged host UID.
    os.environ['RUNNER_ALLOW_RUNASROOT'] = '1'
    os.execv('/usr/bin/nsenter', ['nsenter', '--user', '--net', '--target', str(pid),
        '--setuid=0', '--setgid=0', '--', '/ci/runner/bin/Runner.Listener', 'run'])
