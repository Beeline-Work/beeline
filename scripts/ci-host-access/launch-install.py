"""Run only the reviewed immutable-CI bootstrap bytes, without sibling imports."""
import hashlib
from pathlib import Path

payload = Path(__file__).resolve().with_name('install.py')
data = payload.read_bytes()
expected = 'c1457375839e6a6707cf12dd75d1d57afefaba9f6bba8edd3f9e2ce8f4452ad0'
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit('Reviewed CI installer SHA-256 mismatch')
exec(compile(data, str(payload), 'exec'), {'__name__': '__main__', '__file__': str(payload)})
