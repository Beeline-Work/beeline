"""Run only the exact activation payload reviewed in PR 2960."""
import hashlib
from pathlib import Path
import subprocess

payload = Path('/home/lunchbox/.local/state/beeline/corners/d0dedb54-162b-4185-a9ef-0e241540a1d4/scripts/activate-isolated-ci-runners.py')
expected = '23ef4a290585a94be1b9fc14661253feee988666d189cdf81e2c118239f67ada'
if hashlib.sha256(payload.read_bytes()).hexdigest() != expected:
    raise SystemExit('Activation payload SHA-256 mismatch; refusing execution')
subprocess.run(['/usr/bin/python3', str(payload)], check=True)
