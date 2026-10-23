import json,os,pathlib,re,subprocess,time
root=pathlib.Path(os.environ.get('LATENCY_RIG_OUTPUT', pathlib.Path(__file__).resolve().parent))
root.mkdir(parents=True,exist_ok=True)
device=os.environ['LATENCY_RIG_DEVICE']
label=__import__('sys').argv[1]
def adb(*args):
    return subprocess.check_output(['adb','-s',device,*args],text=True)
def arm(needle,name):
    adb('shell','am','broadcast','-a','app.usebeeline.LATENCY_RIG_EXPECT','-n','app.usebeeline/.LatencyRigReceiver','--es','needle',needle,'--es','case',name,'--es','entry','room-list')
adb('logcat','-c')
samples=[]
for n in range(6):
    for name,needle,x,y in [('corner-back','aaaaaaaaaaaaaaaa',100,218),('corner-open','bbbbbbbbbbbbbbbb',540,2024)]:
        case=f'{label}-{name}-{n}'
        arm(needle,case)
        adb('shell','input','tap',str(x),str(y))
        deadline=time.monotonic()+12
        while True:
            logs=adb('logcat','-d','-s','LATENCY_NATIVE:W')
            marks=[json.loads(m) for m in re.findall(r'LATENCY_VISIBLE (\{.*\})',logs)]
            found=next((m for m in marks if m['case']==case),None)
            if found: break
            if time.monotonic()>deadline: raise RuntimeError(f'No native visible frame for {case}')
            time.sleep(.1)
        samples.append({**found,'durationMs':found['paintMs']-found['startMs'],'warmup':n==0})
        (root/f'{label}-navigation.json').write_text(json.dumps(samples,indent=2))
        time.sleep(1)
(root/f'{label}-navigation-logcat.txt').write_text(adb('logcat','-d','-v','epoch'))
print(json.dumps(samples,indent=2))
