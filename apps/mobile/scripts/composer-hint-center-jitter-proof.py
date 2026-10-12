#!/usr/bin/env python3
"""Check native tag typing at 560dpi / font scale 1.3 on an isolated device."""
import argparse, json, re, subprocess, time
from pathlib import Path
import xml.etree.ElementTree as ET
parser=argparse.ArgumentParser()
parser.add_argument('--device',required=True)
args=parser.parse_args()
if args.device=='emulator-5554': raise SystemExit('Refusing shared emulator-5554')
out=Path(__file__).resolve().parents[1]/'evidence/composer-hint-center'
def adb(*cmd,binary=False): return subprocess.check_output(['adb','-s',args.device,*cmd],text=not binary)
def nodes():
    adb('shell','uiautomator','dump','/sdcard/hint-proof.xml')
    return list(ET.fromstring(adb('exec-out','cat','/sdcard/hint-proof.xml')).iter('node'))
def bbox(n):return list(map(int,re.findall(r'\d+',n.attrib['bounds'])))
def tap(label):
    n=next(n for n in nodes() if n.attrib.get('content-desc')==label)
    a,b,c,d=bbox(n);adb('shell','input','tap',str((a+c)//2),str((b+d)//2));time.sleep(.4)
adb('shell','wm','density','560')
adb('shell','settings','put','system','font_scale','1.3')
adb('shell','am','force-stop','app.usebeeline')
adb('shell','am','start','-n','app.usebeeline/.MainActivity')
time.sleep(2)
results=[]
for surface in ['Room','Viewer']:
    tap(surface);tap('Tags only');tap('Hide keyboard')
    (out/f'tag-only-{surface.lower()}-closed.png').write_bytes(adb('exec-out','screencap','-p',binary=True))
    tap('Message');time.sleep(.5)
    (out/f'tag-only-{surface.lower()}-open.png').write_bytes(adb('exec-out','screencap','-p',binary=True))
    reference=None
    for letter in 'Agjypq':
        adb('shell','input','text',letter);time.sleep(.25)
        snapshot=nodes()
        field=next(n for n in snapshot if n.attrib.get('class')=='android.widget.EditText')
        row=next(n for n in snapshot if n.attrib.get('resource-id')=='chat-composer-input-row')
        entry={'surface':surface,'text':field.attrib.get('text'),'inputBounds':bbox(field),'rowBounds':bbox(row)}
        print(entry,flush=True)
        if reference is None: reference=entry
        else: assert entry['inputBounds']==reference['inputBounds'] and entry['rowBounds']==reference['rowBounds']
        results.append(entry)
    (out/f'tag-typing-{surface.lower()}.png').write_bytes(adb('exec-out','screencap','-p',binary=True))
(out/'tag-typing.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS stable tagged layout across six real native keystrokes on both surfaces')
