"""Android regression for message swipe cancellation and commit.

Load scripts/message-swipe-native-proof.tsx as the debug app entry.
Run on the leased Android emulator; this exercises the shipped component.
"""
import json, subprocess, time, re, sys
from pathlib import Path
assert len(sys.argv) == 3, 'Usage: python3 scripts/message-swipe-android-test.py LABEL OUTPUT_DIR'
label=sys.argv[1]
out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
serial='emulator-5554'
def adb(*args): return subprocess.check_output(['adb','-s',serial,*args],timeout=60)
def snapshot(name):
 adb('shell','uiautomator','dump','/sdcard/swipe.xml')
 xml=adb('shell','cat','/sdcard/swipe.xml').decode()
 (out/f'{label}-{name}.xml').write_text(xml)
 (out/f'{label}-{name}.png').write_bytes(adb('exec-out','screencap','-p'))
 return xml
def motion(points):
 commands=[]
 for kind,x,y,delay in points:
  commands += [f'input motionevent {kind} {x} {y}', f'sleep {delay}']
 adb('shell','\n'.join(commands))
assert '1080x2400' in adb('shell','wm','size').decode(), 'Replay requires the 1080x2400 proof emulator'
baseline=snapshot('baseline')
def body_bounds(xml):
 m=re.search(r'resource-id="copy-message-long-agent"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',xml)
 assert m, 'Proof message must be visible'
 return list(map(int,m.groups()))
rest=body_bounds(baseline)
results=[]
for name,points in [
 ('under-threshold',[('DOWN',800,1000,.1),('MOVE',770,1000,.1),('MOVE',735,1000,.4),('UP',735,1000,0)]),
 ('scroll-interrupted',[('DOWN',800,1000,.1),('MOVE',785,985,.1),('MOVE',770,930,.1),('MOVE',730,850,.1),('MOVE',725,600,.2),('UP',725,600,0)]),
]:
 motion(points);time.sleep(2)
 xml=snapshot(name)
 bounds={}
 for testid in ['swipe-reply-long-agent','copy-message-long-agent']:
  m=re.search(r'resource-id="'+testid+r'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',xml)
  bounds[testid]=list(map(int,m.groups())) if m else None
 body=body_bounds(xml)
 at_rest=abs(body[0]-rest[0])<=1
 assert at_rest, f'{name}: message remains translated: {body[0]-rest[0]}px'
 assert 'reply-proof-quote' not in xml, f'{name}: canceled swipe installed a quote'
 if name=='scroll-interrupted': assert body[1]<rest[1]-100, 'Vertical list scroll did not occur'
 results.append({'case':name,'bounds':bounds,'bodyOffsetPx':body[0]-rest[0],'atRest':at_rest,'quoteInstalled':False})
# Restore the list before exercising both committed directions.
adb('shell','input','swipe','600','350','600','1000','300');time.sleep(1)
for name,start,end,receipt in [('reply',900,420,'Reply quote installed'),('corner',180,660,'Corner action fired')]:
 adb('shell','input','swipe',str(start),'1000',str(end),'1000','500');time.sleep(2)
 xml=snapshot(name)
 assert receipt in xml, f'{name}: action did not commit'
 assert abs(body_bounds(xml)[0]-rest[0])<=1, f'{name}: committed row did not return'
 if name=='reply': assert 'reply-proof-quote' in xml, 'Reply quote missing'
 results.append({'case':name,'atRest':True,'receipt':receipt})
 adb('shell','input','keyevent','111');time.sleep(.5)
print(json.dumps(results,indent=2))
(out/f'{label}.json').write_text(json.dumps(results,indent=2))
