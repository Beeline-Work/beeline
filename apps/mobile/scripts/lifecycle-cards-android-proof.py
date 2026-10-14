"""Capture every approved production card variant on a leased Android emulator."""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--device', required=True)
p.add_argument('--phase', choices=['before','after'], required=True)
p.add_argument('--out', required=True)
p.add_argument('--only-index', type=int, help='Refresh one fixture after a narrow presentation change')
a = p.parse_args()
out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
def adb(*args):
    return subprocess.check_output(['adb', '-s', a.device, *args])
def nodes():
    adb('shell','uiautomator','dump','/sdcard/lifecycle.xml')
    return list(ET.fromstring(adb('shell','cat','/sdcard/lifecycle.xml')).iter('node'))
def tap_node(node):
    x,y,r,b = map(int,re.findall(r'\d+',node.get('bounds')))
    adb('shell','input','tap',str((x+r)//2),str((y+b)//2))
    time.sleep(.3)
results = []
for theme in ['bone','obsidian']:
    adb('shell','am','force-stop','app.usebeeline')
    adb('shell','am','start','-n','app.usebeeline/.MainActivity')
    time.sleep(2)
    ns = nodes(); tap_node(next(n for n in ns if n.get('content-desc') == theme))
    next_control = next(n for n in nodes() if n.get('content-desc') == 'Next variant')
    for index in range(22):
        if a.only_index is not None and index != a.only_index:
            tap_node(next_control)
            continue
        ns = nodes()
        name = next(n.get('content-desc')[8:] for n in ns if n.get('content-desc','').startswith('Variant '))
        if name == 'grouped-expanded':
            tap_node(next(n for n in ns if n.get('resource-id') == 'notification-run-expand-opened-corner'))
            ns = nodes()
        filename = f'android-{a.phase}-{theme}-{name}.png'
        (out/filename).write_bytes(adb('exec-out','screencap','-p'))
        texts = [n.get('text') for n in ns if n.get('text')]
        actions = [n.get('content-desc') for n in ns if n.get('content-desc') in ['Corner →','View ↗']]
        if a.phase == 'after':
            assert any(re.match(r'^(PR|Corner|Issue|Check|Activity) · ', t) for t in texts), (name, texts)
            assert actions, (name, 'missing actions')
            if name == 'grouped-expanded': assert len(actions) == 3, (name, actions)
        results.append({'variant':name,'theme':theme,'source':f'Android native {a.phase} fixture','screenshot':filename,'texts':texts,'actions':actions})
        tap_node(next(n for n in ns if n.get('content-desc') == 'Next variant'))
if a.only_index is not None:
    previous = json.loads((out/f'android-{a.phase}-results.json').read_text())
    replacement = {(r['variant'], r['theme']): r for r in results}
    results = [replacement.get((r['variant'], r['theme']), r) for r in previous]
(out/f'android-{a.phase}-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'phase':a.phase,'screenshots':len(results),'variants':len(results)//2}))
