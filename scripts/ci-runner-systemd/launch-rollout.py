"""Launch only the reviewed manifest rollout in a bounded root systemd unit."""
import hashlib
from pathlib import Path
import subprocess

payload = Path('/home/lunchbox/.local/state/beeline/corners/d0dedb54-162b-4185-a9ef-0e241540a1d4/scripts/ci-runner-systemd/rollout.py')
expected = 'fe2cf2487c0dd37dde554e9fe975802f79dcb91a91136689174550f1c087eec5'
if hashlib.sha256(payload.read_bytes()).hexdigest() != expected:
    raise SystemExit('Rollout payload SHA-256 mismatch; refusing execution')
# Two owner browser steps can each take twenty minutes, beyond a command turn.
# The journal retains sanitized output; the transient service survives this turn.
subprocess.run(['/usr/bin/systemd-run', '--unit=beeline-ci-manifest-rollout',
    '--collect', '--no-block', '-p', 'User=root', '-p', 'Group=root',
    '-p', 'UMask=0077', '-p', 'LimitCORE=0', '-p', 'RuntimeMaxSec=3000',
    '-p', 'StandardOutput=journal', '-p', 'StandardError=journal',
    '/usr/bin/python3', str(payload)], check=True)
print('Rollout queued. After journal says OWNER_OPEN, open http://127.0.0.1:18765/ on squire.', flush=True)
