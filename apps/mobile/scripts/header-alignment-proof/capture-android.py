import subprocess, json, re, time, sys
from pathlib import Path
import xml.etree.ElementTree as ET
serial, phase = sys.argv[1:3]
out=Path('apps/mobile/evidence/header-alignment')
def adb(*args):
    return subprocess.check_output(['adb','-s',serial,*args])
def nodes():
    adb('shell','uiautomator','dump','/sdcard/header-proof.xml')
    return list(ET.fromstring(adb('exec-out','cat','/sdcard/header-proof.xml')).iter('node'))
def find(name):
    return next(n for n in nodes() if n.attrib.get('resource-id')==name or n.attrib.get('content-desc')==name or n.attrib.get('text')==name)
def box(node):
    x,y,xx,yy=map(int,re.findall(r'\d+',node.attrib['bounds']))
    return dict(x=x,y=y,width=xx-x,height=yy-y,cx=(x+xx)/2,cy=(y+yy)/2)
def tap(name):
    b=box(find(name));adb('shell','input','tap',str(int(b['cx'])),str(int(b['cy'])));time.sleep(.5)
def shot(name):
    (out/f'android-{phase}-{name}.png').write_bytes(adb('exec-out','screencap','-p'))
adb('shell','wm','size','1080x2340');adb('shell','wm','density','420')
adb('shell','am','force-stop','app.usebeeline')
adb('shell','am','start','-n','app.usebeeline/.MainActivity')
for _ in range(30):
    try: find('workspace-tray');break
    except (StopIteration,ET.ParseError):time.sleep(1)
results=[]
for theme in ['bone','obsidian']:
    if theme=='obsidian':tap('Theme')
    ns=nodes()
    (out/f'android-{phase}-{theme}.xml').write_bytes(adb('exec-out','cat','/sdcard/header-proof.xml'))
    boxes={key:box(next(n for n in ns if n.attrib.get('resource-id')==key)) for key in ['workspace-members','workspace-tray','room-search-toggle','rooms-add','corners-add']}
    dp={key:{k:v/2.625 for k,v in b.items()} for key,b in boxes.items()}
    if phase=='after':
        assert abs(dp['workspace-tray']['cx']-dp['workspace-members']['cx']-44)<1,dp
        for key in ['workspace-tray','room-search-toggle','rooms-add','corners-add']:
            assert abs(dp[key]['cx']-(1080/2.625-38))<1,dp
    results.append(dict(theme=theme,density=2.625,boxesDp=dp))
    shot(theme)
    if phase=='after':
        for name,target in [('tray','workspace-tray'),('settings','Settings')]:
            tap(target);shot(name+'-'+theme);tap('Rooms')
(out/f'android-{phase}-measurements.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS Android '+phase+': '+json.dumps(results))
