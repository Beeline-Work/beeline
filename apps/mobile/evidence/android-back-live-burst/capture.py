import subprocess,json,time,re,sys,pathlib,os
script_dir=pathlib.Path(__file__).parent
root=pathlib.Path(os.environ['LATENCY_RIG_OUTPUT'])
root.mkdir(parents=True,exist_ok=True)
device=os.environ['LATENCY_RIG_DEVICE']
def adb(*args):return subprocess.check_output(['adb','-s',device,*args],text=True)
def openchat(id):
 adb('shell','am','start','-W','-a','android.intent.action.VIEW','-d','beeline://beeline/chat/'+id,'app.usebeeline/.MainActivity')
 time.sleep(2)
def arm(needle,name):adb('shell','am','broadcast','-a','app.usebeeline.LATENCY_RIG_EXPECT','-n','app.usebeeline/.LatencyRigReceiver','--es','needle',needle,'--es','case',name,'--es','entry','room-list')
room='f13fbac4-e500-4f81-8c20-78bc02c3aac8';corner='a04a1c5f-e21b-4006-8eef-894e73c02b5b';dm='beebee00-0000-4000-8000-000000000025'
mode=sys.argv[1];kind=sys.argv[2];count=int(sys.argv[3]) if len(sys.argv)>3 else 10
samples=[]
adb('logcat','-c')
for n in range(count):
 for _ in range(5):
  adb('shell','uiautomator','dump','/sdcard/back-ui.xml')
  xml=adb('shell','cat','/sdcard/back-ui.xml')
  if 'all conversations' in xml:break
  adb('shell','input','keyevent','4')
  time.sleep(.5)
 if kind=='corner':
  openchat(room)
  adb('shell','input','tap','540','2024')
  time.sleep(2)
  needle='aaaaaaaaaaaaaaaa';target=corner
 else:
  openchat(room if kind=='room' else dm)
  needle='dddddddddddddddd';target=room if kind=='room' else dm
 name=f'{mode}-{kind}-'+('list-back-' if kind!='corner' else 'back-')+str(n)
 arm(needle,name)
 burst=None
 if mode!='idle':
  burst=subprocess.Popen(['node',str(script_dir/'burst.mjs'),mode,target],stdout=subprocess.PIPE,text=True)
  time.sleep(.5)
 adb('shell','input','tap','100','218')
 deadline=time.monotonic()+10
 while True:
  logs=adb('logcat','-d','-s','LATENCY_NATIVE:W')
  found=next((json.loads(x) for x in re.findall(r'LATENCY_VISIBLE (\{.*\})',logs) if json.loads(x)['case']==name),None)
  if found:break
  if time.monotonic()>deadline:raise RuntimeError('No native frame '+name)
  time.sleep(.1)
 if burst:found['burst']=json.loads(burst.communicate()[0])
 found['durationMs']=found['paintMs']-found['startMs'];samples.append(found)
 (root/f'{mode}-{kind}.json').write_text(json.dumps(samples,indent=2))
 time.sleep(1.5)
(root/f'{mode}-{kind}-logcat.txt').write_text(adb('logcat','-d','-v','epoch'))
print(json.dumps(samples,indent=2))
