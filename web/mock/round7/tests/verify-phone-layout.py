import os,subprocess,json
from pathlib import Path
env=os.environ.copy();env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-r7-mobile-regression';env['CHROME_DEVTOOLS_AXI_MCP_PATH']=str(Path('web/mock/round7/tests/mobile-mcp-adapter.mjs').resolve())
ua='Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36'
def browser(*a):
 r=subprocess.run(['chrome-devtools-axi',*a],env=env,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def evaluate(script):
 raw=browser('eval',script,'--full');v=json.loads(next(l[8:] for l in raw.splitlines() if l.startswith('result: ')));return json.loads(v) if isinstance(v,str) else v
check=Path('web/mock/round7/phone-overlap-check.js').read_text()
results=[]
Path('.scratch/round7-mobile-fix').mkdir(parents=True,exist_ok=True)
browser('open','http://127.0.0.1:4388/mock/round7/?still=1')
for w,h in [(360,780),(390,844),(412,915),(430,932)]:
 for toolbar in [0,112]:
  height=h-toolbar
  browser('emulate','--viewport',f'{w}x{height}x2.6,mobile,touch','--user-agent',ua)
  browser('open','http://127.0.0.1:4388/mock/round7/?still=1')
  # Chrome clears the experimental toolbar-height override on navigation.
  browser('emulate','--viewport',f'{w}x{height}x2.6,mobile,touch','--user-agent',ua)
  values=evaluate('async () => {await document.fonts.ready;await new Promise(r=>setTimeout(r,750));const check=('+check+');const results=[];for(const at of [0,1,1800,2399,2400,2450,3800,5199,5200,7000,8199,8200,11000,11799,11800,11850,12000,12800,14500,14999,15000,15050,15400,16999,17000,20000,20200,21500,22500,24400,25200,25600,27000,30500,32100,33500,35000,36100,37400,38900,40000,42900]){r7Demo.seek(at);await new Promise(r=>setTimeout(r,65));results.push(check());}return results;}')
  for v in values:v['profile']=[w,h];v['currentViewportReduction']=toolbar
  results+=values;Path('.scratch/round7-mobile-fix/after-overlaps.json').write_text(json.dumps(results,indent=2)+'\n');print(w,h,'viewport',height,'collisions',sum(len(v['overlaps']) for v in values),'clipped',sum(len(v['clipped']) for v in values),flush=True)
Path('.scratch/round7-mobile-fix/after-overlaps.json').write_text(json.dumps(results,indent=2)+'\n')

failures=[r for r in results if r['overlaps'] or r['clipped'] or r['escapedImages'] or r['horizontalOverflow'] or r['watchVideoLinks']]
assert all(abs(r['dpr']-2.6)<.01 and r['touchPoints']>0 for r in results), 'Real mobile emulation was not enabled'
assert all(abs(r['height']-r['smallViewport']-112)<1 for r in results), 'Browser-bar override was not active'
assert all(r['visibleAvatars']>=5 and (r['scene']<15400 or r['visibleAvatars']==6) for r in results), 'An avatar was hidden by the fix'
assert all(not r['floatingInvitationVisible'] for r in results), 'A floating phone terminal remains'

assert not failures, json.dumps(failures[:3],indent=2)
print(f'PASS: {len(results)} scene/boundary checks across all four phone widths, two toolbar states, DPR 2.6')
