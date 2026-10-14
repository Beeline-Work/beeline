"""Capture production PR-card fixture and exercise its Android actions."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--phase', choices=['before', 'after'], required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

def adb(*cmd):
    return subprocess.check_output(['adb', '-s', args.device, *cmd])

def tree():
    adb('shell', 'uiautomator', 'dump', '/sdcard/pr-cards.xml')
    return ET.fromstring(adb('shell', 'cat', '/sdcard/pr-cards.xml'))

def tap(label):
    nodes = [node for node in tree().iter('node') if node.get('text') == label or node.get('content-desc') == label or node.get('resource-id') == label]
    if not nodes:
        raise AssertionError(f'Missing Android control: {label}')
    node = nodes[0]
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
    time.sleep(0.7)

results = []
for theme in ['bone', 'obsidian']:
    adb('shell', 'am', 'force-stop', 'app.usebeeline')
    adb('shell', 'am', 'start', '-n', 'app.usebeeline/.MainActivity')
    time.sleep(2)
    tap(theme)
    (out / f'android-{args.phase}-{theme}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    xml = adb('shell', 'uiautomator', 'dump', '/sdcard/pr-cards.xml')
    xml = adb('shell', 'cat', '/sdcard/pr-cards.xml')
    (out / f'android-{args.phase}-{theme}.xml').write_bytes(xml)
    if args.phase == 'after':
        tap('Corner →')
        assert any(n.get('text') == 'Corner: single-corner' for n in tree().iter('node'))
        tap('View ↗')
        assert any(n.get('text') == 'View: https://github.com/Beeline-Work/beeline/pull/2462' for n in tree().iter('node'))
        tap('notification-run-cell-corner-grouped')
        assert any(n.get('text') == 'Corner: grouped-corner' for n in tree().iter('node'))
        tap('notification-run-cell-url-grouped')
        assert any(n.get('text') == 'View: https://github.com/Beeline-Work/beeline/pull/2456' for n in tree().iter('node'))
        tap('notification-run-expand-single')
        tap('notification-run-contracted-single')
        tap('notification-run-cell-url-single')
        assert any(n.get('text') == 'View: https://github.com/Beeline-Work/beeline/pull/2462' for n in tree().iter('node'))
        tap('notification-run-expand-single')
        results.append({'theme': theme, 'singleCorner': 'single-corner', 'singleView': 'PR #2462',
                        'groupedCorner': 'grouped-corner', 'groupedView': 'PR #2456',
                        'selectedView': 'PR #2462', 'expandCollapse': 'PASS', 'status': 'PASS'})
    else:
        nodes = list(ET.fromstring(xml).iter('node'))
        assert any(n.get('text') == 'PR 1 merged' for n in nodes)
        assert not any(n.get('resource-id') == 'notification-run-cell-url-grouped' for n in nodes)
        results.append({'theme': theme, 'singleHeader': 'PR 1 merged', 'groupedViewPresent': False,
                        'status': 'REPRODUCED corner-pr-cards-1'})
(out / f'android-{args.phase}-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'phase': args.phase, 'captures': 2, 'actions': results}))
