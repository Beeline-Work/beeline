import subprocess,xml.etree.ElementTree as ET,re,sys,time
from pathlib import Path
base=Path(__file__).resolve().parents[3]/'.beeline-proof/search-return'
base.mkdir(parents=True,exist_ok=True)
def adb(*args):return subprocess.check_output(['adb','-s','emulator-5554',*args])
def nodes():
 adb('shell','uiautomator','dump','/sdcard/search-return.xml')
 raw=adb('shell','cat','/sdcard/search-return.xml');return raw,ET.fromstring(raw).iter('node')
if sys.argv[1]=='show':
 raw,ns=nodes()
 for n in ns:
  a=n.attrib
  if a.get('text') or a.get('content-desc') or a.get('resource-id'):
   print(a.get('text'),a.get('content-desc'),a.get('resource-id'),a.get('bounds'))
elif sys.argv[1]=='tap':
 target=sys.argv[2]
 for attempt in range(12):
  raw,ns=nodes();ns=list(ns)
  if any(target in [n.attrib.get('text'),n.attrib.get('content-desc'),n.attrib.get('resource-id')] for n in ns):break
  time.sleep(1)
 for n in ns:
  a=n.attrib
  if target in [a.get('text'),a.get('content-desc'),a.get('resource-id')]:
   x,y,r,b=map(int,re.findall(r'\d+',a['bounds']));adb('shell','input','tap',str((x+r)//2),str((y+b)//2));break
 else:raise Exception('Missing control '+target)
elif sys.argv[1]=='snap':
 raw,ns=nodes();name=sys.argv[2];(base/(name+'.xml')).write_bytes(raw);(base/(name+'.png')).write_bytes(adb('exec-out','screencap','-p'))

elif sys.argv[1]=='verify':
 before=ET.parse(base/'baseline-back.xml')
 after=ET.parse(base/'fixed-back.xml')
 reopened=ET.parse(base/'fixed-reopened.xml')
 assert any(n.get('resource-id')=='room-search' and n.get('text')=='release' for n in before.iter('node'))
 assert not any(n.get('resource-id') in ('room-search','message-search-results') for n in after.iter('node'))
 assert any(n.get('text')=='Design notes' for n in after.iter('node'))
 assert any(n.get('resource-id')=='room-search' and n.get('text')==n.get('hint') and n.get('hint')=='Search Rooms and direct messages' for n in reopened.iter('node'))
 result='SEARCH-RETURN-1 PASS: baseline retains release/results; fixed Back retracts search and restores full list; reopened field shows its empty placeholder.'
 print(result)
 (base/'android-assertions.txt').write_text(result+'\n')
