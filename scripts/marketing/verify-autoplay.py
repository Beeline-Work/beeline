"""Reproduce firstmate's 412×860 scroll, then native wheel/touch, keyboard, hash.
No seek/play/callback invocation is used to start the sequence under test.
"""
import os,subprocess,json,argparse
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:4388/');parser.add_argument('--session',default='beeline-production-autoplay');parser.add_argument('--baseline',action='store_true');parser.add_argument('--methods',default='scrollBy,wheel,touch,keyboard,anchor');args=parser.parse_args()
env=os.environ.copy();env['CHROME_DEVTOOLS_AXI_SESSION']=args.session;env['CHROME_DEVTOOLS_AXI_MCP_PATH']=str(Path('web/mock/round7/tests/gesture-mcp-adapter.mjs').resolve())
out=Path('.scratch/marketing-autoplay');out.mkdir(exist_ok=True,parents=True)
def browser(*a):
 r=subprocess.run(['chrome-devtools-axi',*a],env=env,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def evaluate(js):
 v=json.loads(next(l[8:] for l in browser('eval',js,'--full').splitlines() if l.startswith('result: ')));return json.loads(v) if isinstance(v,str) else v
def wait(ms):return evaluate('async()=>{await new Promise(r=>setTimeout(r,'+str(ms)+'));return true}')
proof=[]
for method in args.methods.split(','):
 browser('open',args.url+('#bring' if method=='anchor' else ''));browser('resize','412','860')
 evaluate('async()=>{await window.beelineReady();await document.fonts.ready;await new Promise(r=>setTimeout(r,800));return true}')
 if method=='scrollBy':evaluate('()=>{window.scrollBy(0,innerHeight);return true}')
 elif method=='wheel':evaluate('()=>"__FM_NATIVE_WHEEL__"')
 elif method=='touch':
  browser('emulate','--viewport','412x860x2.6,mobile,touch','--user-agent','Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36')
  evaluate('()=>"__FM_NATIVE_TOUCH__"')
 elif method=='keyboard':browser('press','PageDown')
 samples=evaluate('''async()=>{const out=[];let previous=0;for(const at of [2000,5000,9500,15000,24000,31000]){await new Promise(r=>setTimeout(r,at-previous));previous=at;out.push({at,scrollY,bringTop:document.querySelector("#bring").getBoundingClientRect().top,input:document.querySelector(".tui-prompt input").value,state:beelineSync.state()});}return out;}''')
 final=samples[-1]['state'];phases={e['phase'] for e in final.get('events',[])}
 passed=final.get('cycle',0)>=2 and {'joined','working','result-shared','room-to-terminal','reply-shared'}<=phases
 if args.baseline:
  assert not passed,'Baseline unexpectedly passed';(out/'autoplay-baseline.json').write_text(json.dumps({'method':method,'samples':samples,'expectedFailure':True},indent=2)+'\n');print('BASELINE FAIL reproduced: '+method+' types the prompt but never joins or loops',flush=True);continue
 assert passed,{'method':method,'samples':samples}
 assert samples[2]['state']['joined'] and any(h['who']=='codex' and h.get('attachment')=='build' for h in samples[2]['state']['history']),samples[2]
 browser('screenshot',str(out/f'autoplay-{method}-412.png'))
 proof.append({'method':method,'viewport':[412,860],'samples':samples});(out/'autoplay-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
 if method=='scrollBy':
  evaluate('()=>{window.scrollTo(0,0);return true}');wait(650);off=evaluate('()=>beelineSync.state()');assert off['phase']=='offscreen' and not off['visible'],off
  evaluate('()=>{window.scrollBy(0,innerHeight);return true}');wait(2600);again=evaluate('()=>beelineSync.state()');assert again['joined'] and again['cycle']>final['cycle'],again
  (out/'reentry-proof.json').write_text(json.dumps({'offscreen':off,'returned':again},indent=2)+'\n')
 print('PASS',method,'auto join → work → human/agent sync → repeated cycles',flush=True)
# Same face path data (including plate coloring seed) in actual shared marks.
if not args.baseline:
 browser('open',args.url.split('#')[0]+('?still=1&at=21500' if '?' not in args.url else '&still=1&at=21500'));browser('resize','412','860');wait(1000)
 identity=evaluate('()=>{const rail=document.querySelector(".node[data-id=codex] [data-testid=codex-shared-mark]"),row=document.querySelector("#native-hero [data-entry-actor=codex] [data-testid=chat-byline-mark]");const paths=e=>[...e.querySelectorAll("path")].map(p=>p.getAttribute("d"));return {rail:paths(rail),transcript:paths(row),allCodexContainers:[...document.querySelectorAll(".native-codex-mark")].map(e=>e.dataset.codexIdentity)}}')
 assert identity['rail'] and identity['rail']==identity['transcript'] and all(v=='cat' for v in identity['allCodexContainers']),identity
 (out/'identity-proof.json').write_text(json.dumps(identity,indent=2)+'\n');browser('screenshot',str(out/'identity-412.png'));print('PASS Codex rail and transcript use the same shared cat mark',flush=True)
