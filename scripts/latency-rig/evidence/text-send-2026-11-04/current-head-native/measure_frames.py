import cv2,json,subprocess,pathlib,struct,concurrent.futures,sys,re,numpy as np
p=pathlib.Path('.beeline-proof/send-latency');label=sys.argv[1];blob=(p/f'{label}.mp4').read_bytes()
def boxes(start,end):
 while start+8<=end:
  size,kind=struct.unpack_from('>I4s',blob,start)
  if size==1:size=struct.unpack_from('>Q',blob,start+8)[0]
  if size<8:break
  yield kind,start,size
  if kind in [b'moov',b'trak',b'mdia',b'minf',b'stbl']:yield from boxes(start+8,start+size)
  start+=size
# Android screenrecord v2 metadata carries realtime-minus-monotonic ns and per-frame monotonic ns.
for kind,start,size in boxes(0,len(blob)):
 if kind==b'co64':
  for i in range(struct.unpack_from('>I',blob,start+12)[0]):
   offset=struct.unpack_from('>Q',blob,start+16+8*i)[0]
   if blob[offset:offset+16]==b'#VV1NSC0PET1ME2#':meta=offset
version,offset,count=struct.unpack_from('<IQI',blob,meta+16);assert version==2
ns=[v+offset for v in struct.unpack_from('<'+'Q'*count,blob,meta+32)]
taps=json.loads((p/f'{label}-taps.json').read_text())['samples']
if all('tapBeforeElapsedNs'in sample for sample in taps):
 ns=[t-offset for t in ns]
 taps=[{**sample,'wallTapBeforeNs':sample['tapBeforeNs'],'wallTapAfterNs':sample['tapAfterNs'],'tapBeforeNs':sample['tapBeforeElapsedNs'],'tapAfterNs':sample['tapAfterElapsedNs']}for sample in taps]
needed={i for s in taps for i,t in enumerate(ns) if s['tapBeforeNs']-100_000_000<=t<=s['tapAfterNs']+2_500_000_000}
needed.update(max(i for i,t in enumerate(ns) if t<=s['tapBeforeNs']) for s in taps)
c=cv2.VideoCapture(str(p/f'{label}.mp4'));frames={}
for i in range(count):
 ok,img=c.read()
 if not ok:break
 if i in needed:frames[i]=cv2.cvtColor(img[110:690,10:530],cv2.COLOR_BGR2GRAY)
cache={}
def ocr(i):
 if i not in cache:
  result=subprocess.run(['tesseract','stdin','stdout','--psm','6'],input=cv2.imencode('.png',cv2.resize(frames[i],None,fx=2,fy=2,interpolation=cv2.INTER_CUBIC))[1].tobytes(),capture_output=True,check=True).stdout.decode()
  cache[i]=result
 return cache[i]
def match(text,token):
 normalized=lambda x:re.sub('[^a-z0-9]','',x.lower()).replace('o','0').replace('l','1').replace('i','1')
 return re.sub('0+', '0', normalized(token)) in re.sub('0+', '0', normalized(text))
def measure(s):
 indices=[i for i in frames if s['tapBeforeNs']-100_000_000<=ns[i]<=s['tapAfterNs']+2_500_000_000]
 lo,hi=0,len(indices)-1
 assert not match(ocr(indices[lo]),s['token']),f'preexisting {s}'
 assert match(ocr(indices[hi]),s['token']),f'not visible {s}: {ocr(indices[hi])}'
 while hi-lo>1:
  mid=(lo+hi)//2
  if match(ocr(indices[mid]),s['token']):hi=mid
  else:lo=mid
 i=indices[hi];before=indices[lo]
 cv2.imwrite(str(p/f'{label}-{s["sample"]:02}-first.png'),frames[i]);cv2.imwrite(str(p/f'{label}-{s["sample"]:02}-previous.png'),frames[before])
 return {**s,'firstFrame':i,'firstFrameNs':ns[i],'previousFrameNs':ns[before],'visibleAfterTapBeforeMs':(ns[i]-s['tapBeforeNs'])/1e6,'visibleAfterTapAfterMs':(ns[i]-s['tapAfterNs'])/1e6,'frameGapMs':(ns[i]-ns[before])/1e6}
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:results=list(ex.map(measure,taps))
def percentile(key,q):return sorted(s[key]for s in results)[int(np.ceil(len(results)*q))-1]
output={'label':label,'n':len(results),'method':'Android screenrecord per-frame monotonic metadata + realtime offset; tap bracket from on-device date before/after input tap; OCR restricted to transcript, excludes input; first visible frame binary search; previous/first frames retained','p50Ms':percentile('visibleAfterTapBeforeMs',.5),'p95Ms':percentile('visibleAfterTapBeforeMs',.95),'p50TapCommandMs':sorted((s['tapAfterNs']-s['tapBeforeNs'])/1e6 for s in results)[len(results)//2],'samples':results}
(p/f'{label}-visible.json').write_text(json.dumps(output,indent=2));print(json.dumps({k:v for k,v in output.items()if k!='samples'},indent=2))
