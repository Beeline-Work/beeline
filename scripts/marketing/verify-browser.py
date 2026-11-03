"""Real keyboard and responsive proof of the production homepage through AXI."""
import os,subprocess,json
from pathlib import Path
env=os.environ.copy();out=Path('.scratch/marketing-browser');out.mkdir(parents=True,exist_ok=True)
ua='Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36'
def browser(*a):
 r=subprocess.run(['chrome-devtools-axi',*a],env=env,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def evaluate(js):
 v=json.loads(next(l[8:] for l in browser('eval',js,'--full').splitlines() if l.startswith('result: ')));return json.loads(v) if isinstance(v,str) else v
def wait(ms=500):return evaluate('async()=>{await new Promise(r=>setTimeout(r,'+str(ms)+'));return true}')
def type_into(selector,text):
 evaluate('()=>{document.querySelector('+json.dumps(selector)+').focus();return true}');browser('type',text);browser('press','Enter')
check=Path('web/mock/round7/phone-overlap-check.js').read_text().replace('r7Demo','beelineDemo');proof=[]
for width,height in [(1440,1000),(360,780),(390,844),(412,915),(430,932)]:
 if width==1440:
  env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-production-keyboard-desktop';env.pop('CHROME_DEVTOOLS_AXI_MCP_PATH',None)
  browser('open','http://127.0.0.1:4388/?still=1&at=22500');browser('resize',str(width),str(height))
 else:
  env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-production-keyboard-mobile';env['CHROME_DEVTOOLS_AXI_MCP_PATH']=str(Path('web/mock/round7/tests/mobile-mcp-adapter.mjs').resolve())
  browser('open','http://127.0.0.1:4388/?still=1&at=22500');browser('emulate','--viewport',f'{width}x{height}x2.6,mobile,touch','--user-agent',ua)
  browser('open','http://127.0.0.1:4388/?still=1&at=22500');browser('emulate','--viewport',f'{width}x{height}x2.6,mobile,touch','--user-agent',ua)
 evaluate('async()=>{await window.beelineReady();await document.fonts.ready;await new Promise(r=>setTimeout(r,750));return true}')
 hero=evaluate('()=>('+check+')()');assert not hero['overlaps'] and not hero['clipped'] and not hero['escapedImages'] and not hero['horizontalOverflow'],hero
 assert evaluate('()=>document.querySelector(".node[data-id=codex] .tile").innerHTML.includes("face-edge")')
 browser('screenshot',str(out/f'hero-{width}.png'))
 type_into('[data-native-room=hero] textarea','@Hermes <img src=x onerror=alert(1)> make a video');wait(1700)
 h=evaluate('()=>{beelineDemo.pause();return {state:beelineDemo.state(),injected:!!document.querySelector("#room-ledger img[src=x]")}}');assert h['state']['visitorMessages']==1 and h['state']['localReplies']==2 and not h['injected'],h
 evaluate('()=>{document.activeElement.blur();document.querySelector("#bring").scrollIntoView({behavior:"instant"});return true}');wait(750)
 type_into('[aria-label="Codex terminal prompt"]','join my beeline room at usebeeline.app/mcp');wait(1100)
 type_into('[aria-label="Codex terminal prompt"]','Build saved conversations');wait(200)
 browser('screenshot',str(out/f'sync-working-{width}.png'));wait(1900)
 type_into('[data-native-room=sync] textarea','@Codex keep keyboard navigation accessible');wait(1350)
 sync=evaluate('()=>beelineSync.state()');assert sync['joined'] and any('keyboard navigation' in t for t in sync['terminal']) and any('Claude Code:' in t for t in sync['terminal']),sync
 # The fixed welcome box and the scroll viewport must never intersect.
 bounds=evaluate('()=>{const a=document.querySelector(".codex-welcome").getBoundingClientRect(),b=document.querySelector(".tui-output").getBoundingClientRect();return {headerBottom:a.bottom,outputTop:b.top,model:document.querySelector(".codex-welcome").textContent.includes("model:"),overflow:document.documentElement.scrollWidth>innerWidth}}');assert bounds['headerBottom']<=bounds['outputTop'] and not bounds['model'] and not bounds['overflow'],bounds
 browser('screenshot',str(out/f'sync-{width}.png'))
 if width==1440:
  evaluate('()=>{document.activeElement.blur();document.querySelector("#hero").scrollIntoView({behavior:"instant"});beelineDemo.seek(26000);document.querySelector("#native-hero [aria-expanded]").focus();return true}');browser('press','Enter');wait(100)
  evaluate('()=>{[...document.querySelectorAll("#native-hero [role=button]")].find(e=>/(succeeded|running)$/.test(e.getAttribute("aria-label")||"")).focus();return true}');browser('press','Enter');wait(200)
  assert evaluate('()=>document.querySelector("dialog[open]").textContent.includes("2 tests passed")')
  browser('screenshot',str(out/'tool-output-1440.png'));browser('press','Escape')
 evaluate('()=>{document.activeElement.blur();document.querySelector("#context").scrollIntoView({behavior:"instant"});return true}');wait(2900);browser('screenshot',str(out/f'context-{width}.png'))
 proof.append({'viewport':[width,height],'hero':hero,'heroKeyboard':h,'sync':sync,'tuiBounds':bounds});(out/'proof.json').write_text(json.dumps(proof,indent=2)+'\n');print('PASS',width,'hero, literal text safety, local replies, two-way keyboard sync, TUI bounds',flush=True)
