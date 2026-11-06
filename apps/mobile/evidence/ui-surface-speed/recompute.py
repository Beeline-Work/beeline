"""Recompute the checked-in summaries from sanitized native records."""
import argparse
import gzip
import json
import os
import pathlib
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
evidence = pathlib.Path(__file__).resolve().parent
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
with gzip.open(evidence / 'raw-records.json.gz', 'rt') as source:
    records = json.load(source)
for name, content in records.items():
    path = (output / name).resolve()
    if not path.is_relative_to(output):
        raise ValueError(f'Invalid record path: {name}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
env = {**os.environ, 'UI_SURFACE_PROOF_ROOT': str(output)}
commands = [
    ['analyze-navigation.py', 'before-final', 'after-final', 'after-members-final'],
    ['analyze-updates.py'],
]
for script, *arguments in commands:
    subprocess.run([sys.executable, str(evidence / script), *arguments],
                   env=env, check=True, capture_output=True, text=True)
for name in ['measurements.json', 'update-measurements.json']:
    actual = json.loads((output / name).read_text())
    expected = json.loads((evidence / name).read_text())
    if actual != expected:
        raise AssertionError(f'Recomputed {name} differs')
    print(f'{name}: reproduced')
