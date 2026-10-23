import subprocess,json,os,time
from pathlib import Path
out=Path('.corner-artifacts/headers-proof/shots');out.mkdir(parents=True,exist_ok=True)
env=os.environ.copy();env['CHROME_DEVTOOLS_AXI_SESSION']='niglet-fa3'
def cli(*a):return subprocess.check_output(['chrome-devtools-axi',*a],env=env,text=True)
def js(code):
 raw=cli('eval','() => {'+code+'}');line=next(l for l in raw.splitlines() if l.startswith('result: '))
 v=json.loads(line[8:]);return json.loads(v) if isinstance(v,str) else v
receipts=[]
cli('resize','412','892')
for side,port,counted in [('before',19261,'1'),('after',19262,'0')]:
 for theme in ['bone','obsidian']:
  cli('open',f'http://127.0.0.1:{port}/?theme={theme}&view=headers&counted={counted}');time.sleep(1.2)
  r=js('''const h=[...document.querySelectorAll('[role=heading]')];return h.map(e=>{const row=e.parentElement,cs=getComputedStyle(e);return {text:e.textContent,fontSize:cs.fontSize,rowText:row.innerText,rowHeight:row.getBoundingClientRect().height,svg:!!row.querySelector('svg'),stroke:row.querySelector('path')?.getAttribute('stroke-width')??row.querySelector('svg')?.getAttribute('stroke-width')}})''')
  receipts.append(dict(side=side,theme=theme,view='headers',headers=r));cli('screenshot',str((out/f'headers-{side}-{theme}.png').resolve()))
  for state in ['working','settled','idle']:
   cli('open',f'http://127.0.0.1:{port}/?theme={theme}&state={state}');time.sleep(1.2)
   r=js('''const s=document.querySelector('[data-testid="hanging-turn-chrome"]'),cs=getComputedStyle(s);return {slot:s.getBoundingClientRect().toJSON(),background:cs.backgroundColor,padding:cs.padding,text:s.innerText}''')
   receipts.append(dict(side=side,theme=theme,state=state,**r));cli('screenshot',str((out/f'turn-{side}-{state}-{theme}.png').resolve()))
(out/'receipts.json').write_text(json.dumps(receipts,indent=1))
for r in receipts:print(json.dumps(r))
