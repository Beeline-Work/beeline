"""Exercise the production Catch up sheet in an isolated Android DM fixture."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

def adb(*command):
    return subprocess.check_output(['adb', '-s', args.device, *command], timeout=30)

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/catch-up-proof.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/catch-up-proof.xml')).iter('node'))

def text():
    return ' | '.join(node.get('text') or node.get('content-desc') or '' for node in nodes())

def tap(label):
    node = next(node for node in nodes() if label in (node.get('text'), node.get('content-desc')))
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    time.sleep(.5)

# These assertions observe native-rendered text, not the report's internals.
tap('Open catch up')
seen = text()
assert 'Since 15:26 · newest 15:45' in seen, seen
for phrase in ['fix merged and Android verification passed', 'decided to retry the release', 'release failed because the build timed out', 'Nothing is waiting on you.', 'Ask an agent']:
    assert phrase.lower() in seen.lower(), (phrase, seen)
assert 'From Ruby.' not in seen, seen
(out / 'android-catch-up.png').write_bytes(adb('exec-out', 'screencap', '-p'))
adb('shell', 'input', 'keyevent', '4')
time.sleep(.5)
tap('Show unavailable summary')
failed = text()
assert 'Summary unavailable' in failed and 'Retry summary' in failed, failed
(out / 'android-unavailable.png').write_bytes(adb('exec-out', 'screencap', '-p'))
tap('Retry summary')
recovered = text()
assert 'Summary unavailable' not in recovered, recovered
assert 'fix merged and Android verification passed' in recovered, recovered
result = {'reproduction': 'catch-up-1', 'device': args.device, 'timeZone': 'America/New_York', 'sheet': seen, 'unavailable': failed, 'recovered': recovered, 'result': 'PASS'}
(out / 'android-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
