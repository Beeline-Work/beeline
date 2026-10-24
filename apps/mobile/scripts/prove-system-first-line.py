"""Replay SYSTEM-FIRST-LINE on a leased emulator running disclosure-rows-native-proof."""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--phase', choices=['before', 'after'], required=True)
args = parser.parse_args()
out = Path('evidence/system-first-line') / args.phase
out.mkdir(parents=True, exist_ok=True)


def adb(*parts):
    return subprocess.check_output(['adb', '-s', args.serial, *parts])


def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/system-first-line.xml')
    data = adb('shell', 'cat', '/sdcard/system-first-line.xml')
    return list(ET.fromstring(data).iter('node'))


def find(key):
    return next(n for n in nodes() if key in (n.get('resource-id'), n.get('content-desc')))


def bounds(n):
    return list(map(int, re.findall(r'\d+', n.get('bounds'))))


def tap(x, y):
    adb('shell', 'input', 'tap', str(round(x)), str(round(y)))
    time.sleep(.3)


def capture(name):
    (out / f'android-{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))


density = int(re.findall(r'\d+', adb('shell', 'wm', 'density').decode())[-1]) / 160
results = {}
for theme in ['bone', 'obsidian']:
    short = bounds(find('system-line-short-proof'))
    short_text = bounds(find('system-line-text-short-proof'))
    row = bounds(find('system-line-long-proof'))
    control = bounds(find('system-line-toggle-long-proof'))
    assert control[3] - control[1] >= math.floor(44 * density)
    capture(f'{theme}-closed')
    # The chevron's first-line edge stays visible even for a long expanded row.
    tap(control[0] + 5 * density, control[1] + 5 * density)
    assert find('system-line-toggle-long-proof').get('content-desc') == 'Show less of system message'
    expanded = bounds(find('system-line-long-proof'))
    assert expanded[3] - expanded[1] > row[3] - row[1]
    capture(f'{theme}-open')
    opened_control = bounds(find('system-line-toggle-long-proof'))
    tap(opened_control[0] + 5 * density, opened_control[1] + 5 * density)
    assert find('system-line-toggle-long-proof').get('content-desc') == 'Show full system message'
    assert bounds(find('system-line-long-proof')) == row
    # Tap the first subject span rather than the chevron. The callback receipt
    # stands in for navigation; expansion must remain closed.
    indent = 22 if args.phase == 'after' else 0
    tap(row[0] + (indent + 24) * density, row[1] + 13 * density)
    assert find('system-proof-action').get('text') == 'Identity: scheduler'
    assert find('system-line-toggle-long-proof').get('content-desc') == 'Show full system message'
    results[theme] = {'short': short, 'shortText': short_text, 'row': row,
                      'control': control, 'expanded': expanded,
                      'nameTapWithoutToggle': True, 'expandCollapse': True}
    if args.phase == 'after':
        before = json.loads((out.parent / 'before/android-results.json').read_text())[theme]
        assert short == before['short'] and short_text == before['shortText'], 'short row moved'
        assert control[1] < row[1] + 19 * density, 'disclosure below first text line'
    print(f'PASS SYSTEM-FIRST-LINE {args.phase} {theme}', flush=True)
    if theme == 'bone':
        switch = bounds(find('Switch theme'))
        tap((switch[0] + switch[2]) / 2, (switch[1] + switch[3]) / 2)
(out / 'android-results.json').write_text(json.dumps(results, indent=2) + '\n')
