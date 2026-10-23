"""Capture both themes and verify edge taps on a task-owned Android emulator."""
import argparse
import json
import math
import pathlib
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--phase', choices=['before', 'after'], required=True)
args = parser.parse_args()
out = pathlib.Path('evidence/disclosure-top-edge') / args.phase
out.mkdir(parents=True, exist_ok=True)


def adb(*parts):
    return subprocess.check_output(['adb', '-s', args.serial, *parts])


def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/disclosure-proof.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/disclosure-proof.xml')).iter('node'))


def find(label):
    return next(node for node in nodes() if node.get('content-desc') == label)


def bounds(node):
    return tuple(map(int, re.findall(r'\d+', node.get('bounds'))))


def tap(node, edge=False):
    x1, y1, x2, y2 = bounds(node)
    adb('shell', 'input', 'tap', str(x2 - 3 if edge else x1 + 3), str(y1 + 3 if edge else y2 - 3))
    time.sleep(.3)


density = int(re.findall(r'\d+', adb('shell', 'wm', 'density').decode())[-1]) / 160
results = {'serial': args.serial, 'phase': args.phase, 'density': density, 'themes': {}}
for theme in ['bone', 'obsidian']:
    # Starts in Bone; the theme button switches to Obsidian after the first pass.
    screen = adb('exec-out', 'screencap', '-p')
    (out / f'android-{theme}.png').write_bytes(screen)
    rows = ['1 step, expandable', '1 issue filed · 1 PR merged', '1 check passed']
    receipts = []
    for label in rows:
        row = find(label)
        x1, y1, x2, y2 = bounds(row)
        # Android rounds the two bounds independently to whole device pixels.
        assert y2 - y1 >= math.floor(44 * density), f'{label}: target below rounded 44dp'
        tap(row, edge=True)
        expanded = nodes()
        if label.startswith('1 step'):
            assert any(node.get('resource-id', '').endswith('tool-ledger-line-read') for node in expanded)
        elif label.startswith('1 issue'):
            assert any(node.get('content-desc') == 'Open Issue #2722' for node in expanded)
        else:
            assert any('Required checks' in node.get('text', '') for node in expanded)
        tap(find(label))
        collapsed = nodes()
        assert not any(node.get('resource-id', '').endswith('tool-ledger-line-read') for node in collapsed)
        assert not any(node.get('content-desc') == 'Open Issue #2722' for node in collapsed)
        assert not any('Required checks' in node.get('text', '') for node in collapsed)
        receipts.append({'label': label, 'heightDp': (y2 - y1) / density, 'edgeTaps': 'expanded then collapsed'})
    (out / f'android-{theme}.xml').write_bytes(adb('shell', 'cat', '/sdcard/disclosure-proof.xml'))
    results['themes'][theme] = receipts
    if theme == 'bone':
        tap(find('Switch theme'))
(out / 'android-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
