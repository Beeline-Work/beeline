from pathlib import Path
import subprocess,time,json,os,math
p=Path('.beeline-proof/send-latency');done=set();deadline=time.monotonic()+900
while time.monotonic()<deadline:
 manifest=json.loads((p/'head3a-paired/manifest.json').read_text())if(p/'head3a-paired/manifest.json').exists()else{'runs':[]}
 for run in manifest['runs']:
  label=run['label']
  if label in done:continue
  result=subprocess.run(['python3',str(p/'ocr_frames.py'),label],capture_output=True,text=True,env={**os.environ,'OMP_THREAD_LIMIT':'1','OPENBLAS_NUM_THREADS':'1'})
  (p/f'{label}-ocr.log').write_text(result.stdout+result.stderr)
  if result.returncode:raise Exception('OCR failed '+label+'; see its log')
  data=json.loads((p/f'{label}-ocr.json').read_text());print(label,data['n'],round(data['p50Ms'],1),round(data['p95Ms'],1),flush=True);done.add(label)
 if len(done)==8:
  results={}
  for kind in ['old','new']:
   samples=[{**sample,'label':run['label']}for run in manifest['runs']if run['kind']==kind for sample in json.loads((p/f'{run["label"]}-ocr.json').read_text())['samples']]
   values=sorted(s['visibleAfterTapBeforeMs']for s in samples);results[kind]={'n':len(values),'p50Ms':values[math.ceil(.5*len(values))-1],'p95Ms':values[math.ceil(.95*len(values))-1],'samples':samples}
  (p/'head3a-paired/results.json').write_text(json.dumps(results,indent=2));print(json.dumps({k:{a:b for a,b in v.items()if a!='samples'}for k,v in results.items()},indent=2),flush=True);break
 time.sleep(2)
else:raise Exception('capture analysis deadline')
