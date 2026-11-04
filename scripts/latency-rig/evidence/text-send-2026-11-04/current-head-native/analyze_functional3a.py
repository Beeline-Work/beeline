from pathlib import Path
import json,struct,cv2,subprocess,re,csv,io,numpy as np
from concurrent.futures import ThreadPoolExecutor
p=Path('.beeline-proof/send-latency/head3a-functional');data=json.loads((p/'results.json').read_text())
def norm(text):return re.sub('[^a-z0-9]','',text.lower()).replace('o','0').replace('l','1').replace('i','1')
def distance(a,b):
 prior=list(range(len(b)+1))
 for i,x in enumerate(a,1):
  row=[i]
  for j,y in enumerate(b,1):row.append(min(row[-1]+1,prior[j]+1,prior[j-1]+(x!=y)))
  prior=row
 return prior[-1]
def words(image):
 raw=subprocess.run(['tesseract','stdin','stdout','--psm','6','tsv'],input=cv2.imencode('.png',cv2.resize(image,None,fx=2,fy=2))[1].tobytes(),capture_output=True,check=True).stdout.decode();return[list(csv.DictReader(io.StringIO(raw),delimiter='\t'))][0]
def hits(image,token):
 found=[]
 for word in words(image):
  text=norm(word['text']or'')
  if text and distance(text,norm(token))<=1:
   box=[int(word[k])//2 for k in ['left','top','width','height']];x,y,w,h=box;ink=image[y:y+h,x:x+w];found.append({'word':word['text'],'box':box,'inkP5':float(np.percentile(ink,5)),'inkMin':int(ink.min())})
 return found

def analyze(item,label):
 blob=(p/(label+'.mp4')).read_bytes();at=blob.index(b'#VV1NSC0PET1ME2#');v,offset,count=struct.unpack_from('<IQI',blob,at+16);ns=struct.unpack_from('<'+'Q'*count,blob,at+32);tap=item.get('tap',item.get('timing',{}).get('send'));before=tap['tapBeforeElapsedNs'];capture=cv2.VideoCapture(str(p/(label+'.mp4')));trace=[];first=None;prior=None;end=None;max_count=0;target_frames=0;leaks=[]
 capture.set(cv2.CAP_PROP_POS_FRAMES,count-1);ok,last=capture.read();assert ok
 target_header=cv2.cvtColor(last[45:100,170:480],cv2.COLOR_BGR2GRAY)
 capture.set(cv2.CAP_PROP_POS_FRAMES,0)
 for i,t in enumerate(ns):
  ok,frame=capture.read()
  if not ok:break
  gray=cv2.cvtColor(frame[110:690,10:530],cv2.COLOR_BGR2GRAY);match=hits(gray,item['token'])if t>=before-500_000_000 else[]
  if t<before:
   assert not match,'token preexisting';prior=frame;continue
  max_count=max(max_count,len(match));trace.append({'frame':i,'afterTapBeforeMs':(t-before)/1e6,'count':len(match),'hits':match})
  if match:
   if first is None:
    first={'frame':i,'elapsedNs':t,'afterTapBeforeMs':(t-before)/1e6,'hits':match};cv2.imwrite(str(p/(label+'-first.png')),frame)
    if prior is not None:cv2.imwrite(str(p/(label+'-previous.png')),prior)
   end=match
  if label=='navigate-first-paint':
   header=cv2.cvtColor(frame[45:100,170:480],cv2.COLOR_BGR2GRAY);similarity=float(cv2.matchTemplate(header,target_header,cv2.TM_CCOEFF_NORMED)[0,0])
   if similarity>=.97:
    target_frames+=1
    if match:
     leaks.append({'frame':i,'elapsedNs':t,'count':len(match),'similarity':similarity});cv2.imwrite(str(p/(label+'-suspect-'+str(i)+'.png')),frame)
  prior=frame
 capture.release()
 if label=='navigate-first-paint':cv2.imwrite(str(p/(label+'-last.png')),last)
 if label!='navigate-first-paint':assert first is not None
 result={'label':label,'token':item['token'],'first':first,'settledHits':end,'maxNativeCopies':max_count,'targetRoomFrames':target_frames,'targetRoomLeaks':leaks,'frames':trace};(p/(label+'-frames.json')).write_text(json.dumps(result,indent=2));return{k:v for k,v in result.items()if k!='frames'}
with ThreadPoolExecutor(max_workers=2)as executor:results=list(executor.map(lambda pair:analyze(*pair),zip(data['scenarios'],['empty-send','double-tap','navigate-first-paint'])))
(p/'frame-summary.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
