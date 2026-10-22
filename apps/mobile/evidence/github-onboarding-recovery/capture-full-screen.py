"""Capture the real onboarding screen with isolated account/session boundaries."""
import subprocess,time,json,re,sys
from pathlib import Path
import xml.etree.ElementTree as ET
serial = sys.argv[1]
out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
def adb(*args):return subprocess.check_output(['adb','-s',serial,*args])
records=[]
for theme in ['bone','obsidian']:
 for state in ['initial','offline','cancel','expired']:
  start_state='initial' if state=='offline' else state
  adb('shell',f'am start -a android.intent.action.VIEW -d "beeline://onboarding-proof?state={start_state}&theme={theme}" -p app.usebeeline')
  time.sleep(2)
  if state=='offline':
   adb('shell','uiautomator dump /sdcard/onboarding.xml')
   before=ET.fromstring(adb('shell','cat /sdcard/onboarding.xml'))
   button=next(n for n in before.iter('node') if n.get('text')=='Continue with GitHub')
   x1,y1,x2,y2=map(int,re.findall(r'\d+',button.get('bounds')))
   adb('shell',f'input tap {(x1+x2)//2} {(y1+y2)//2}')
   time.sleep(1)
  adb('shell','uiautomator dump /sdcard/onboarding.xml')
  xml=adb('shell','cat /sdcard/onboarding.xml')
  nodes=list(ET.fromstring(xml).iter('node'))
  labels=[n.get('text') for n in nodes if n.get('text') in ['Continue with GitHub','Continue with Google','Try again']]
  expected=['Continue with GitHub','Continue with Google'] if state=='initial' else ['Try again'] if state=='offline' else ['Continue with GitHub']
  if labels!=expected:raise RuntimeError(f'{state}-{theme}: expected {expected}, got {labels}')
  title={'offline':'No connection','cancel':'Sign-in did not finish','expired':'Sign-in expired'}.get(state)
  if title and title not in [n.get('text') for n in nodes]:raise RuntimeError(f'{state}-{theme}: missing notice {title}')
  (out/f'{state}-{theme}.xml').write_bytes(xml)
  (out/f'{state}-{theme}.png').write_bytes(adb('exec-out','screencap','-p'))
  records.append({'state':state,'theme':theme,'actions':labels});print(records[-1],flush=True)
(out/'results.json').write_text(json.dumps(records,indent=2))

