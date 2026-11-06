from pathlib import Path
import subprocess,json,shlex,hashlib,base64,time,urllib.request,uuid
ROOT=Path('/home/lunchbox/.treehouse/buzzy-655f97/7/buzzy');P=ROOT/'.beeline-proof/send-latency';SERIAL='emulator-5626';OTA='01A1A402A77A7A069F2EEF6C50260DDB';DB='/data/user/0/app.usebeeline/databases/updates.db';ORIGINAL='0814b713dcfa6ed20048aae18d4ce2a3b22af36d1a888b564c5b1af0cc0d6f0c'
def adb(*args,text=True):return subprocess.check_output(['adb','-s',SERIAL,*args],text=text)
def sql(query):return json.loads(adb('shell','sqlite3 -json '+DB+' '+shlex.quote(query))or'[]')
def api(path,payload=None):
 for attempt in range(2):
  token=json.loads((P/'session.private.json').read_text())['tokens']['accessToken'];headers={'Authorization':'Bearer '+token}
  if payload is not None:headers['Content-Type']='application/json'
  request=urllib.request.Request('https://server.usebeeline.app'+path,data=json.dumps(payload).encode()if payload is not None else None,headers=headers)
  try:
   with urllib.request.urlopen(request,timeout=20)as response:return json.load(response)
  except urllib.error.HTTPError as error:
   if error.code!=401 or attempt:raise
   subprocess.run(['python3',str(P/'auth.py')],cwd=ROOT,check=True,capture_output=True,timeout=60)
   print('Proof reader access refreshed after expiry',flush=True)
class Fixture:
 def __init__(self,folder):
  self.out=P/folder;self.out.mkdir(exist_ok=True);self.row=sql("SELECT manifest,assets.id asset_id,hex(assets.hash) asset_hash,expected_hash,relative_path FROM updates JOIN assets ON launch_asset_id=assets.id WHERE hex(updates.id)='"+OTA+"'")[0];self.dest='/data/user/0/app.usebeeline/files/.expo-internal/'+self.row['relative_path'];self.original=adb('exec-out','cat',self.dest,text=False);assert hashlib.sha256(self.original).hexdigest()==ORIGINAL;assert json.loads(self.row['manifest'])['extra']['expoClient']['extra']['app']['releaseSha']=='98c2a49a4f3df909e8fd3fc32ae39129f6f8367b';(self.out/'original.hbc').write_bytes(self.original);(self.out/'original.json').write_text(json.dumps(self.row,indent=2))
 def install(self,bundle,label,source):
  adb('shell','am force-stop app.usebeeline');raw=bundle.read_bytes();digest=hashlib.sha256(raw).digest();b64=base64.urlsafe_b64encode(digest).decode().rstrip('=');manifest=json.loads(self.row['manifest']);manifest['launchAsset']['hash']=b64;meta=manifest['extra']['expoClient']['extra']['app'];meta['releaseVersion']='proof-'+label;meta['releaseSha']=source;adb('push',str(bundle),'/data/local/tmp/send-head-fixture.hbc');adb('shell','cat /data/local/tmp/send-head-fixture.hbc > '+self.dest);sql("UPDATE updates SET manifest='"+json.dumps(manifest).replace("'","''")+"' WHERE hex(id)='"+OTA+"'; UPDATE assets SET hash=X'"+digest.hex()+"',expected_hash='"+b64+"' WHERE id="+str(self.row['asset_id'])+';');assert adb('shell','sha256sum '+self.dest).split()[0]==digest.hex();return digest.hex()
 def open(self,room):
  uuid.UUID(room['roomId']);uuid.UUID(room['workspaceId']);route=f'beeline://beeline/chat/{room["roomId"]}?communityId={room["workspaceId"]}';return adb('shell','am start -a android.intent.action.VIEW -d '+shlex.quote(route)+' -p app.usebeeline')
 def screenshot(self,name):
  path=self.out/(name+'.png');path.write_bytes(adb('exec-out','screencap','-p',text=False));return path
 def restore(self,room):
  adb('shell','am force-stop app.usebeeline');adb('push',str(self.out/'original.hbc'),'/data/local/tmp/send-head-original.hbc');adb('shell','cat /data/local/tmp/send-head-original.hbc > '+self.dest);sql("UPDATE updates SET manifest='"+self.row['manifest'].replace("'","''")+"' WHERE hex(id)='"+OTA+"'; UPDATE assets SET hash=X'"+self.row['asset_hash']+"',expected_hash='"+self.row['expected_hash']+"' WHERE id="+str(self.row['asset_id'])+';');assert adb('shell','sha256sum '+self.dest).split()[0]==ORIGINAL;self.open(room);(self.out/'restored.json').write_text(json.dumps({'sha256':ORIGINAL,'metadataRestored':True,'at':time.time()},indent=2));print('Original v142 restored with exact bytes and metadata',flush=True)
