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
    text_mic = bounds(mics[1])
    dictating_mic = mics[2]
    tap(dictating_mic)
    time.sleep(1.2)
    # Without its on-device model Android offers a download first; declining
    # it starts the take on the default recogniser.
    try:
        decline = rows('Not now')
    except subprocess.CalledProcessError:
        decline = []
    if decline:
        tap(decline[0])
    time.sleep(2)
    # A live waveform never idles, so uiautomator cannot dump during the take;
    # the screenshot records the dictating row, and Stop is tapped in the mic's spot.
    (out / f'android-{theme.lower()}.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    x1, y1, x2, y2 = bounds(dictating_mic)
    check(theme + ': mic column matches the text row', (x1, x2) == (text_mic[0], text_mic[2]))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
    time.sleep(1.5)
    check(theme + ': Stop in the mic spot ends the take and returns the mic',
          len(rows('Start speech input')) == 3 and len(rows('Send message')) == 1)
fail = any(line.startswith('FAIL') for line in lines)
(out / 'android-result.txt').write_text('\n'.join(lines + [f"RESULT {'FAIL' if fail else 'PASS'}"]) + '\n')
print('\n'.join(lines + [f"RESULT {'FAIL' if fail else 'PASS'}"]))
