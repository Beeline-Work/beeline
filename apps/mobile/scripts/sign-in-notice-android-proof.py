"""Drive the Android sign-in notice fixture; capture collapsed lines in both themes."""
import argparse
import json
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
def adb(*args):
    return subprocess.check_output(['adb', '-s', a.device, *args])
def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/sign-in-notice.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/sign-in-notice.xml')).iter('node'))
def texts():
    return [n.get('text') or n.get('content-desc') or '' for n in nodes()]
def tap(label):
    node = next(n for n in nodes() if label in (n.get('content-desc'), n.get('text')))
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
    time.sleep(.5)
def check(label, condition):
    lines.append(('PASS ' if condition else 'FAIL ') + label)
    if not condition:
        raise AssertionError(label)
for theme in ['obsidian', 'bone']:
    tap(theme.title())
    seen = texts()
    (out / f'android-{theme}-390.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    lines.append(f'{theme}: ' + ' | '.join(t for t in seen if 'ends on line' in t))
    check(f'{theme}: before hides @ruby /login past the two collapsed lines',
          any(re.fullmatch(r'Before: @ruby /login ends on line [3-9]', t) for t in seen))
    check(f'{theme}: after shows @ruby login inside the two collapsed lines',
          any(re.fullmatch(r'After: @ruby login ends on line [12]', t) for t in seen))
    check(f'{theme}: both lines still offer More', seen.count('More') == 2)
(out / 'android-results.json').write_text(json.dumps(lines, indent=2) + '\n')
print('\n'.join(lines))
