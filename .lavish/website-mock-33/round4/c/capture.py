from pathlib import Path
import subprocess, os, json, time
root=Path(__file__).resolve().parent
env=dict(os.environ, CHROME_DEVTOOLS_AXI_SESSION='beeline-r4-astra-1')
def browser(*args):
 p=subprocess.run(['chrome-devtools-axi',*map(str,args)],env=env,capture_output=True,text=True,check=True)
 return p.stdout
frames=[(1,0,'01-hero'),(2,0,'02-context-01-alan'),(2,1,'02-context-02-grok'),(2,2,'02-context'),(3,0,'03-bring'),(3,1,'03-bring-02-arrival')]+[(4,i,'04-together-'+str(i+1).zfill(2)+'-'+name) for i,name in enumerate(['ask','research','decide','direct','build','fix','brief','connect','report'])]+[(5,0,'05-features')]
browser('open',(root/'index.html').as_uri())
checks=[]
for width,height in [(1440,900),(390,844)]:
 browser('resize',width,height)
 for section,beat,name in frames:
  browser('eval',f'async () => {{window.setFrame({section},{beat}); await document.fonts.ready; await new Promise(r=>setTimeout(r,400)); return window.mockState();}}')
  browser('screenshot',root/'frames'/f'{name}-{width}.png')
  result=browser('eval',f'() => {{const e=document.querySelector("#section-{section}");return {{state:window.mockState(),width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,sectionHeight:e.clientHeight,sectionScroll:e.scrollHeight,footBottom:e.querySelector(".chapter-foot").getBoundingClientRect().bottom,litNodes:document.querySelectorAll(".network-node.lit").length,litEdges:document.querySelectorAll(".network>svg path.lit").length,roomBottom:e.querySelector(".work-output .room")?.getBoundingClientRect().bottom??null,controlsTop:e.querySelector(":scope>.controls")?.getBoundingClientRect().top??null,visibleMessages:e.querySelectorAll("[data-testid=focused-message]").length}};}}')
  line=next(x for x in result.splitlines() if x.startswith('result: '))
  value=json.loads(line[len('result: '):]); value=json.loads(value) if isinstance(value,str) else value
  checks.append(dict(frame=f'{name}-{width}.png',**value))
  print(f'{width}: {name}; overflow={value["sectionScroll"]-value["sectionHeight"]}',flush=True)
(root/'validation.json').write_text(json.dumps(checks,indent=2)+'\n')
(root/'console.txt').write_text(browser('console'))
(root/'network.txt').write_text(browser('network'))
print('Console and network evidence saved.')
