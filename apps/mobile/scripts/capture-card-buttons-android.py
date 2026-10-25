"""Capture R1/R2 through the production card components in a native debug build."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
def adb(*parts):
    return subprocess.check_output(['adb', '-s', args.device, *parts])
def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/card-buttons.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/card-buttons.xml')).iter('node'))
def tap(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((left+right)//2), str((top+bottom)//2))
    time.sleep(.3)
def screenshot(name):
    (out / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
def scroll(up=False):
    adb('shell', 'input', 'swipe', '540', '800' if up else '1850', '540', '1850' if up else '800', '350')
    time.sleep(.3)
results = []
for width, density in [(360, 480), (411, 420)]:
    adb('shell', 'wm', 'density', str(density))
    time.sleep(1)
    for theme in ['bone', 'obsidian']:
        adb('shell', 'am', 'force-stop', 'app.usebeeline')
        adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'beeline://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8086')
        time.sleep(3)
        for _ in range(6): scroll(up=True)
        for attempt in range(8):
            controls = nodes()
            control = next((n for n in controls if n.get('content-desc') == theme), None)
            if control is not None: break
            time.sleep(2)
        assert control is not None, 'Native fixture theme controls must finish loading'
        tap(control)
        current = nodes()
        deny = next(n for n in current if n.get('resource-id') == 'grant-grant-deny')
        once = next(n for n in current if n.get('resource-id') == 'grant-grant-once')
        always = next(n for n in current if n.get('resource-id') == 'grant-grant-always')
        source = next(n for n in current if n.get('resource-id') == 'grant-grant-source')
        screenshot(f'android-{theme}-{width}-pending')
        found = None
        for _ in range(5):
            scroll()
            current = nodes()
            found = next((n for n in current if n.get('resource-id') == 'needs-you-script-tray-grant-toggle'), None)
            if found is not None and int(re.findall(r'\d+', found.get('bounds'))[3]) < 1800: break
        assert found is not None, 'Tray script disclosure must be reachable'
        assert not any(n.get('resource-id') == 'needs-you-script-tray-grant' for n in current)
        screenshot(f'android-{theme}-{width}-tray-closed')
        tap(found)
        current = nodes()
        assert any(n.get('resource-id') == 'needs-you-script-tray-grant' for n in current), 'The native disclosure must open the script'
        screenshot(f'android-{theme}-{width}-tray-open')
        (out / f'android-{theme}-{width}.xml').write_bytes(adb('shell', 'cat', '/sdcard/card-buttons.xml'))
        # Fold it again before changing width or theme.
        toggle = next(n for n in current if n.get('resource-id') == 'needs-you-script-tray-grant-toggle')
        tap(toggle)
        results.append({'width':width,'density':density,'theme':theme,'scriptFoldedInitially':True,'scriptOpened':True,
            'buttons':{name:node.get('bounds') for name,node in [('No',deny),('Once',once),('Always',always),('View request',source)]}})
(out / 'android-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
