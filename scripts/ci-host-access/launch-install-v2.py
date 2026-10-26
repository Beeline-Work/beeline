"""Run only the reviewed immutable-CI bootstrap bytes, without sibling imports."""
import hashlib
from pathlib import Path

payload = Path(__file__).resolve().with_name('install.py')
data = payload.read_bytes()
expected = 'ac6df3cc5560f16d83dbe268bd112e3d08bddeaef219c54dbb9c175ca8b69278'
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit('Reviewed CI installer SHA-256 mismatch')
exec(compile(data, str(payload), 'exec'), {'__name__': '__main__', '__file__': str(payload)})
