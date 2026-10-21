"""Capture mock A and verify independent destinations on a leased proof emulator."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

def adb(*words):
    return subprocess.check_output(['adb', '-s', args.serial, *words])

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/lifecycle-a.xml')
    raw = adb('shell', 'cat', '/sdcard/lifecycle-a.xml')
    return raw, list(ET.fromstring(raw).iter('node'))

def tap(label=None, resource=None):
    _, current = nodes()
    node = next(n for n in current if (n.get('content-desc') == label if label else n.get('resource-id') == resource))
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    time.sleep(.3)
    return node.attrib

snapshot = json.loads(Path(__file__).with_name('corner-callsite-proof-snapshot.json').read_text())
receipts = []
def capture(name):
    raw, current = nodes()
    (out / f'{name}.xml').write_bytes(raw)
    (out / f'{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    receipts.append({'frame': name, 'texts': [n.get('text') for n in current if n.get('text')]})

def destination(expected):
    _, current = nodes()
    assert any(n.get('content-desc') == f'Destination {expected}' for n in current), expected
    receipts.append({'destination': expected})

for theme in ['bone', 'obsidian']:
    adb('shell', 'am', 'force-stop', 'app.usebeeline')
    adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
    time.sleep(3)
    tap(label=theme)
    capture(f'android-{theme}-collapsed')
    tap(resource='notification-run-expand-lead')
    capture(f'android-{theme}-expanded')
    for resource, expected in [
        ('notification-run-cell-url-lead', 'https://github.com/Beeline-Work/beeline/pull/2742'),
        ('notification-run-cell-corner-lead', 'corner-2742'),
        ('notification-run-cell-url-issue', 'https://github.com/Beeline-Work/beeline/issues/2744'),
    ]:
        receipts.append({'target': resource, 'bounds': tap(resource=resource)['bounds']})
        destination(expected)
    _, current = nodes()
    assert not any(n.get('resource-id') == 'notification-run-cell-corner-issue' for n in current)
    tap(label='Next frame')
    tap(resource='notification-run-expand-long-0')
    capture(f'android-{theme}-single-long')
    tap(resource='notification-run-more-long-0')
    _, current = nodes()
    assert any(n.get('resource-id') == 'notification-run-cell-long-4' for n in current)
    tap(label='Next frame')
    capture(f'android-{theme}-dm-callsite')
    tap(label='Open corner requested-work')
    destination(next(m['daemonFact']['cornerId'] for m in snapshot['dm']['messages'] if m.get('daemonFact')))
    tap(label='Next frame')
    capture(f'android-{theme}-parent-callsite')
    tap(label='Open corner requested-work')
    destination(next(m['daemonFact']['cornerId'] for m in snapshot['parent']['messages'] if m.get('daemonFact')))
(out / 'android-receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
print('PASS: both themes, collapsed/expanded/single/long/DM and parent call sites, separate destinations')
