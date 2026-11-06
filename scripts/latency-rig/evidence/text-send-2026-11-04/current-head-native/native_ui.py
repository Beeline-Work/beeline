import io,re,time,subprocess,json
import numpy as np
from PIL import Image
from phone_fixture import adb,P,SERIAL

def text_crop(image,box,psm=6):
 out=io.BytesIO();image.crop(box).save(out,format='PNG');return subprocess.run(['tesseract','stdin','stdout','--psm',str(psm)],input=out.getvalue(),capture_output=True,check=True).stdout.decode()
def screen():return Image.open(io.BytesIO(adb('exec-out','screencap','-p',text=False)))
def normalized(text):return re.sub(r'(.)\1+',r'\1',re.sub('[^a-z0-9]','',text.lower()).replace('o','0').replace('l','1').replace('i','1'))
def wait_room(prefix='latency'):
 for attempt in range(35):
  image=screen();title=text_crop(image,(0,75,1000,230));footer=text_crop(image,(90,2180,900,2340));keyboard=text_crop(image,(90,1380,900,1490))
  if normalized(prefix)in normalized(title)and(footer.strip()or keyboard.strip()):return
  time.sleep(.4)
 image.save(P/'native-room-not-ready.png');raise Exception(f'Room not ready: {title!r}')
def focus():
 if 'mInputShown=true'not in adb('shell','dumpsys input_method'):
  adb('shell','input tap 250 2258');time.sleep(.5)
 assert 'mInputShown=true'in adb('shell','dumpsys input_method')
def editor_ready(token=None):
 for attempt in range(40):
  image=screen();text=text_crop(image,(145,1395,880,1475),7);arrow=np.asarray(image.crop((955,1408,1007,1470))).astype(int);gold=int(((arrow[:,:,0]>arrow[:,:,1]+20)&(arrow[:,:,1]>arrow[:,:,2]+25)&(arrow[:,:,0]<190)).sum())
  if token is None and 'message'in text.lower():return
  if token is not None and normalized(token)in normalized(text)and gold>10:return
  time.sleep(.25)
 image.save(P/'native-editor-not-ready.png');raise Exception(f'Editor not ready: {text!r},gold={gold},token={token}')
def type_text(token):
 assert re.fullmatch('[A-Za-z0-9]+',token);focus();editor_ready();adb('shell','input text '+token);editor_ready(token);time.sleep(.2)
def clear_draft():
 focus();adb('shell','input keycombination 113 29; input keyevent 67');editor_ready()
def tap(x=981,y=1438,count=1):
 action='; '.join([f'input tap {x} {y}']*count);parts=adb('shell','date +%s%N; cat /proc/uptime; '+action+'; cat /proc/uptime; date +%s%N').splitlines();assert len(parts)==4
 return{'tapBeforeNs':int(parts[0]),'tapAfterNs':int(parts[3]),'tapBeforeElapsedNs':round(float(parts[1].split()[0])*1e9),'tapAfterElapsedNs':round(float(parts[2].split()[0])*1e9),'count':count,'x':x,'y':y}
def capture(out,label,action):
 path=out/(label+'.mp4');rec=subprocess.Popen(['adb','-s',SERIAL,'shell',f'screenrecord --size 540x1200 --bit-rate 4000000 --time-limit 180 /sdcard/send-head-{label}.mp4'],stdout=subprocess.PIPE,stderr=subprocess.PIPE);time.sleep(.7);pid=adb('shell','pidof screenrecord').strip();assert pid.isdigit()
 try:result=action();time.sleep(3)
 finally:adb('shell',f'kill -2 {pid}');rec.wait(timeout=20)
 adb('pull',f'/sdcard/send-head-{label}.mp4',str(path));return result
