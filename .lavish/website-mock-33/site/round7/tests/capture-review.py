"""Desktop + genuine mobile screenshots and surface collision checks via AXI."""
import os,subprocess,json,re
from pathlib import Path
env=os.environ.copy();out=Path('.scratch/round7');out.mkdir(exist_ok=True,parents=True)
ua='Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36'
def browser(*args):
 r=subprocess.run(['chrome-devtools-axi',*args],env=env,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def evaluate(js):
 v=json.loads(next(l[8:] for l in browser('eval',js,'--full').splitlines() if l.startswith('result: ')));return json.loads(v) if isinstance(v,str) else v
def wait(ms=750):return evaluate('async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,'+str(ms)+'));return true}')
def native_type(selector,text):
 evaluate('()=>{document.querySelector('+json.dumps(selector)+').focus();return true}')
 browser('type',text);browser('press','Enter')
check=Path('web/mock/round7/phone-overlap-check.js').read_text();proof=[]
for width,height in [(1440,1000),(360,780),(390,844),(412,915),(430,932)]:
 if width==1440:
  env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-r7-review-desktop';env.pop('CHROME_DEVTOOLS_AXI_MCP_PATH',None)
  browser('open','http://127.0.0.1:4388/mock/round7/?still=1&at=22500');browser('resize',str(width),str(height))
 else:
  env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-r7-review-mobile';env['CHROME_DEVTOOLS_AXI_MCP_PATH']=str(Path('web/mock/round7/tests/mobile-mcp-adapter.mjs').resolve())
  browser('open','http://127.0.0.1:4388/mock/round7/?still=1&at=22500');browser('emulate','--viewport',f'{width}x{height}x2.6,mobile,touch','--user-agent',ua)
  browser('open','http://127.0.0.1:4388/mock/round7/?still=1&at=22500');browser('emulate','--viewport',f'{width}x{height}x2.6,mobile,touch','--user-agent',ua)
 wait()
 hero=evaluate('()=>('+check+')()');assert not hero['overlaps'] and not hero['clipped'] and not hero['escapedImages'] and not hero['horizontalOverflow'],hero
 browser('screenshot',str(out/f'hero-{width}.png'))
 # All desktop states, in addition to the separate 336-case phone regression.
 if width==1440:
  states=evaluate('async()=>{const check=('+check+');const out=[];for(const at of [0,2400,5200,8200,11800,15000,17000,20200,22500,25200,25600,27000,30500,33500,36100,38900,42900]){r7Demo.seek(at);await new Promise(r=>setTimeout(r,80));out.push(check());}return out}')
  assert all(not x['overlaps'] and not x['clipped'] and not x['horizontalOverflow'] for x in states),states
  (out/'desktop-overlaps.json').write_text(json.dumps(states,indent=2)+'\n')
 evaluate('()=>{document.querySelector("#bring").scrollIntoView({behavior:"instant"});return true}');wait()
 browser('screenshot',str(out/f'sync-before-{width}.png'))
 native_type('[aria-label="Codex terminal prompt"]','join my beeline room at usebeeline.app/mcp');wait(1050)
 native_type('[aria-label="Codex terminal prompt"]','Build saved conversations');wait(250)
 browser('screenshot',str(out/f'sync-working-{width}.png'));wait(1900)
 native_type('[data-native-room="sync"] textarea','@Codex keep the keyboard accessible');wait(1350)
 state=evaluate('()=>r7Sync.state()');assert state['joined'] and any('keyboard accessible' in t for t in state['terminal']) and any('Claude Code:' in t for t in state['terminal']) and any('Jimmy:' in t for t in state['terminal']),state
 browser('screenshot',str(out/f'sync-done-{width}.png'))
 # Reuse the same painted-rectangle algorithm against the sync section.
 sync_check=check.replace("document.querySelector('#hero')","document.querySelector('#bring')")
 sync=evaluate('()=>('+sync_check+')()');assert not sync['overlaps'] and not sync['clipped'] and not sync['horizontalOverflow'],sync
 evaluate('()=>{document.activeElement.blur();document.querySelector("#context").scrollIntoView({behavior:"instant"});return true}');wait(2900)
 browser('screenshot',str(out/f'context-{width}.png'))
 proof.append({'viewport':[width,height],'hero':hero,'sync':sync,'syncState':state});(out/'viewport-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
 print('PASS',width,height,'hero and two-way keyboard sync, painted bounds',flush=True)
