import json, re, subprocess, sys, time
from pathlib import Path
from xml.etree import ElementTree as ET
out=Path('apps/mobile/evidence/title-alignment')
phase=sys.argv[1]
def adb(*args): return subprocess.check_output(['adb','-s','emulator-5554',*args])
def nodes():
 adb('shell','uiautomator','dump','/sdcard/title-alignment.xml')
 raw=adb('shell','cat','/sdcard/title-alignment.xml')
 return raw,list(ET.fromstring(raw).iter('node'))
def press(node):
 l,t,r,b=map(int,re.findall(r'\d+',node.get('bounds')))
 adb('shell','input','tap',str((l+r)//2),str((t+b)//2)); time.sleep(.3)
receipts=[]
adb('shell','am','force-stop','app.usebeeline')
adb('shell','am','start','-n','app.usebeeline/.MainActivity')
time.sleep(4)
for theme in ['bone','obsidian']:
 _,ns=nodes();press(next(n for n in ns if n.get('content-desc')==theme))
 raw,ns=nodes()
 (out/f'android-{phase}-{theme}.xml').write_bytes(raw)
 (out/f'android-{phase}-{theme}.png').write_bytes(adb('exec-out','screencap','-p'))
 for name in ['corner-glyph-alignment','mock-embedded-fonts']:
  _,ns=nodes();press(next(n for n in ns if n.get('content-desc')=='Open corner '+name))
  _,ns=nodes();assert any(n.get('text')==name for n in ns),name
 receipts.append({'theme':theme,'destinations':['corner-glyph-alignment','mock-embedded-fonts'],'rows':[{'text':n.get('text'),'bounds':n.get('bounds')} for n in ns if n.get('text','').startswith('Opened')]})
(out/f'android-{phase}.json').write_text(json.dumps(receipts,indent=2)+'\n')
print(json.dumps(receipts))
