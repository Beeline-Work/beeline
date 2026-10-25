"""Launch only the reviewed existing-App recovery; no manifest or new key."""
import hashlib
from pathlib import Path
import subprocess

payload = Path('/home/lunchbox/.local/state/beeline/corners/d0dedb54-162b-4185-a9ef-0e241540a1d4/scripts/ci-runner-systemd/resume.py')
expected = '6471e17513ab584568f4655688db228f3b88c6958569282b9c352404b2f41794'
if hashlib.sha256(payload.read_bytes()).hexdigest() != expected:
    raise SystemExit('Resume payload SHA-256 mismatch; refusing execution')
subprocess.run(['/usr/bin/systemd-run', '--unit=beeline-ci-existing-app-resume',
    '--collect', '--no-block', '-p', 'User=root', '-p', 'Group=root',
    '-p', 'UMask=0077', '-p', 'LimitCORE=0', '-p', 'RuntimeMaxSec=900',
    '-p', 'EnvironmentFile=/etc/beeline-ci-registration.conf',
    '-p', 'LoadCredentialEncrypted=github-app-key:/etc/credstore.encrypted/beeline-ci-app-key',
    '-p', 'StandardOutput=journal', '-p', 'StandardError=journal',
    '/usr/bin/python3', str(payload)], check=True)
print('Resume queued; watch /run/beeline-ci-rollout/status for the next PASS or FAILED.', flush=True)
