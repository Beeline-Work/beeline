import pathlib, subprocess, json, concurrent.futures, sys
root=pathlib.Path(sys.argv[1]); samples=int(sys.argv[2]); workers=int(sys.argv[3]) if len(sys.argv)>3 else 16

def run(job):
 p,n=job; out=p.with_name(p.name.replace('.prompt.md',f'.{n}.json')); rawpath=out.with_suffix('.raw'); failure=out.with_suffix('.failure')
 if out.exists(): return
 context=p.read_text(); skills=json.loads(p.with_name(p.name.replace('.prompt.md','.skills.json')).read_text()); calls=[]; texts=[]; raw=[]
 try:
  for step in range(6):
   try:
    r=subprocess.run(['claude','-p','--model','claude-opus-5-5','--fallback-model','claude-opus-5-5','--settings','{"switchModelsOnFlag":false}','--output-format','json','--tools','','--strict-mcp-config','--setting-sources','','--disable-slash-commands','--system-prompt','You are a prompt replay simulator. Follow the supplied replay protocol.'],input=context,text=True,capture_output=True,timeout=300,cwd='/tmp')
    entry={'stdout':r.stdout,'stderr':r.stderr,'returncode':r.returncode};raw.append(entry);rawpath.write_text(json.dumps(raw,indent=2))
   except subprocess.TimeoutExpired as e:
    raw.append({'timeout':True,'stdout':str(e.stdout or ''),'stderr':str(e.stderr or '')});raise
   envelope=json.loads(r.stdout)
   if r.returncode or envelope.get('is_error'): raise ValueError('CLI error: '+str(envelope.get('result',''))[:200])
   unexpected=[k for k,v in envelope.get('modelUsage',{}).items() if k!='claude-opus-5-5' and v.get('outputTokens',0)>0]
   if unexpected: raise ValueError('OFF_MODEL: '+','.join(unexpected))
   s=envelope.get('result',''); a=s.find('{'); obj=None
   for b in range(len(s)-1,a,-1):
    if s[b]!='}': continue
    try: obj=json.loads(s[a:b+1]);break
    except ValueError:pass
   if not isinstance(obj,dict) or not isinstance(obj.get('calls',[]),list): raise ValueError('Malformed replay JSON')
   cs=obj.get('calls',[]); calls+=cs; texts.append(obj.get('text',''));loads=[c for c in cs if isinstance(c,dict) and c.get('name')=='Read' and c.get('args',{}).get('file_path') in skills]
   if not loads: break
   context+='\nPrevious assistant JSON:\n'+json.dumps(obj)+'\nRequested skill results:\n'+json.dumps([{'call':c,'content':skills[c['args']['file_path']]} for c in loads])+'\nContinue the same turn. Return only new calls and text as JSON.'
  out.write_text(json.dumps({'calls':calls,'text':'\n'.join(texts)},indent=2)); print(str(out.relative_to(root)),flush=True)
 except Exception as e:
  raw.append({'controller_error':str(e)});rawpath.write_text(json.dumps(raw,indent=2));failure.write_text(str(e));out.write_text('FAILED REPLAY; diagnostic is in the matching .failure and .raw files.\n');print(str(out.relative_to(root))+' FAILED '+str(e),flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
 for _ in pool.map(run,[(p,n) for p in sorted(root.rglob('*.prompt.md')) for n in range(1,samples+1)]):pass
