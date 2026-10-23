"""Capture real native card/session/storage consumption, including a process restart."""
import json
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

serial, target = sys.argv[1:]
out = Path(target)
out.mkdir(parents=True, exist_ok=True)

def adb(*args):
    return subprocess.check_output(['adb', '-s', serial, *args])

def hierarchy():
    adb('shell', 'uiautomator dump /sdcard/installation-resume.xml >/dev/null')
    return adb('shell', 'cat /sdcard/installation-resume.xml').decode()

def labels(xml):
    return '\n'.join(node.get('text', '') + ' ' + node.get('content-desc', '') for node in ET.fromstring(xml).iter('node'))

def tap(label):
    xml = hierarchy()
    matches = [node for node in ET.fromstring(xml).iter('node') if label in (node.get('text', ''), node.get('content-desc', ''))]
    if not matches:
        raise AssertionError(f'No control {label}: {labels(xml)}')
    x1,y1,x2,y2=map(int,re.findall(r'\d+',matches[-1].get('bounds')))
    adb('shell', f'input tap {(x1+x2)//2} {(y1+y2)//2}')

def capture(name, expected):
    xml = hierarchy()
    assert expected in labels(xml), labels(xml)
    (out/f'{name}.xml').write_text(xml)
    (out/f'{name}.png').write_bytes(adb('exec-out','screencap','-p'))

def launch(theme, mode):
    adb('shell','am force-stop app.usebeeline')
    adb('shell',f'am start -a android.intent.action.VIEW -d "beeline://installation-proof?theme={theme}&mode={mode}" -p app.usebeeline')
    time.sleep(3)

results=[]
for theme in ['bone','obsidian']:
    for mode in ['success','cancel']:
        launch(theme,mode)
        tap('Connect GitHub')
        time.sleep(3)
        capture(f'{theme}-{mode}-returned','proof/connected')
        # Kill the Android process. Persisted AsyncStorage remains intact.
        launch(theme,mode)
        tap('Simulate cold start')
        time.sleep(1)
        capture(f'{theme}-{mode}-cold-start','PASS: no stale return, no cold-start picker, unrelated callback refused.')
        assert 'proof/connected' not in labels(hierarchy()), 'Picker reopened after cold start'
        results.append({'theme':theme,'return':mode,'coldStart':'no picker','lateCallback':'refused'})
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
