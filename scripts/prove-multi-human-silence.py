"""Assert the isolated Android call path after pressing Join in the native fixture."""
import argparse
import json
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--phase', choices=['old', 'fixed', 'compat', 'solo'], required=True)
parser.add_argument('--origin', default='http://127.0.0.1:18097')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()


def result():
    return json.load(urllib.request.urlopen(args.origin + '/result'))


def post(path, body=None):
    request = urllib.request.Request(args.origin + path, data=json.dumps(body or {}).encode(),
                                     headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(request))


before = result()
assert before['humans'] == 2 and before['observations'][-1]['joined'], before
started = time.monotonic()
if args.phase in ['old', 'fixed']:
    while time.monotonic() - started < 60:
        post('/say', {'text': 'How are you doing today?'})
        time.sleep(5)
elif args.phase == 'compat':
    time.sleep(26)
else:
    post('/first-leave')
    deadline = time.monotonic() + 30
    while result()['humans'] and time.monotonic() < deadline:
        time.sleep(0.5)

after = result()
if args.phase == 'old':
    assert after['humans'] == 1, after
    assert len(after['replies']) > len(before['replies']), after
elif args.phase == 'solo':
    assert after['humans'] == 0 and not after['observations'][-1]['joined'], after
else:
    assert after['humans'] == 2 and after['replies'] == before['replies'], after
    assert all(p['left_at'] is None and p['parked_at'] is None for p in after['participants']), after
    if args.phase == 'compat':
        assert any(path.endswith('/idle') for path in after['operations']), after
        assert any(path.endswith('/resume') for path in after['operations']), after
        assert any(p['kind'] == 1 and not p['muted'] for p in after['secondMicrophone']), after
        assert after['microphoneFrames'][-1] > 0, after
    else:
        post('/stop')
        time.sleep(1)
        assert result()['humans'] == 2, result()

args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps({'phase': args.phase, 'elapsedSeconds': time.monotonic() - started,
                                  'before': before, 'after': after, 'final': result()}, indent=2) + '\n')
print(f'PASS: multi-human-silence-1 {args.phase}')
