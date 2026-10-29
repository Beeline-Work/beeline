"""Measure the failed-upload Retry label on a phone-width Android fixture."""
import argparse
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--device', required=True)
p.add_argument('--out', required=True)
a = p.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
lines = []

def adb(*args, text=True):
    return subprocess.check_output(['adb', '-s', a.device, *args], text=text)

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/retry-wrap.xml')
    xml = adb('shell', 'cat', '/sdcard/retry-wrap.xml')
    return list(ET.fromstring(xml).iter('node'))

def bounds(node):
    return tuple(map(int, re.findall(r'\d+', node.get('bounds'))))

def labeled(name):
    return [node for node in nodes() if node.get('text') == name or node.get('content-desc') == name]

def tap(node):
    x1, y1, x2, y2 = bounds(node)
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))

def check(label, condition):
    lines.append(('PASS ' if condition else 'FAIL ') + label)

density = int(adb('shell', 'wm', 'density').strip().split()[-1])
# One meta line is 13 * 1.45 dp. A wrapped "Retr" / "y" is about twice that.
one_line_px = 13 * 1.45 * density / 160

for theme in ['Bone', 'Obsidian']:
    tap(labeled(theme)[0])
    time.sleep(0.8)
    retry = labeled('Retry')
    check(theme + ': Retry label is present', len(retry) == 1)
    if retry:
        height = bounds(retry[0])[3] - bounds(retry[0])[1]
        check(
            theme + f': Retry stays on one line ({height}px, one line {one_line_px:.0f}px)',
            height <= one_line_px * 1.6,
        )
    (out / f'android-{theme.lower()}.png').write_bytes(adb('exec-out', 'screencap', '-p', text=False))

fail = any(line.startswith('FAIL') for line in lines)
(out / 'android-result.txt').write_text('\n'.join(lines + [f"RESULT {'FAIL' if fail else 'PASS'}"]) + '\n')
print('\n'.join(lines + [f"RESULT {'FAIL' if fail else 'PASS'}"]))
