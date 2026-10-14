"""Drive the v4 composer fixture on Android; capture all three states in both themes."""
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
def adb(*args):
    return subprocess.check_output(['adb', '-s', a.device, *args])
def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/v4.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/v4.xml')).iter('node'))
def bounds(node):
    return tuple(map(int, re.findall(r'\d+', node.get('bounds'))))
def rows(label):
    return sorted((n for n in nodes() if n.get('content-desc') == label), key=lambda n: bounds(n)[1])
def tap(node):
    x1, y1, x2, y2 = bounds(node)
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
def check(label, condition):
    lines.append(('PASS ' if condition else 'FAIL ') + label)
for theme in ['Obsidian', 'Bone']:
    tap(rows(theme)[0])
    time.sleep(1)
    attach = rows('Attach photo or document')
    mics = rows('Start speech input')
    check(theme + ': empty and text rows hold + attach, mic', len(attach) == 3 and len(mics) == 3)
    check(theme + ': empty row ends in Conversation', len(rows('Conversation mode')) == 2)
    sends = rows('Send message')
    check(theme + ': text row ends in Send', len(sends) == 1)
    text_send = bounds(sends[0])
    text_mic = bounds(mics[1])
    tap(mics[2])
    time.sleep(1.2)
    adb('exec-out', 'screencap', '-p')
    (out / f'android-{theme.lower()}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    stop = rows('Stop recording')
    sends = rows('Send message')
    check(theme + ': dictating row holds + attach, Stop, Send',
          len(stop) == 1 and len(sends) == 2 and len(rows('Attach photo or document')) == 3)
    if stop and len(sends) == 2:
        check(theme + ': Stop sits in the mic spot', bounds(stop[0])[0] == text_mic[0] and bounds(stop[0])[2] == text_mic[2])
        check(theme + ': Send sits in the same far-right spot', bounds(sends[1])[0] == text_send[0] and bounds(sends[1])[2] == text_send[2])
        tap(stop[0])
        time.sleep(.5)
    check(theme + ': Stop returns the mic', len(rows('Start speech input')) == 3)
fail = any(line.startswith('FAIL') for line in lines)
(out / 'android-result.txt').write_text('\n'.join(lines + [f"RESULT {'FAIL' if fail else 'PASS'}"]) + '\n')
print('\n'.join(lines + [f"RESULT {'FAIL' if fail else 'PASS'}"]))
