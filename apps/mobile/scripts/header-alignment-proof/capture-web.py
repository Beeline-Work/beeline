import subprocess, os, json
from pathlib import Path
out = Path('apps/mobile/evidence/header-alignment')
out.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, CHROME_DEVTOOLS_AXI_SESSION='jellybean-header')
def cli(*args, script=None):
    return subprocess.run(['chrome-devtools-axi', *args], input=script, text=True, capture_output=True, check=True, env=env).stdout
measure = '''() => {
  const ids = ['workspace-members','workspace-tray','tray-icon-landmark','tray-needs-you-count','room-search-toggle','rooms-add','corners-add'];
  const boxes = Object.fromEntries(ids.map(id => { const e=document.querySelector('[data-testid="'+id+'"]'); if(!e)return [id,null]; const r=e.getBoundingClientRect(); return [id,{x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2}]; }));
  const heading=document.querySelector('[data-testid="rooms-heading"]');
  const count=heading.nextElementSibling;
  return {viewport:innerWidth,boxes,heading:getComputedStyle(heading).fontSize,count:getComputedStyle(count).fontSize,sectionHeight:heading.parentElement.getBoundingClientRect().height};
}'''
results=[]
cli('open','http://127.0.0.1:19327/after/?theme=bone')
for device,width in [('phone',390),('desktop',1280)]:
    cli('resize',str(width),'844')
    for phase in ['before','after']:
        for theme in ['bone','obsidian']:
            cli('open',f'http://127.0.0.1:19327/{phase}/?theme={theme}')
            data=json.loads(cli('run',script='console.log(JSON.stringify(await page.eval('+measure+')));'))
            data.update(device=device,phase=phase,theme=theme)
            if phase=='after' and device=='phone':
                boxes=data['boxes']; expected=width-38
                assert abs(boxes['workspace-tray']['cx']-boxes['workspace-members']['cx']-44)<1,data
                for key in ['workspace-tray','room-search-toggle','rooms-add','corners-add']:
                    assert abs(boxes[key]['cx']-expected)<1,data
                assert data['heading']=='13px' and data['count']=='15px',data
                assert data['sectionHeight']<=44,data
            results.append(data)
            cli('screenshot',str(out/f'{device}-{phase}-{theme}.png'))
            if phase=='after':
                for label,selector in [('tray','[data-testid=workspace-tray]'),('settings','[aria-label=Settings]')]:
                    cli('run',script='await page.eval(() => document.querySelector('+json.dumps(selector)+').click()); console.log(await page.snapshot());')
                    cli('screenshot',str(out/f'{device}-{label}-{theme}.png'))
                    cli('run',script='await page.eval(() => document.querySelector("[aria-label=Rooms]").click());')
(out/'web-measurements.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS: phone centre line, 44-point target separation, section typography and height; before/after plus shared-header screens captured in both themes.')
