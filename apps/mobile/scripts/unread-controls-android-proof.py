"""Verify passive unread controls in the isolated Android DM fixture."""
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
    adb('shell', 'uiautomator', 'dump', '/sdcard/unread-proof.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/unread-proof.xml')).iter('node'))

def texts(rows):
    return [node.get('text') or node.get('content-desc') or '' for node in rows if node.get('text') or node.get('content-desc')]

def center(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    return str((left + right) // 2), str((top + bottom) // 2)

# Wait for Metro's first bundle and dismiss development-client menus.
for _ in range(10):
    rows = nodes()
    if any('3 unread agent messages' in text for text in texts(rows)):
        break
    for label in ['Continue', 'Close']:
        option = next((node for node in rows if label in (node.get('text'), node.get('content-desc'))), None)
        if option is not None:
            adb('shell', 'input', 'tap', *center(option))
            time.sleep(.5)
            rows = nodes()
    time.sleep(1)
seen = texts(rows)
assert any('3 unread agent messages' in text for text in seen), seen
assert 'NEW' in seen, seen
assert '3' in seen or any(text.startswith('3 new messages') for text in seen), seen
assert any('Jump to newest message' in text for text in seen), seen
assert not any('catch up' in text.lower() or 'catch-up' in text.lower() for text in seen), seen
marker = next(node for node in rows if node.get('content-desc') == 'Unread messages begin here')
assert marker.get('clickable') == 'false', marker.attrib
x, y = center(marker)
adb('shell', 'input', 'tap', x, y)
time.sleep(.3)
after_tap = texts(nodes())
assert seen == after_tap, (seen, after_tap)
adb('shell', 'input', 'swipe', x, y, x, y, '900')
time.sleep(.3)
after_hold = texts(nodes())
assert seen == after_hold, (seen, after_hold)
(out / 'android-dm-unread.png').write_bytes(adb('exec-out', 'screencap', '-p'))
result = {'device': args.device, 'result': 'PASS', 'text': seen, 'dividerClickable': False, 'tapOpenedNothing': True, 'longPressOpenedNothing': True, 'badge': '3'}
(out / 'android-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
