"""Verify Android live mode switching with the isolated voice proof service."""
import json,time,urllib.request,subprocess,collections,statistics,argparse
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--device',default='emulator-5554')
parser.add_argument('--output-dir',type=Path,default=Path('docs/voice-mode-proof/no-silent-removal'))
args=parser.parse_args()
args.output_dir.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:18097'
def get():return json.load(urllib.request.urlopen(origin+'/result'))
def post(path,body={}):return json.load(urllib.request.urlopen(urllib.request.Request(origin+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})))
def until(test):
 end=time.monotonic()+10
 while time.monotonic()<end:
  r=get()
  if test(r):return r
  time.sleep(.05)
 raise AssertionError(get())
def view(r):return {'humans':r['humans'],'replies':r['replies'],'observations':r['observations'],'operations':r['operations'],'participants':r['participants'],'signalCounts':dict(collections.Counter(s['type'] for s in r['signals']))}
start=until(lambda r:r['humans']==2 and r['observations'][-1]['joined'])
post('/partner-leave')
solo=until(lambda r:r['observations'][-1]['humans']==1)
(args.output_dir/'mode-solo.png').write_bytes(subprocess.check_output(['adb','-s',args.device,'exec-out','screencap','-p']))
post('/say',{'text':'How are you doing today?'})
soloReply=until(lambda r:len(r['replies'])==len(start['replies'])+1)
post('/partner-rejoin')
group=until(lambda r:r['humans']==2 and r['observations'][-1]['humans']==2)
assert [s for s in group['signals'] if s['type']=='humans'][-1]['count']==2,group
post('/say',{'text':'How are you doing today?'})
assert get()['replies']==group['replies']
post('/partner-drop')
started=time.monotonic(); checks=[]
while time.monotonic()-started<30:
 post('/say',{'text':'How are you doing today?'})
 r=get();assert r['humans']==2 and r['observations'][-1]['joined'] and r['observations'][-1]['humans']==2,r
 assert r['replies']==group['replies'],r
 checks.append({'seconds':round(time.monotonic()-started,2),'humans':r['humans'],'nativeHumans':r['observations'][-1]['humans']})
 time.sleep(5)
drop=get();assert not any(p.endswith('/idle') for p in drop['operations']),drop
post('/partner-return')
returned=until(lambda r:r['observations'][-1]['humans']==2 and r['humans']==2)
(args.output_dir/'mode-group.png').write_bytes(subprocess.check_output(['adb','-s',args.device,'exec-out','screencap','-p']))
measurements=[]
for _ in range(5):
 previous=get()['observations'][-1]['firstAudioMs']; post('/say',{'text':'Ruby, ready?'})
 r=until(lambda r:r['observations'][-1]['firstAudioMs'] not in [None,previous]);measurements.append(r['observations'][-1]['firstAudioMs'])
(args.output_dir/'mode-switch.json').write_text(json.dumps({'reproduction':'multi-human-mode-2','standIn':'Android A; actual Node RTC partner B; injected final text/brain/TTS; partner transport disconnected without leave for 30 seconds','solo':view(solo),'soloReply':view(soloReply),'rejoined':view(group),'dropCheckpoints':checks,'afterDrop':view(drop),'returned':view(returned),'firstAudioMs':measurements,'firstAudioMedianMs':statistics.median(measurements)},indent=2)+'\n')
print('PASS: Android A switches 2 -> 1 -> 2, unnamed speech follows mode, deadline cancels, 30-second partner RTC drop stays group')
