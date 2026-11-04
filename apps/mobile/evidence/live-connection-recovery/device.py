import subprocess,time,xml.etree.ElementTree as E,re,json,sys
from pathlib import Path
root=Path(__file__).parent
serial='emulator-5626'
def adb(*args):return subprocess.check_output(['adb','-s',serial,*map(str,args)])
def nodes():
 adb('shell','uiautomator','dump','/sdcard/live-recovery.xml')
 return list(E.fromstring(adb('shell','cat','/sdcard/live-recovery.xml')).iter('node'))
def tap_id(id):
 n=next(n for n in nodes() if n.get('resource-id')==id)
 x1,y1,x2,y2=map(int,re.findall(r'\d+',n.get('bounds')))
 adb('shell','input','tap',(x1+x2)//2,(y1+y2)//2)
def snapshot(name):
 ns=nodes(); (root/(name+'.xml')).write_bytes(adb('shell','cat','/sdcard/live-recovery.xml'))
 (root/(name+'.png')).write_bytes(adb('exec-out','screencap','-p'))
 texts=[n.get('text') for n in ns if n.get('text')]
 print(json.dumps({'name':name,'texts':texts[-12:]},ensure_ascii=False),flush=True)
if __name__=='__main__':
 action=sys.argv[1]
 if action=='snapshot':snapshot(sys.argv[2])
 if action=='send':
  tap_id('chat-input');adb('shell','input','text',sys.argv[2]);tap_id('chat-send')
 if action=='switch':
  adb('shell','input','keyevent','3');time.sleep(.5)
  adb('shell','am','start','-n','app.usebeeline/.MainActivity')
