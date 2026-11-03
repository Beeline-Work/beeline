"""Export the approved shared component render to dependency-free HTML templates.
Serve web/ on 4388, rebuild round7's native bundle, then run this command.
Browser operations go through chrome-devtools-axi; no production service is used.
"""
import os,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2];env=os.environ.copy();env['CHROME_DEVTOOLS_AXI_SESSION']='beeline-r7-loop-fixed'
def browser(*a):
 r=subprocess.run(['chrome-devtools-axi',*a],env=env,capture_output=True,text=True,check=True);return r.stdout
def evaluate(script):
 v=json.loads(next(l[8:] for l in browser('eval',script,'--full').splitlines() if l.startswith('result: ')));return json.loads(v) if isinstance(v,str) else v
browser('open','http://127.0.0.1:4388/mock/round7/?still=1&at=42900');browser('resize','1440','1000')
evaluate('async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,800));return true}')
ui=evaluate((root/'scripts/marketing/export-ui.js').read_text())
evaluate('async()=>{r7Send("A local visitor message");await new Promise(r=>setTimeout(r,200));return true}')
extra=evaluate((root/'scripts/marketing/export-ui.js').read_text());ui['generic']['you']=extra['generic']['you']
ui.pop('body');(root/'web/marketing/native.css').write_text(ui.pop('css')+'\n')
(root/'web/marketing/ui.json').write_text(json.dumps(ui,separators=(',',':'))+'\n')
print('Exported shared component HTML, no React runtime:',(root/'web/marketing/ui.json').stat().st_size,'bytes')
# Native tool disclosure/output, captured through real keyboard activation.
browser('open','http://127.0.0.1:4388/mock/round7/?still=1&at=42900')
evaluate('async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,400));document.querySelector("#native-hero [data-testid=hero-tool] [role=button]").focus();return true}')
browser('press','Enter')
ui['toolExpanded']=evaluate('()=>document.querySelector("#native-hero [data-testid=hero-tool]").outerHTML')
evaluate('()=>{[...document.querySelectorAll("#native-hero [role=button]")].find(e=>/(succeeded|running)$/.test(e.getAttribute("aria-label")||"")).focus();return true}')
browser('press','Enter')
ui['toolSheet']=evaluate('''()=>{const copy=[...document.querySelectorAll('[role=button]')].find(e=>e.textContent==='Copy output');let e=copy;while(e){const s=getComputedStyle(e),b=e.getBoundingClientRect();if(b.width>150&&b.height>80&&s.backgroundColor!=='rgba(0, 0, 0, 0)')return {html:e.innerHTML,style:e.getAttribute('style'),className:e.className};e=e.parentElement;}throw Error('Native output sheet not found');}''')
(root/'web/marketing/ui.json').write_text(json.dumps(ui,separators=(',',':'))+'\n')
print('Exported native tool disclosure and output sheet')

(root/'web/marketing/native.css').write_text(evaluate("()=>[...document.querySelector('#react-native-stylesheet').sheet.cssRules].map(r=>r.cssText).join('\\n')")+'\n')
