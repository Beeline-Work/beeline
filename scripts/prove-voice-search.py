import argparse, json, time, subprocess, statistics, urllib.request
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('mode',choices=['baseline','branch'])
parser.add_argument('--device',default='emulator-5554')
parser.add_argument('--skip-latency',action='store_true')
args=parser.parse_args()
out=Path('docs/voice-mode-proof/quick-search');out.mkdir(parents=True,exist_ok=True)
def req(path,body=None):
    r=urllib.request.Request('http://127.0.0.1:18097'+path,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r,timeout=40))
def wait(pred,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:r=req('/result')
        except OSError:
            time.sleep(.15);continue
        if pred(r):return r
        time.sleep(.15)
    raise AssertionError('Expected call observation did not arrive')
def adb(*args):return subprocess.check_output(['adb','-s',device,*args])
def native(r):return [x for x in r['observations'] if 'joined' in x]
def energy(r):return max((sum(x.get('totalAudioEnergy',0) for x in a['nativeAudio']) for a in r['observations'] if 'nativeAudio' in a),default=0)
device=args.device
mode=args.mode
wait(lambda r:r.get('callId'),90)
adb('shell','am','force-stop','app.usebeeline')
adb('shell','am','start','-n','app.usebeeline/.MainActivity')
wait(lambda r:native(r))
time.sleep(1)
adb('shell','input','tap','875','880')
wait(lambda r:r['humans']==2 and native(r)[-1]['joined'])
samples=[]
for i in range(0 if args.skip_latency else 5):
    req('/say',{'text':'Ruby ready?'})
    time.sleep(.2)
    samples.append(native(req('/result'))[-1]['firstAudioMs'])
steps=[]
if mode=='branch':
    before=req('/result');req('/say',{'text':'Ruby search Japan'})
    r=wait(lambda r:any(m['text']=='Tokyo is the capital of Japan.' for m in r['transcript']) and energy(r)>energy(before))
    assert r['commands']['count']==0
    steps.append('fast web search answered as native audio without a command')
    for case in ['slow','failed']:
        before=req('/result');req('/say',{'text':'Ruby '+case+' search Japan'})
        r=wait(lambda r:r['commands']['count']==before['commands']['count']+1)
        assert r['dispatchAttempts']==before['dispatchAttempts']+1
        e=energy(r)
        if case=='slow':req('/talking',{})
        req('/report',{})
        if case=='slow':
            time.sleep(.5);r=req('/result')
            assert not any(s['text']=='The work is done. The rest is in the chat.' for s in r['synthesis'])
            req('/quiet',{})
        r=wait(lambda r:energy(r)>e and any(s['text']=='The work is done. The rest is in the chat.' for s in r['synthesis']))
        assert any(m['text'].startswith('The work is done.\n\nFull report details.') for m in r['transcript'])
        steps.append(case+' search dispatched once, full report retained, short report heard on Android')
    # Retarget using the real agent avatar before a later report arrives.
    req('/say',{'text':'Ruby failed search Japan'})
    req('/talking',{})
    req('/report',{})
    adb('shell','input','tap','240','2120');time.sleep(.4)
    wait(lambda r:r['currentTargets'].get('a'*64)=='c'*64)
    count=len([s for s in req('/result')['synthesis'] if s['text'].startswith('The work is done.')])
    req('/quiet',{});time.sleep(.7)
    r=req('/result')
    assert len([s for s in r['synthesis'] if s['text'].startswith('The work is done.')])==count
    assert all(o['spoken_message_id'] is not None for o in r['orders'])
    steps.append('real avatar retarget during human speech suppressed and handled the report at quiet')
    req('/say',{'text':'Ruby failed search Japan'})
    req('/talking',{}); req('/report',{})
    req('/leave-proof',{}); req('/quiet',{}); time.sleep(.7)
    r=req('/result')
    assert len([s for s in r['synthesis'] if s['text'].startswith('The work is done.')])==count
    assert all(o['spoken_message_id'] is not None for o in r['orders'])
    steps.append('caller departure during human speech suppressed and handled the report at quiet')
r=req('/result')
record_name='functional' if args.skip_latency else mode
(out/(record_name+'.json')).write_text(json.dumps({'mode':mode,'firstAudioMs':samples,'medianFirstAudioMs':statistics.median(samples) if samples else None,'steps':steps,'result':r},indent=2)+'\n')
(out/(record_name+'.png')).write_bytes(adb('exec-out','screencap','-p'))
print(json.dumps({'mode':mode,'samples':samples,'median':statistics.median(samples) if samples else None,'steps':steps}))
