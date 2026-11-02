from pathlib import Path
import json,os,subprocess
root=Path(__file__).resolve().parent
env=dict(os.environ,CHROME_DEVTOOLS_AXI_SESSION='beeline-r4-astra2')
def chrome(*args):
    result=subprocess.run(['chrome-devtools-axi',*args],env=env,text=True,capture_output=True,check=True)
    return result.stdout
scenes=[(1,0,'01-hero'),(2,0,'02-context-01-alan'),(2,1,'02-context-02-grok'),(2,2,'02-context'),(3,0,'03-bring-before'),(3,1,'03-bring'),(4,0,'04-story-01-alan'),(4,1,'04-story-02-grok'),(4,2,'04-story-03-jimmy'),(4,3,'04-story-04-alan'),(4,4,'04-story-05-codex'),(4,5,'04-story-06-claude'),(4,6,'04-brief'),(4,7,'04-agents'),(4,8,'04-video'),(5,0,'05-features')]
chrome('eval','location.reload()')
results=[]
for width,height in [(1440,900),(390,844)]:
    chrome('resize',str(width),str(height))
    for section,step,name in scenes:
        chrome('eval',f'window.setScene({section},{step})')
        raw=chrome('eval','''async () => {await document.fonts.ready;await new Promise(r=>setTimeout(r,260));const rect=e=>e.getBoundingClientRect();const overlap=(a,b)=>!(a.bottom<=b.top||a.top>=b.bottom||a.right<=b.left||a.left>=b.right);const active=document.querySelector('.node.active');return {...window.mockState(),activeNodes:document.querySelectorAll('.node.active').length,activeEdges:document.querySelectorAll('.edges .active').length,activeNodeOverlapsRoom:overlap(rect(active),rect(document.querySelector('.work-stage'))),joinOverlapsHarnesses:overlap(rect(document.querySelector('.join-room')),rect(document.querySelector('.harnesses'))),roomComponentCount:document.querySelectorAll('[data-real-components]').length,visibleText:document.querySelector('[data-section="'''+str(section)+'''"]').innerText};}''')
        line=next(x for x in raw.splitlines() if x.startswith('result: '))
        data=json.loads(json.loads(line[8:]))
        data.update(section=section,step=step,frame=f'frames/{name}-{width}.png')
        results.append(data)
        chrome('screenshot',str(root/data['frame']))
        print(f'Captured {name}-{width}; overflow={data["overflow"]}, node overlap={data["activeNodeOverlapsRoom"]}',flush=True)
(root/'validation.json').write_text(json.dumps(results,indent=2))
(root/'browser-console.txt').write_text(chrome('console'))
print('Done: 32 frames and validation.json',flush=True)
