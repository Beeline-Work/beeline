from pathlib import Path
import subprocess,shlex,json,hashlib,base64,time,sys
p=Path('.beeline-proof/send-latency');serial='emulator-5626';uid='01A1A402A77A7A069F2EEF6C50260DDB';db='/data/user/0/app.usebeeline/databases/updates.db';room=json.loads((p/'room.json').read_text());out=p/'head3a-paired';out.mkdir(exist_ok=True)
def adb(*args,text=True):return subprocess.check_output(['adb','-s',serial,*args],text=text)
def sql(q):return json.loads(adb('shell','sqlite3 -json '+db+' '+shlex.quote(q))or'[]')
def prepare(label):
 # Fixed coordinates inspected in original native44 screenshots. No UI dump.
 route=f'beeline://beeline/chat/{room["roomId"]}?communityId={room["workspaceId"]}'
 adb('shell','am start -a android.intent.action.VIEW -d '+shlex.quote(route)+' -p app.usebeeline')
 # Wait for the actual Room header in a screenshot, then use the fixed target.
 import io
 from PIL import Image
 for attempt in range(20):
  raw=adb('exec-out','screencap','-p',text=False)
  image=Image.open(io.BytesIO(raw));buf=io.BytesIO();image.crop((0,75,1000,230)).save(buf,format='PNG')
  title=subprocess.run(['tesseract','stdin','stdout','--psm','6'],input=buf.getvalue(),capture_output=True,check=True).stdout.decode()
  buf=io.BytesIO();image.crop((90,2180,900,2340)).save(buf,format='PNG')
  composer=subprocess.run(['tesseract','stdin','stdout','--psm','6'],input=buf.getvalue(),capture_output=True,check=True).stdout.decode()
  if 'latency'in title.lower()and composer.strip():break
  time.sleep(.5)
 else:raise Exception('proof Room header not ready in screenshot')
 adb('shell','input tap 250 2258');time.sleep(.5)
 if 'mInputShown=true'not in adb('shell','dumpsys input_method'):
  raise Exception('fixed composer coordinate did not focus keyboard')
 adb('shell','input keycombination 113 29; input keyevent 67')
 editor_ready()
 adb('shell',f'input text sendproof{label}A');time.sleep(.3)
 return 981,1438
row=sql("SELECT manifest,assets.id asset_id,hex(assets.hash) asset_hash,expected_hash,relative_path FROM updates JOIN assets ON launch_asset_id=assets.id WHERE hex(updates.id)='"+uid+"'")[0]
assert json.loads(row['manifest'])['extra']['expoClient']['extra']['app']['releaseSha']=='98c2a49a4f3df909e8fd3fc32ae39129f6f8367b'
assert all(c.isalnum()or c in '._-'for c in row['relative_path'])
dest='/data/user/0/app.usebeeline/files/.expo-internal/'+row['relative_path'];original=adb('exec-out','cat',dest,text=False);assert hashlib.sha256(original).hexdigest()=='0814b713dcfa6ed20048aae18d4ce2a3b22af36d1a888b564c5b1af0cc0d6f0c'
(out/'original.hbc').write_bytes(original);(out/'original.json').write_text(json.dumps(row,indent=2))
old=next((p/'current-baseline-export/_expo/static/js/android').glob('*.hbc'));new=next((p/'head3a-export/_expo/static/js/android').glob('*.hbc'))
manifest={'runs':[],'definition':'Current pipeline head3a77888f6b99465e9156efc237cfab7d5a5167e4 versus pre-preview rebased baseline283dd1cfd91e2a74b7f46f909e2684c77cfa649f, same-session alternating local Hermes fixtures on unchanged native44 and production142, same private proof Room. Critical app modules verified by source-map content; isolated Metro caches. Old local bundle includes initial sender-fade fix; new paints an independently subscribed newest-slot child with unchanged FlatList data and first-frame anchor suppression. Fixed composer/send coordinates from screenshots; full draft OCR and enabled gold arrow required before each tap. Empty draft required before typing next message. No UI dumps. Monotonic uptime bracket supplements wall-clock date.'}
def install(bundle,label):
 adb('shell','am force-stop app.usebeeline');raw=bundle.read_bytes();digest=hashlib.sha256(raw).digest();b64=base64.urlsafe_b64encode(digest).decode().rstrip('=');m=json.loads(row['manifest']);m['launchAsset']['hash']=b64;m['extra']['expoClient']['extra']['app']['releaseVersion']='send-alternate-'+label;m['extra']['expoClient']['extra']['app']['releaseSha']='283dd1cfd91e2a74b7f46f909e2684c77cfa649f' if label.startswith('S') else '3a77888f6b99465e9156efc237cfab7d5a5167e4'
 adb('push',str(bundle),'/data/local/tmp/send-alternate.hbc');adb('shell','cat /data/local/tmp/send-alternate.hbc > '+dest)
 sql("UPDATE updates SET manifest='"+json.dumps(m).replace("'","''")+"' WHERE hex(id)='"+uid+"'; UPDATE assets SET hash=X'"+digest.hex()+"',expected_hash='"+b64+"' WHERE id="+str(row['asset_id'])+';')
 return digest.hex()
