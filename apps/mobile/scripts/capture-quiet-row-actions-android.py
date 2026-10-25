"""Capture and exercise production controls on this corner's emulator."""
import json
import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

serial = sys.argv[1]
out = pathlib.Path(__file__).resolve().parents[1] / 'evidence/quiet-row-actions'
out.mkdir(parents=True, exist_ok=True)

def adb(*args):
    return subprocess.check_output(['adb', '-s', serial, *args])

def tree():
    adb('shell', 'uiautomator', 'dump', '/sdcard/quiet-actions.xml')
    return ET.fromstring(adb('shell', 'cat', '/sdcard/quiet-actions.xml'))

def tap(label, contains=False):
    nodes = list(tree().iter('node'))
    nodes.sort(key=lambda node: node.get('clickable') != 'true')
    for node in nodes:
        text = node.get('content-desc') or node.get('text') or ''
        if (label in text if contains else text == label):
            x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
            adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
            time.sleep(.4)
            return
    raise AssertionError('Missing control: ' + label)

def verify(text):
    assert any(text in (n.get('text','') + n.get('content-desc','')) for n in tree().iter('node')), text

results=[]
for theme in ['bone', 'obsidian']:
    for scene in range(4):
        if scene == 0:
            tap('Retry uploading IMG_20261024.png')
            verify('Upload retried')
            tap('Retry')
            verify('Delivery retried')
            tap('Dismiss')
            verify('Delivery dismissed')
        elif scene == 1:
            tap('Link it instead')
            verify('Repository linked')
        elif scene == 2:
            tap('package-cache', contains=True)
            tap('Revoke')
            verify('Grant revoked')
        elif scene == 3:
            tap('Copy code')
            time.sleep(2)
        name = f'android-{theme}-{["a1-a2", "b3", "b4", "b5"][scene]}'
        (out / (name+'.png')).write_bytes(adb('exec-out', 'screencap', '-p'))
        (out / (name+'.xml')).write_bytes(ET.tostring(tree()))
        results.append({'theme':theme,'scene':scene,'actions':'passed'})
        tap('Next scene')
    if theme == 'bone':
        tap('Switch theme')
(out/'android-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
