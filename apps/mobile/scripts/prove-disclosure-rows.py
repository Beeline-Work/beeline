"""Exercise shared disclosure rows and capture both themes on a leased emulator."""
import argparse
import json
import math
import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--out')
parser.add_argument('--phase', choices=['before', 'after'], default='after')
parser.add_argument('--theme', choices=['bone', 'obsidian'])
parser.add_argument('--open-only', action='store_true')
args = parser.parse_args()
out = pathlib.Path(args.out or f'evidence/disclosure-top-edge/{args.phase}')
out.mkdir(parents=True, exist_ok=True)


def adb(*parts):
    return subprocess.check_output(['adb', '-s', args.serial, *parts])


def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/disclosure-proof.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/disclosure-proof.xml')).iter('node'))


def bounds(node):
    return tuple(map(int, re.findall(r'\d+', node.get('bounds'))))


def scroll(top=False):
    adb('shell', 'input', 'swipe', '500', '500' if top else '2050', '500', '2050' if top else '500', '250')
    time.sleep(.4)


def find(key):
    for _ in range(5):
        for node in nodes():
            if key in [node.get('resource-id'), node.get('content-desc')]:
                x1, y1, x2, y2 = bounds(node)
                if y1 > 120 and y2 < 2350:
                    return node
        scroll()
    raise AssertionError(f'Missing control {key}')


def tap(key):
    node = find(key)
    x1, y1, x2, y2 = bounds(node)
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
    time.sleep(.15)
    return node


def capture(name):
    time.sleep(.5)
    (out / f'{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    (out / f'{name}.xml').write_bytes(adb('shell', 'cat', '/sdcard/disclosure-proof.xml'))


density = int(re.findall(r'\d+', adb('shell', 'wm', 'density').decode())[-1]) / 160
rows = [
    ('tool-run-group-read', 'tool-ledger-line-read'),
    ('1 issue filed · 1 corner merged', 'notification-run-cell-76c08267b80dae037530c6be9e3ebe33d582acb4198d79e878446b65149b2985'),
    ('notification-run-expand-checks', 'notification-run-cell-check'),
    ('notification-run-expand-payments', 'notification-run-cell-pay-1'),
    ('notification-run-expand-notices', 'notification-run-cell-notice-1'),
    ('inline-output-toggle', 'inline-output-body'),
    ('script-toggle', 'script'),
]
results = {'serial': args.serial, 'density': density, 'themes': {}}
if args.open_only:
    for key, _ in rows:
        tap(key)
    for theme in ['bone', 'obsidian']:
        for _ in range(3):
            scroll(top=True)
        current = nodes()
        assert any(n.get('resource-id') == 'tool-run-more-read' for n in current), 'capped steps must retain N more'
        assert not any(n.get('resource-id') == 'tool-ledger-line-edit' for n in current), 'steps must remain capped'
        for index in range(3):
            nodes()
            capture(f'android-{theme}-expanded-{index + 1}')
            scroll()
        results['themes'][theme] = {'groupsOpen': True, 'stepsCapped': True}
        (out / 'android-results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(f'PASS {theme}: all groups open, steps capped', flush=True)
        if theme == 'bone':
            for _ in range(3):
                scroll(top=True)
            tap('Switch theme')
    sys.exit(0)

for theme in ([args.theme] if args.theme else ['bone', 'obsidian']):
    for _ in range(3):
        scroll(top=True)
    nodes()
    capture(f'android-{theme}-collapsed')
    receipts = []
    for key, child in rows:
        node = tap(key)
        assert bounds(node)[3] - bounds(node)[1] >= math.floor(44 * density), f'{key}: touch height'
        expanded = nodes()
        assert any(n.get('resource-id') == child for n in expanded), f'{key}: child not revealed'
        if key == 'tool-run-group-read':
            assert not any(n.get('resource-id') == 'tool-ledger-line-edit' for n in expanded), 'long run must cap at two'
            tap('tool-run-more-read')
            assert any(n.get('resource-id') == 'tool-ledger-line-edit' for n in nodes()), 'N more must reveal remaining steps'
        tap(key)
        assert not any(n.get('resource-id') == child for n in nodes()), f'{key}: child not collapsed'
        receipts.append({'row': key, 'expandedThenCollapsed': True})
    for _ in range(3):
        scroll(top=True)
    for key, _ in rows:
        tap(key)
    for _ in range(3):
        scroll(top=True)
    assert any(n.get('resource-id') == 'tool-run-more-read' for n in nodes()), 'expanded screenshots must retain N more'
    assert not any(n.get('resource-id') == 'tool-ledger-line-edit' for n in nodes()), 'expanded screenshots must cap the steps'
    for index in range(3):
        nodes()
        capture(f'android-{theme}-expanded-{index + 1}')
        scroll()
    results['themes'][theme] = receipts
    (out / 'android-results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'PASS {theme}: shared disclosures, capped steps, 44dp targets', flush=True)
    # Reset disclosure state before switching theme, then return to the top.
    for _ in range(3):
        scroll(top=True)
    for key, _ in rows:
        tap(key)
    for _ in range(3):
        scroll(top=True)
    if theme == 'bone':
        tap('Switch theme')
(out / 'android-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
