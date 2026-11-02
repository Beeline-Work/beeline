from pathlib import Path
import subprocess,os,json
root=Path(__file__).resolve().parent
env=dict(os.environ,CHROME_DEVTOOLS_AXI_SESSION='beeline-r4-astra-1')
def run(*args):return subprocess.run(['chrome-devtools-axi',*args],env=env,text=True,capture_output=True,check=True).stdout
def evaluate(js):
 out=run('eval',js)
 line=next(s for s in out.splitlines() if s.startswith('result: '))
 value=json.loads(line[8:]);return json.loads(value) if isinstance(value,str) and value.startswith(('{','[')) else value
checks=[]
for section,start,key,expected in [(2,0,'context',1),(2,2,'context',0),(3,0,'join',1),(3,1,'join',0),(4,7,'work',8),(4,8,'work',0)]:
 evaluate(f'async () => {{window.setFrame({section},{start}); await new Promise(r=>setTimeout(r,250)); document.querySelector("#section-{section} button[aria-label=\\"Next story step\\"]").focus(); return true;}}')
 run('press','Enter')
 state=evaluate('async () => {await new Promise(r=>setTimeout(r,100));return window.mockState();}')
 assert state[key]==expected,(key,state)
 checks.append({'action':'keyboard Enter on Next/Replay','section':section,'before':start,'after':state[key],'passed':True})
res=evaluate('() => {document.querySelector(".downloads button").click();return {toast:document.querySelector(".toast")?.textContent??null};}')
res=evaluate('async () => {await new Promise(r=>setTimeout(r,50));return {toast:document.querySelector(".toast")?.textContent??null,forbiddenCopy:/corners/i.test(document.body.innerText),remoteResources:performance.getEntriesByType("resource").map(r=>r.name).filter(n=>/^https?:/.test(n))};}')
assert res['toast'].startswith('Android download'),res
assert not res['forbiddenCopy'],res
assert not res['remoteResources'],res
assert '@media(prefers-reduced-motion:reduce)' in (root/'style.css').read_text()
res['reducedMotionRulePresent']=True
checks.append({'action':'download preview, copy, offline, reduced motion','result':res,'passed':True})
evaluate('async () => {document.querySelector(".toast button").click();window.setFrame(1,0);await new Promise(r=>setTimeout(r,250));return true;}')
(root/'interaction-checks.json').write_text(json.dumps(checks,indent=2)+'\n')
print(json.dumps(checks,indent=2))
