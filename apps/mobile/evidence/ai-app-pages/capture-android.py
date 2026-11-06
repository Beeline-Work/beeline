"""Drive the fixture app on emulator-5646 and save screenshots. Usage: capture.py <before|after> <bone|obsidian> <outdir>"""
import re, subprocess, sys, time, xml.etree.ElementTree as ET, pathlib
mode, theme, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
ADB = ['/home/lunchbox/android-sdk/platform-tools/adb', '-H', '127.0.0.1', '-P', '5037', '-s', 'emulator-5646']
def adb(*a): return subprocess.check_output(ADB + list(a))
def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/proof.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/proof.xml')).iter('node'))
def label(n): return (n.get('text') or '') + '|' + (n.get('content-desc') or '')
def find(text, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        for n in nodes():
            if text in label(n): return n
        time.sleep(1)
    raise SystemExit(f'not found: {text}')
def tap(text):
    n = find(text); x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)); time.sleep(2)
def shot(name):
    time.sleep(1.5); (out / f'phone-{mode}-{theme}-{name}.png').write_bytes(adb('exec-out', 'screencap', '-p')); print('saved', name)
adb('shell', 'am', 'force-stop', 'app.usebeeline')
adb('shell', "am start -a android.intent.action.VIEW -d 'beeline:///?viewerId=fixture-owner\\&workspaceId=fixture-workspace' app.usebeeline")
find('Legacy app', 30)
if mode == 'after': find('Pidoong')
shot('list')
tap('ChatGPT')
if mode == 'before':
    find('Disconnect'); shot('row-tap')
else:
    find('WHAT IT CAN DO')
    if any('Disconnect' in label(n) for n in nodes()): raise SystemExit('row tap showed Disconnect')
    shot('info')
    tap('Connected')
    find('Disconnect'); shot('status')
    # tap the sheet's Disconnect action (last node labelled Disconnect)
    ds = [n for n in nodes() if label(n).startswith('Disconnect')]
    n = ds[-1]; x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)); time.sleep(3)
    find('Legacy app')
    if any(label(n).startswith('ChatGPT') for n in nodes()): raise SystemExit('ChatGPT still listed after Disconnect')
    shot('disconnected')
