"""Walk the real native sign-in and Workspace screens against the isolated service."""
import json,re,subprocess,time,os,xml.etree.ElementTree as ET
from pathlib import Path
serial='emulator-5566'
out=Path(__file__).resolve().parent/'android';out.mkdir(exist_ok=True)
def adb(*args):return subprocess.check_output(['adb','-s',serial,*args])
def nodes():
 for attempt in range(3):
  try:
   adb('shell','uiautomator dump /sdcard/short-flow.xml >/dev/null');break
  except subprocess.CalledProcessError:
   if attempt==2:raise
   time.sleep(1)
 return list(ET.fromstring(adb('shell','cat /sdcard/short-flow.xml')).iter('node'))
def tap(label):
 for _ in range(12):
  matches=[n for n in nodes() if n.get('text')==label or n.get('content-desc')==label]
  match=next((n for n in matches if n.get('class')=='android.widget.EditText'),matches[0] if matches else None)
  if match is not None:
   a,b,c,d=map(int,re.findall(r'\d+',match.get('bounds')));adb('shell',f'input tap {(a+c)//2} {(b+d)//2}');return
  time.sleep(.3)
 raise RuntimeError('Missing '+label)
records=json.loads((out/'results.json').read_text()) if (out/'results.json').exists() else []
themes=os.environ.get('ONBOARDING_THEMES','obsidian,bone').split(',')
records=[r for r in records if r['theme'] not in themes]
for theme in themes:
 for provider in ['Google','GitHub']:
  adb('shell',f'am start -a android.intent.action.VIEW -d "beeline://onboarding-proof?screen=sign-in&theme={theme}&run={time.time_ns()}" -p app.usebeeline')
  time.sleep(.6)
  def shot(stage):
   if stage=='general':
    for _ in range(20):
     if any('Three things to know' in (n.get('text') or '') for n in nodes()):break
     time.sleep(.3)
   text=[n.get('text') or n.get('content-desc') for n in nodes() if n.get('text') or n.get('content-desc')]
   time.sleep(.4)
   file=f'{provider.lower()}-{stage}-{theme}.png';(out/file).write_bytes(adb('exec-out','screencap','-p'))
   records.append(dict(theme=theme,provider=provider,stage=stage,file=file,text=text))
  shot('sign-in')
  tap('Continue with '+provider)
  time.sleep(.6);shot('workspace')
  tap('Workspace name');adb('shell','input text First%sworkspace');adb('shell','input keyevent 4')
  tap('Create Workspace');time.sleep(.7)
  shot('general')
  if not any('Three things to know' in t for t in records[-1]['text']):raise RuntimeError(str(records[-1]['text']))
  adb('shell','input swipe 540 2000 540 450 450');time.sleep(.3);shot('general-card')
  (out/'results.json').write_text(json.dumps(records,indent=2))
  print(json.dumps(dict(theme=theme,provider=provider,passed=True)),flush=True)
(out/'results.json').write_text(json.dumps(records,indent=2))
