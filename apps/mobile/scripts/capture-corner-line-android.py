"""Capture production corner rows on a leased Android emulator and verify taps."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
output = Path(args.out)
output.mkdir(parents=True, exist_ok=True)

def adb(*argv):
    return subprocess.check_output(['adb', '-s', args.serial, *argv])

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/corner-line-proof.xml')
    raw = adb('shell', 'cat', '/sdcard/corner-line-proof.xml')
    return raw, list(ET.fromstring(raw).iter('node'))

def bounds(node):
    return list(map(int, re.findall(r'\d+', node.get('bounds'))))

def press(node):
    left, top, right, bottom = bounds(node)
    adb('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    time.sleep(.15)

# Harness controls keep fixed bounds in every scene. Reuse their observed nodes.
_, initial = nodes()
controls = {n.get('content-desc'): n for n in initial if n.get('content-desc') in
            ['bone', 'obsidian', 'room', 'dm', 'parent', 'opened', 'merged', 'closed']}

def choose(label):
    press(controls[label])

latest = []
def destination():
    global latest
    _, latest = nodes()
    return next(n.get('text') for n in latest if n.get('resource-id') == 'proof-destination')

receipts = []
for theme in ['bone', 'obsidian']:
    choose(theme)
    for surface in ['room', 'dm', 'parent']:
        choose(surface)
        for state in ['opened', 'merged', 'closed']:
            choose(state)
            raw, current = nodes()
            markers = [n for n in current if n.get('resource-id', '').startswith('corner-opened-marker-')]
            assert len(markers) == 1, (surface, state, markers)
            expected = ('Merged requested-work PR 2832' if state == 'merged' else
                        'Closed close-requested-work' if state == 'closed' else 'Opened requested-work')
            texts = [n.get('text', '').replace('\u00a0', ' ') for n in current]
            if state == 'merged':
                assert 'Merged requested-work' in texts and ' PR 2832' in texts, texts
            else:
                assert expected in texts, expected
            name = f'android-{theme}-{surface}-{state}'
            (output / f'{name}.xml').write_bytes(raw)
            (output / f'{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
            # The row text opens the corner; press its left edge outside the PR span.
            left, top, right, bottom = bounds(markers[0])
            adb('shell', 'input', 'tap', str(left + 80), str(top + 40))
            corner = destination()
            assert re.fullmatch(r'[a-f0-9-]{36}', corner or ''), corner
            receipt = {'name': name, 'copy': expected, 'corner': corner, 'status': 'PASS'}
            current = latest
            completions = [n for n in current if n.get('resource-id', '').startswith('notification-run-cell-corner-')]
            assert len(completions) == (1 if state == 'merged' and surface != 'room' else 0)
            if completions:
                press(completions[0])
                assert destination() == corner
                receipt['roomCompletion'] = corner
            if state == 'merged':
                current = latest
                # Android exposes an inline Text link as a virtual accessibility node.
                pr = next(n for n in current if n.get('content-desc', '').replace('\u00a0', ' ').strip() in ['PR 2832', 'Open PR 2832'])
                press(pr)
                result = destination()
                assert result == 'https://github.com/owner/widgets/pull/2832', result
                receipt['pullRequest'] = result
            else:
                assert not any('PR 2832' in n.get('content-desc', '').replace('\u00a0', ' ') for n in current)
            receipts.append(receipt)
            print(name, 'PASS', flush=True)
(output / 'android-receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