def editor_ready(token=None):
 import io,re,numpy as np
 from PIL import Image
 normalize=lambda text:re.sub(r'(.)\1+',r'\1',re.sub('[^a-z0-9]','',text.lower()).replace('o','0').replace('l','1').replace('i','1'))
 for attempt in range(40):
  raw=adb('exec-out','screencap','-p',text=False);image=Image.open(io.BytesIO(raw));buf=io.BytesIO();image.crop((145,1395,880,1475)).save(buf,format='PNG')
  text=subprocess.run(['tesseract','stdin','stdout','--psm','7'],input=buf.getvalue(),capture_output=True,check=True).stdout.decode()
  arrow=np.array(image.crop((955,1408,1007,1470))).astype(int);gold=int(((arrow[:,:,0]>arrow[:,:,1]+20)&(arrow[:,:,1]>arrow[:,:,2]+25)&(arrow[:,:,0]<190)).sum())
  if token is None and 'message'in text.lower():return
  if token is not None and normalize(token)in normalize(text)and gold>10:return
  time.sleep(.3)
 raise Exception(f'Composer not ready: expected={token}, observed={text!r}, gold={gold}')
def capture(label,x,y,count=6):
 rec=subprocess.Popen(['adb','-s',serial,'shell',f'screenrecord --size 540x1200 --bit-rate 4000000 --time-limit 180 /sdcard/send-alternate-{label}.mp4'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 time.sleep(.7);recpid=adb('shell','pidof screenrecord').strip();assert recpid.isdigit();samples=[]
 try:
  for i in range(1,count+1):
   token=f'sendproof{label}{chr(64+i)}'
   if i>1:
    editor_ready();adb('shell',f'input text {token}')
   editor_ready(token)
   time.sleep(.2)
   t=adb('shell',f'date +%s%N; cat /proc/uptime; input tap {x} {y}; cat /proc/uptime; date +%s%N').splitlines();samples.append({'sample':i,'token':token,'tapBeforeNs':int(t[0]),'tapAfterNs':int(t[3]),'tapBeforeElapsedNs':round(float(t[1].split()[0])*1e9),'tapAfterElapsedNs':round(float(t[2].split()[0])*1e9)});(p/f'{label}-taps.json').write_text(json.dumps({'samples':samples},indent=2));time.sleep(1.5)
 finally:
  adb('shell',f'kill -2 {recpid}');rec.wait(timeout=15)
 adb('pull',f'/sdcard/send-alternate-{label}.mp4',str(p/f'{label}.mp4'))
 return len(samples)
try:
 for block in range(4):
  for kind,bundle in [('old',old),('new',new)]:
   label=('S'if kind=='old'else'T')+chr(65+block);digest=install(bundle,label);x,y=prepare(label);n=capture(label,x,y)
   manifest['runs'].append({'kind':kind,'label':label,'n':n,'bundleSha256':digest,'at':time.time(),'hostLoad':Path('/proc/loadavg').read_text().strip()});(out/'manifest.json').write_text(json.dumps(manifest,indent=2));print('completed',kind,label,n,flush=True)
finally:
 adb('shell','am force-stop app.usebeeline');adb('push',str(out/'original.hbc'),'/data/local/tmp/send-alternate-original.hbc');adb('shell','cat /data/local/tmp/send-alternate-original.hbc > '+dest)
 sql("UPDATE updates SET manifest='"+row['manifest'].replace("'","''")+"' WHERE hex(id)='"+uid+"'; UPDATE assets SET hash=X'"+row['asset_hash']+"',expected_hash='"+row['expected_hash']+"' WHERE id="+str(row['asset_id'])+';')
 assert adb('shell','sha256sum '+dest).split()[0]==hashlib.sha256(original).hexdigest()
 adb('shell','rm -f /data/local/tmp/send-alternate.hbc /data/local/tmp/send-alternate-original.hbc /sdcard/send-alternate.xml');manifest['originalRestored']=True;(out/'manifest.json').write_text(json.dumps(manifest,indent=2));adb('shell','am start -a android.intent.action.VIEW -d '+shlex.quote(f'beeline://beeline/chat/{room["roomId"]}?communityId={room["workspaceId"]}')+' -p app.usebeeline')
 print('original production142 restored',flush=True)
