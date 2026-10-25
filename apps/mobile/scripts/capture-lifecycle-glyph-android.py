"""Capture R1 through production native rows and verify corner navigation."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--phase', choices=['before', 'after'], required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
output = Path(args.out)
output.mkdir(parents=True, exist_ok=True)

def adb(*argv):
    return subprocess.check_output(['adb', '-s', args.serial, *argv])

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/lifecycle-glyph.xml')
    raw = adb('shell', 'cat', '/sdcard/lifecycle-glyph.xml')
    return raw, list(ET.fromstring(raw).iter('node'))

def press(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    time.sleep(.25)

def find(current, key, value):
    return next(node for node in current if node.get(key) == value)

receipts = []
for theme in ['bone', 'obsidian']:
    adb('shell', 'am', 'force-stop', 'app.usebeeline')
    adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
    time.sleep(3)
    _, current = nodes()
    press(find(current, 'content-desc', theme))
    _, current = nodes()
    press(find(current, 'resource-id', 'notification-run-expand-r1'))
    raw, current = nodes()
    texts = [node.get('text', '') for node in current if node.get('text')]
    for expected in ['#2939', '#2914']:
        assert any(expected in text for text in texts), texts
    name = f'android-{args.phase}-{theme}'
    (output / f'{name}.xml').write_bytes(raw)
    (output / f'{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    press(find(current, 'resource-id', 'notification-run-cell-url-event-0'))
    _, current = nodes()
    destination = find(current, 'resource-id', 'destination').get('text')
    assert destination == 'corner-2939', destination
    press(find(current, 'content-desc', 'Open corner lifecycle-glyphs'))
    _, current = nodes()
    marker_destination = find(current, 'resource-id', 'destination').get('text')
    assert marker_destination == 'corner-open', marker_destination
    receipts.append({'name': name, 'texts': texts, 'prDestination': destination,
                     'markerDestination': marker_destination, 'platform': 'native Android'})
(output / f'android-{args.phase}-receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
print(json.dumps(receipts, indent=2))
