# Read only recorded frames. No device activity or product instrumentation.
exec(open('.beeline-proof/send-latency/measure_frames.py').read().split('cache={}')[0])
import re,math
from concurrent.futures import ThreadPoolExecutor

def norm(s):
 s=re.sub('[^a-z0-9]','',s.lower()).replace('o','0').replace('l','1').replace('i','1').replace('b','8').replace('a','4').replace('d','0').replace('g','6')
 return re.sub(r'(.)\1+', r'\1', s)

def read(i):
 image=frames[i];ink=(image[350:580,:300]<205).sum(axis=1);ys=np.flatnonzero(ink>4)+350
 if not len(ys):return ''
 groups=np.split(ys,np.where(np.diff(ys)>4)[0]+1);lines=[]
 for group in groups[-3:]:
  top=max(0,int(group[0])-3);bottom=min(580,int(group[-1])+4)
  if bottom-top<10:continue
  crop=cv2.resize(image[top:bottom,:300],None,fx=4,fy=4,interpolation=cv2.INTER_CUBIC)
  result=subprocess.run(['tesseract','stdin','stdout','--psm','7','-c','tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],input=cv2.imencode('.png',crop)[1].tobytes(),capture_output=True,check=True).stdout.decode()
  lines.append(result)
 return ' '.join(lines)

def measure(s):
 before=max(i for i,t in enumerate(ns)if t<=s['tapBeforeNs']);indices=[i for i in frames if i>=before and ns[i]<=s['tapAfterNs']+2_500_000_000]
 target=norm(s['token'].removeprefix('sendproof'));previous=before;found=None;trace=[]
 for i in indices:
  text=read(i);trace.append({'frame':i,'ms':(ns[i]-s['tapBeforeNs'])/1e6,'text':text.strip()})
  if any(norm(line).endswith(target)for line in text.splitlines()):found=i;break
  previous=i
 if found is None:raise Exception(f'No readable target {s}: {trace}')
 if ns[found]<s['tapBeforeNs']:raise Exception(f'Preexisting target {s}')
 cv2.imwrite(str(p/f'{label}-{s["sample"]:02}-ocr-first.png'),frames[found]);cv2.imwrite(str(p/f'{label}-{s["sample"]:02}-ocr-previous.png'),frames[previous])
 return {**s,'firstFrame':found,'firstFrameNs':ns[found],'previousFrameNs':ns[previous],'visibleAfterTapBeforeMs':(ns[found]-s['tapBeforeNs'])/1e6,'visibleAfterTapAfterMs':(ns[found]-s['tapAfterNs'])/1e6,'frameGapMs':(ns[found]-ns[previous])/1e6,'recognition':trace}
with ThreadPoolExecutor(max_workers=2)as ex:results=list(ex.map(measure,taps))
values=sorted(s['visibleAfterTapBeforeMs']for s in results)
out={'label':label,'n':len(results),'method':'First per-frame transcript suffix text recognized in native recording; on-device timestamp brackets input tap; original/preceding frames retained. Device elapsed-clock frame metadata, no native settling threshold.','p50Ms':values[math.ceil(len(values)*.5)-1],'p95Ms':values[math.ceil(len(values)*.95)-1],'samples':results}
(p/f'{label}-ocr.json').write_text(json.dumps(out,indent=2));print(json.dumps({k:v for k,v in out.items()if k!='samples'},indent=2))
