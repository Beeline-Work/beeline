"""Run only the exact activation payload reviewed in PR 2960."""
import hashlib
from pathlib import Path
import subprocess

payload = Path('/home/lunchbox/.local/state/beeline/corners/d0dedb54-162b-4185-a9ef-0e241540a1d4/scripts/activate-isolated-ci-runners.py')
expected = 'c507fb323fe3db758d71d896d55f2477a612e425d66925d89927c93eff3f7049'
if hashlib.sha256(payload.read_bytes()).hexdigest() != expected:
    raise SystemExit('Activation payload SHA-256 mismatch; refusing execution')
subprocess.run(['/usr/bin/python3', str(payload)], check=True)
