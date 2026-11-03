"""Native keyboard proof: Room banter and Codex ↔ Room, no network API."""
import os,subprocess,json,re
from pathlib import Path
env=os.environ.copy();env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-r7-desktop'
def browser(*a):
 r=subprocess.run(['chrome-devtools-axi',*a],env=env,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def evaluate(script):
 raw=browser('eval',script,'--full');v=json.loads(next(l[8:] for l in raw.splitlines() if l.startswith('result: ')));return json.loads(v) if isinstance(v,str) else v
def wait(ms):return evaluate('async()=>{await new Promise(r=>setTimeout(r,'+str(ms)+'));return true}')
def fill(label,text,which=0):
 selector='textarea[aria-label="Message"]' if label=='Message' else 'input[aria-label="Codex terminal prompt"]'
 evaluate('()=>{const e=document.querySelectorAll('+json.dumps(selector)+')['+str(which)+'];e.focus();return document.activeElement===e;}')
 browser('type',text);browser('press','Enter')
out=Path('.scratch/round7');out.mkdir(exist_ok=True,parents=True)
browser('open','http://127.0.0.1:4388/mock/round7/?still=1&at=22500');browser('resize','1440','1000');evaluate('async()=>{await document.fonts.ready;return true}')
fill('Message','@Hermes can you make a video?',0);wait(1700);hero=evaluate('()=>{r7Demo.pause();return r7Demo.state()}');assert hero['visitorMessages']==1 and hero['localReplies']==2,hero
browser('screenshot',str(out/'banter-1440.png'))
evaluate('()=>{document.activeElement.blur();document.querySelector("#bring").scrollIntoView({behavior:"instant"});return true}');wait(800)
browser('screenshot',str(out/'sync-before-1440.png'))
fill('Codex terminal prompt','join my beeline room at usebeeline.app/mcp');wait(1100);joined=evaluate('()=>r7Sync.state()');assert joined['joined'] and any(h['who']=='claude' for h in joined['history']),joined
fill('Codex terminal prompt','Build saved conversations');wait(300);working=evaluate('()=>r7Sync.state()');assert working['active']==['codex'] and any('Build saved' in h['text'] for h in working['history']),working
browser('screenshot',str(out/'sync-working-1440.png'));wait(1900)
fill('Message','@Codex keep keyboard navigation accessible',1);wait(1500);state=evaluate('()=>r7Sync.state()');assert any('keyboard navigation' in t for t in state['terminal']),state
assert any('Jimmy:' in t for t in state['terminal']) and any('Claude Code:' in t for t in state['terminal']),state
assert any(h['who']=='codex' and 'terminal too' in h['text'] for h in state['history']),state
browser('screenshot',str(out/'sync-done-1440.png'))
# Tool output remains the app's real disclosure and sheet, not a static drawing.
evaluate('()=>{document.activeElement.blur();document.querySelector("#hero").scrollIntoView({behavior:"instant"});r7Demo.seek(21500);return true}');wait(500)
evaluate('()=>{const e=document.querySelector("[data-testid=hero-tool] [role=button]");e.focus();return true}')
browser('press','Enter');(out/'tool-expanded.txt').write_text(browser('snapshot'))
evaluate('()=>{const e=[...document.querySelectorAll("#native-hero [role=button]")].find(e=>/(running|succeeded|failed)$/.test(e.getAttribute("aria-label")||""));e.focus();return true}')
browser('press','Enter');wait(500)
snap=browser('snapshot');(out/'tool-output.txt').write_text(snap);assert '2 tests passed' in snap,snap
browser('screenshot',str(out/'tool-output-1440.png'))
(out/'interaction.json').write_text(json.dumps({'hero':hero,'joined':joined,'working':working,'synced':state,'nativeToolOutputSheet':True},indent=2)+'\n')
print('PASS native composer banter, exact join, TUI task → Room working, Room human/agent → TUI, native tool disclosure + output sheet')
