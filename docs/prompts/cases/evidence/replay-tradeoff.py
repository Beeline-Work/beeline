import pathlib, subprocess, json, concurrent.futures, sys, re
root=pathlib.Path(sys.argv[1]); samples=int(sys.argv[2])
def run(job):
 p,n=job; out=root/(p.name.replace('.prompt.md',f'.{n}.json'))
 if out.exists(): return
 context=p.read_text(); skills=json.loads(p.with_name(p.name.replace('.prompt.md','.skills.json')).read_text()); calls=[]; texts=[]; raw=[]
 for step in range(6):
  r=subprocess.run(['claude','-p','--model','claude-opus-5-5','--tools','','--strict-mcp-config','--setting-sources','','--disable-slash-commands','--system-prompt','You are a prompt replay simulator. Follow the supplied replay protocol.'],input=context,text=True,capture_output=True,timeout=240,cwd='/tmp')
  raw.append({'stdout':r.stdout,'stderr':r.stderr,'returncode':r.returncode}); out.with_suffix('.raw').write_text(json.dumps(raw,indent=2))
  s=r.stdout; a=s.find('{'); obj=None
  for b in range(len(s)-1,a,-1):
   if s[b]!='}': continue
   try: obj=json.loads(s[a:b+1]); break
   except ValueError: pass
  if not isinstance(obj,dict):
   out.write_text('MALFORMED MODEL RESPONSE: no valid JSON object; counted as failed.'); print(out.name+' MALFORMED',flush=True); return
  cs=obj.get('calls',[]); calls+=cs; texts.append(obj.get('text','')); loads=[c for c in cs if c.get('name')=='Read' and c.get('args',{}).get('file_path') in skills]
  if not loads: break
  context+='\nPrevious assistant JSON:\n'+json.dumps(obj)+'\nRequested skill results:\n'+json.dumps([{'call':c,'content':skills[c['args']['file_path']]} for c in loads])+'\nContinue the same turn. Return only new calls and text as JSON.'
 out.write_text(json.dumps({'calls':calls,'text':'\n'.join(texts)},indent=2)); out.with_suffix('.raw').write_text(json.dumps(raw,indent=2)); print(out.name,flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
 for _ in pool.map(run,[(p,n) for p in sorted(root.glob('*.prompt.md')) for n in range(1,samples+1)]): pass
