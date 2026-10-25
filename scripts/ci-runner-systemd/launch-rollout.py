"""Launch only the reviewed manifest rollout in a bounded root systemd unit."""
import hashlib
from pathlib import Path
import subprocess

payload = Path('/home/lunchbox/.local/state/beeline/corners/d0dedb54-162b-4185-a9ef-0e241540a1d4/scripts/ci-runner-systemd/rollout.py')
expected = 'c5cba3648c0fb3aba39f2bd6f553e8c7418705443e7a5e8fb1735f8b1c25d95d'
if hashlib.sha256(payload.read_bytes()).hexdigest() != expected:
    raise SystemExit('Rollout payload SHA-256 mismatch; refusing execution')
# Two owner browser steps can each take twenty minutes, beyond a command turn.
# The journal retains sanitized output; the transient service survives this turn.
subprocess.run(['/usr/bin/systemd-run', '--unit=beeline-ci-manifest-rollout',
    '--collect', '--no-block', '-p', 'User=root', '-p', 'Group=root',
    '-p', 'UMask=0077', '-p', 'LimitCORE=0', '-p', 'RuntimeMaxSec=3000',
    '-p', 'StandardOutput=journal', '-p', 'StandardError=journal',
    '/usr/bin/python3', str(payload)], check=True)
print('Rollout queued. Watch /run/beeline-ci-rollout/status for the exact OWNER_OPEN URL on squire.', flush=True)
