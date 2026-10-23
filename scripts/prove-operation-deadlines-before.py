"""Capture regression failures against an explicit baseline, restoring edits afterward."""
from pathlib import Path
import argparse
import os
import subprocess
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', required=True)
args = parser.parse_args()
paths = [
 'apps/mobile/sources/sync/transport/monolith-operation.ts',
 'apps/mobile/sources/app/(app)/beeline/human-profile.tsx',
 'apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx',
 'apps/auth/src/github.ts', 'apps/auth/src/github-manifest.ts',
 'apps/server/src/object-storage.ts', 'apps/server/src/auth.ts',
 'apps/server/src/store-download-reports.ts', 'apps/server/src/cdp-client.ts',
 'apps/server/src/evm-chain.ts',
]
fixed = {path: Path(path).read_bytes() for path in paths}
output = Path('apps/mobile/evidence/operation-deadlines')
output.mkdir(parents=True, exist_ok=True)
try:
 for path in paths:
  Path(path).write_bytes(subprocess.check_output(['git', 'show', args.baseline + ':' + path]))
 with (output / 'before-client-and-back.txt').open('w') as log:
  result = subprocess.run([
   'npm', 'test', '--prefix', 'apps/mobile', '--', '--run',
   'sources/sync/transport/monolith-operation.test.ts',
   'sources/components/buzz/CornerActionsSheet.test.tsx',
   'sources/app/(app)/beeline/human-profile.waiting.test.tsx', '--testTimeout', '100',
  ], env={**os.environ, 'WAITING_BASELINE': '1'}, stdout=log, stderr=subprocess.STDOUT, timeout=90)
  print('Baseline client/back exit:', result.returncode, flush=True)
 with (output / 'before-outside-calls.txt').open('w') as log:
  result = subprocess.run(['node', '--test', 'scripts/external-request-deadlines.test.mjs'],
    stdout=log, stderr=subprocess.STDOUT, timeout=20)
  print('Baseline outside-call guard exit:', result.returncode, flush=True)
finally:
 for path, data in fixed.items():
  Path(path).write_bytes(data)

 for path in output.glob("before-*.txt"):
  path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()).rstrip() + "\n")
