"""Capture the local production-component fixture on the task-owned emulator."""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

serial = os.environ['BROWSER_CONTROLS_ANDROID_SERIAL']
out = Path(__file__).parent

def adb(*args):
    return subprocess.check_output(['adb', '-s', serial, *args])

def tree():
    adb('shell', 'uiautomator', 'dump', '/sdcard/browser-controls.xml')
    return adb('shell', 'cat', '/sdcard/browser-controls.xml')

def tap(label):
    root = ET.fromstring(tree())
    node = next(n for n in root.iter('node') if n.get('content-desc') == label or n.get('text') == label)
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
    time.sleep(1.5)

def capture(name):
    (out / (name+'.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
    (out / (name+'.xml')).write_bytes(tree())

adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1')
for stage, theme in [('before', 'obsidian'), ('after', 'obsidian'), ('after', 'bone'), ('before', 'bone')]:
    prefix = f'android-{stage}-{theme}'
    capture(prefix+'-card')
    tap('Surface')
    capture(prefix+'-collapsed')
    tap('Talk to agent')
    capture(prefix+'-expanded')
    tap('Collapse conversation')
    tap('Open keyboard')
    capture(prefix+'-keyboard')
    ime = adb('shell', 'dumpsys', 'input_method').decode()
    (out / (prefix+'-keyboard-ime.txt')).write_text('\n'.join(line for line in ime.splitlines() if any(key in line for key in ['mInputShown=', 'mCurFocusedWindow=', 'mCurEditorInfo:', 'packageName=app.usebeeline']))+'\n')
    adb('shell', 'input', 'keyevent', '4')
    time.sleep(1)
    tap('Surface')
    if (stage,theme) in [('before','obsidian'),('after','bone')]: tap('Stage')
    elif (stage,theme)==('after','obsidian'): tap('Theme')
