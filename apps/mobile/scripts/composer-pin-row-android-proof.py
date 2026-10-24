"""Capture the native release fixture on the leased 1080x2400/420dpi emulator.

The live waveform prevents UIAutomator idle; coordinates refer to this fixture,
not a live account. Inspect the screenshots; Chrome separately asserts geometry.
"""
import argparse
import json
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

def adb(*command):
    return subprocess.check_output(['adb', '-s', args.device, *command], timeout=30)

def tap(x, y):
    adb('shell', 'input', 'tap', str(x), str(y))
    time.sleep(.5)

def shot(name):
    (out / f'android-{name}.png').write_bytes(adb('exec-out', 'screencap', '-p'))

assert '1080x2400' in adb('shell', 'wm', 'size').decode()
assert '420' in adb('shell', 'wm', 'density').decode()
for theme, x in [('obsidian', 110), ('bone', 265)]:
    tap(x, 330)
    for name, x in [('short', 395), ('long', 525)]:
        tap(x, 330)
        shot(f'{theme}-{name}')
tap(957, 2017)
shot('unpin')
tap(395, 330)
try:
    adb('shell', 'settings', 'put', 'system', 'font_scale', '1.3')
    time.sleep(1)
    # The larger labels move Long to the right within the fixture's harness row.
    tap(625, 345)
    shot('large-text-long')
finally:
    adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
(out / 'android-capture.json').write_text(json.dumps({
    'device': args.device, 'size': '1080x2400', 'density': 420,
    'uiAutomator': 'unavailable: live waveform prevents idle',
    'method': 'fixture-coordinate taps; inspect captures; Chrome asserts geometry',
}, indent=2) + '\n')
print('Captured Android themes, short/long names, Unpin and larger text.')
