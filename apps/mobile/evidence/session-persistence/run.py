from pathlib import Path
import argparse,subprocess,time,json,re,urllib.request,xml.etree.ElementTree as ET,datetime

parser=argparse.ArgumentParser()
parser.add_argument('--device',required=True)
args=parser.parse_args()
serial=args.device
assert serial.startswith('emulator-') and serial != 'emulator-5554', 'Use your own isolated emulator'
out=Path('.task-proof')
start=time.monotonic()
def adb(*args, binary=False):
    return subprocess.run(['adb','-s',serial,*args],capture_output=True,check=True,text=not binary,timeout=40).stdout
def status(action='status'):
    return json.load(urllib.request.urlopen('http://127.0.0.1:45861/_proof/'+action,timeout=20))
def report(name, **extra):
    row={'event':name,'elapsedSeconds':round(time.monotonic()-start),'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),**extra}
    with (out/'native-proof.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
    print(json.dumps(row),flush=True)
def screen(name):
    (out/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
    adb('shell','uiautomator','dump','--compressed','/sdcard/session-proof-candidate.xml')
    adb('pull','/sdcard/session-proof-candidate.xml',str(out/(name+'.xml')))
    nodes=list(ET.parse(out/(name+'.xml')).iter('node'))
    text=' '.join((n.get('text') or n.get('content-desc') or '') for n in nodes)
    assert 'Continue with GitHub' not in text, (name,'signed out')
    return nodes,text
def checkpoint(name, deck=True):
    nodes,text=screen(name)
    state=status()
    assert state['signIns']==1 and state['sessions']==1, (name,state)
    if deck: assert any(n.get('resource-id')=='room-list' for n in nodes) or 'Beeline Review' in text, (name,text)
    report(name,**state)
def wait_until(seconds):
    while time.monotonic()-start<seconds: time.sleep(min(30,seconds-(time.monotonic()-start)))
def foreground():
    adb('shell','am','start','-n','app.usebeeline/.MainActivity')
def restart():
    adb('shell','am','force-stop','app.usebeeline');foreground()

# Complete the ordinary first-account welcome carousel through its actual controls.
for i in range(5):
    nodes,text=screen('welcome-'+str(i))
    button=next((n for n in nodes if (n.get('text') or n.get('content-desc')) in ['Next','Get started']),None)
    if button is None:break
    x1,y1,x2,y2=map(int,re.findall(r'\d+',button.get('bounds')))
    adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2));time.sleep(2)
time.sleep(5)
checkpoint('baseline')
report('ota-published',**status('publish-ota'))
adb('shell','input','keyevent','KEYCODE_HOME');time.sleep(3);foreground();time.sleep(12)
checkpoint('after-ota-retained-review-intent')
report('server-replaced',**status('deploy'))
adb('shell','input','keyevent','KEYCODE_HOME');time.sleep(5);foreground();time.sleep(7)
checkpoint('after-server-replacement')
restart();time.sleep(8);checkpoint('after-process-restart')
adb('shell','input','keyevent','KEYCODE_HOME');time.sleep(30);foreground();time.sleep(5)
checkpoint('after-background')
wait_until(13*60)
report('lost-reply-armed',**status('drop-next-refresh'))
adb('shell','input','keyevent','KEYCODE_HOME')
wait_until(15.5*60)
foreground();time.sleep(15)
checkpoint('after-lost-refresh-reply',deck=False)
assert status()['dropped']==1,status()
adb('shell','input','keyevent','KEYCODE_HOME')
# Outlast the former 120-second grace while the app is asleep, then cold-start offline.
wait_until(18.5*60)
adb('shell','svc','wifi','disable');adb('shell','svc','data','disable')
restart();time.sleep(12);checkpoint('expired-access-offline-cold-start',deck=False)
adb('shell','svc','wifi','enable');adb('shell','svc','data','enable')
restart();time.sleep(12);checkpoint('recovered-after-sleep-and-lost-reply')
assert status()['renewals']>=2,status()
report('second-server-replacement',**status('deploy'))
restart();time.sleep(8);checkpoint('after-second-server-replacement')
wait_until(20*60)
checkpoint('final-20-minute-session')
report('PASS')
