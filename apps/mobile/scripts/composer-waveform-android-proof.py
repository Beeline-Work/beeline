"""Drive the isolated Android fixture; capture production composer states."""
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
    adb('shell', 'uiautomator', 'dump', '/sdcard/waveform.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/waveform.xml')).iter('node'))
def find(label):
    return next(n for n in nodes() if n.get('content-desc') == label or n.get('text') == label)
def center(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    return (x1 + x2) // 2, (y1 + y2) // 2

def tap(label):
    x, y = center(find(label))
    adb('shell', 'input', 'tap', str(x), str(y))
    time.sleep(.3)
def shot(name):
    (out / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
def check(label, condition):
    lines.append(('PASS ' if condition else 'FAIL ') + label)
    if not condition:
        raise AssertionError(label)
for theme in ['obsidian', 'bone']:
    tap(theme.title())
    tap('Empty')
    mic = find('Start speech input').get('bounds')
    wave = find('Conversation mode').get('bounds')
    shot('android-' + theme + '-empty')
    tap('Typed')
    check(theme + ': typed text replaces waveform with Send and keeps mic',
          find('Send message') is not None and find('Start speech input').get('bounds') == mic)
    shot('android-' + theme + '-typed')
    tap('Empty')
    check(theme + ': same waveform slot after clearing text', find('Conversation mode').get('bounds') == wave)
# Real Android text entry, independent of the fixture's Typed control.
x, y = center(find('Message'))
adb('shell', 'input', 'tap', str(x), str(y))
adb('shell', 'input', 'text', 'Hello')
time.sleep(.5)
check('real native typing exposes Send beside mic', find('Send message') is not None and find('Start speech input') is not None)
adb('shell', 'input', 'keyevent', '4')
tap('Empty')
tap('Conversation mode')
shot('android-conversation-tap')
# The live waveform never idles, so dump the hierarchy after exiting.
# End coordinates are from the captured 1080x2400 fixture screen.
adb('shell', 'input', 'tap', '956', '2108')
time.sleep(.3)
check('waveform tap enters Conversation once; End returns to composer', find('Conversation entry proof · joins 1') is not None and find('Start speech input') is not None)
x, y = center(find('Start speech input'))
adb('shell', 'input', 'swipe', str(x), str(y), str(x), str(y), '1000')
time.sleep(.5)
shot('android-conversation-hold')
adb('shell', 'input', 'tap', '956', '2108')
time.sleep(.3)
check('mic long press enters Conversation once; End returns to composer', find('Conversation entry proof · joins 2') is not None and find('Start speech input') is not None)
check('release and End restore composer', find('Start speech input') is not None and find('Conversation mode') is not None)
(out / 'android-results.json').write_text(json.dumps(lines, indent=2) + '\n')
print('\n'.join(lines))
