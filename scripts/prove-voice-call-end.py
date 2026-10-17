"""Android call-wide end proof; start the isolated service with SILENCE_PROOF_HOLD=1."""
import argparse,json,time,urllib.request,subprocess,statistics
from pathlib import Path
import uiautomator2 as u
parser=argparse.ArgumentParser()
parser.add_argument('--scenario',choices=['pending','outside'],default='pending')
parser.add_argument('--device',default='emulator-5554')
args=parser.parse_args()
out=Path('docs/voice-mode-proof/no-silent-removal');origin='http://127.0.0.1:18097'
def get():return json.load(urllib.request.urlopen(origin+'/result'))
def post(path):return json.load(urllib.request.urlopen(urllib.request.Request(origin+path,data=b'{}',headers={'Content-Type':'application/json'})))
x=u.connect(args.device)
limit=time.monotonic()+90
while time.monotonic()<limit:
 if x(resourceId='voice-call-join').exists:x(resourceId='voice-call-join').click()
 if x(text='While using the app').exists:x(text='While using the app').click()
 start=get()
 if start['humans']==2 and start['observations'][-1]['joined']:break
 time.sleep(.25)
assert start['humans']==2 and start['observations'][-1]['joined'],start
pending=[]
if args.scenario=='pending':
 began=time.monotonic()
 while time.monotonic()-began<65:
  r=get();assert r['humans']==2 and not r['call']['ended_at'] and r['observations'][-1]['joined'] and r['activeCallWork'],r
  pending.append({'seconds':round(time.monotonic()-began,2),'humans':r['humans'],'microphoneFrames':r['microphoneFrames']});time.sleep(5)
audio=[]
if args.scenario=='outside':
 for _ in range(6):
  previous=get()['observations'][-1]['firstAudioMs']
  req=urllib.request.Request(origin+'/say',data=json.dumps({'text':'Ruby, ready?'}).encode(),headers={'Content-Type':'application/json'})
  json.load(urllib.request.urlopen(req));limit=time.monotonic()+5
  while time.monotonic()<limit:
   r=get();sample=r['observations'][-1]['firstAudioMs']
   if sample is not None and sample!=previous:break
   time.sleep(.05)
  assert sample is not None and sample!=previous
  audio.append(sample)
post('/work-finish')
if args.scenario=='outside':post('/outside-start')
finished=time.monotonic();quiet=[]
while time.monotonic()-finished<67:
 r=get();quiet.append({'seconds':round(time.monotonic()-finished,2),'humans':r['humans'],'ended':r['call']['ended_at'],'joined':r['observations'][-1]['joined']})
 if r['call']['ended_at'] and not r['observations'][-1]['joined']:break
 time.sleep(.25)
assert r['call']['ended_at'] and r['humans']==0 and not r['observations'][-1]['joined'],r
elapsed=time.monotonic()-finished;assert 55<=elapsed<=65,elapsed
assert r['card']['voiceCall']['endedAt'];assert x(resourceId='voice-call-join').wait_gone(timeout=5)
if args.scenario=='outside':assert r['pendingCommands']>0 and not r['activeCallWork'],r
(out/('call-wide-'+args.scenario+'.png')).write_bytes(subprocess.check_output(['adb','-s',args.device,'exec-out','screencap','-p']))
(out/('call-wide-'+args.scenario+'.json')).write_text(json.dumps({'reproduction':'call-wide-end-3','scenario':args.scenario,'standIn':'Android A plus actual Node RTC B; real service/database/native mic and VoiceCallCard; injected STT/brain/tone TTS','pendingQuietCheckpoints':pending,'afterFinishCheckpoints':quiet,'endElapsedSeconds':elapsed,'final':r,'endedCardJoinVisible':False,'firstAudioMs':audio[1:],'firstAudioMedianMs':statistics.median(audio[1:]) if audio else None},indent=2)+'\n')
print('PASS call-wide-end-3',args.scenario,elapsed)
