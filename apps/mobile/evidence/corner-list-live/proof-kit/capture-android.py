import subprocess,time,json,pathlib,urllib.request,csv,io,sys,os
variant=sys.argv[1]; device=os.environ.get('CORNER_PROOF_DEVICE','emulator-5562');root=pathlib.Path('.local/corner-proof/results/android-'+variant);root.mkdir(parents=True,exist_ok=True)
def adb(*args,**kw): return subprocess.run(['adb','-s',device,*args],check=True,stdout=subprocess.PIPE,**kw).stdout
def control(action): return json.load(urllib.request.urlopen('http://127.0.0.1:9183/'+action))
def shot(name):
 start=int(time.time()*1000);data=adb('exec-out','screencap','-p');end=int(time.time()*1000);p=root/(name+'.png');p.write_bytes(data);return {'name':name,'captureStartedAt':start,'captureEndedAt':end,'path':str(p)}
def ocr(p): return subprocess.check_output(['tesseract',str(p),'stdout','--psm','11'],stderr=subprocess.DEVNULL).decode()
def open_list():
 adb('shell','am','start','-W','-a','android.intent.action.VIEW','-d','beeline://beeline/corners/b2aa0000-0000-4000-8000-000000000001','app.usebeeline/.MainActivity');time.sleep(1)
def tap_row(action):
 for attempt in range(20):
  s=shot(action+'-before-list');tsv=subprocess.check_output(['tesseract',s['path'],'stdout','--psm','11','tsv'],stderr=subprocess.DEVNULL).decode()
  for row in csv.DictReader(io.StringIO(tsv),delimiter='\t'):
   if action+'-proof' in row['text'].lower():
    adb('shell','input','tap',str(int(row['left'])+int(row['width'])//2),str(int(row['top'])+int(row['height'])//2));time.sleep(.8);return
  if attempt==5:open_list()
  time.sleep(.5)
 raise RuntimeError('Missing corner row: '+ocr(s['path']))
actions=sys.argv[2:] or ['archive','turn']
control('reset');open_list();results=json.loads((root/'results.json').read_text()) if (root/'results.json').exists() else []
results=[r for r in results if r['action'] not in actions]
for action in actions:
 if action=='turn':open_list()
 tap_row(action)
 control('reset');time.sleep(.5)
 initial=shot(action+'-before-header');initial['text']=ocr(initial['path']);print(initial['text'],flush=True)
 expected='working' if action=='archive' else 'idle'
 if expected not in initial['text'].lower():raise RuntimeError('Rejected initial header: expected '+expected)
 eviction=control('evict')
 video_path='/sdcard/jellybean-corner-'+variant+'-'+action+'.mp4'
 record_start=int(time.time()*1000)
 recorder=subprocess.Popen(['adb','-s',device,'shell','screenrecord','--bit-rate','2000000','--time-limit','10',video_path],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 time.sleep(.5)
 write=control(action);frames=[]
 if action=='archive' and write.get('status')!=204:raise RuntimeError('Archive request failed: '+str(write))
 # Keep the header visible for its update, then return to the already-open list.
 while int(time.time()*1000)-write['startedAt']<(2800 if variant=='main' else 800):frames.append(shot(action+'-header-'+str(len(frames))))
 adb('shell','input','keyevent','4')
 while int(time.time()*1000)-write['startedAt']<5500:frames.append(shot(action+'-list-'+str(len(frames))))
 recorder.wait(timeout=15)
 adb('pull',video_path,str(root/(action+'.mp4')))
 for frame in frames:
  frame['text']=ocr(frame['path']);frame['elapsedMs']=frame['captureEndedAt']-write['startedAt']
 results.append({'variant':variant,'action':action,'eviction':eviction,'recordRequestedAt':record_start,'write':write,'initial':initial,'frames':frames})
 (root/'results.json').write_text(json.dumps(results,indent=2))
 print(json.dumps({'action':action,'write':write,'frames':[(f['name'],f['elapsedMs'],f['text']) for f in frames]}),flush=True)
