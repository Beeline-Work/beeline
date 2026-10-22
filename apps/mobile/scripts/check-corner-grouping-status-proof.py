import subprocess,json
from pathlib import Path
out=Path('apps/mobile/evidence/corner-grouping-status')
env=__import__('os').environ.copy();env['CHROME_DEVTOOLS_AXI_SESSION']='jellybean-grouping'
def cli(*args):return subprocess.check_output(['chrome-devtools-axi',*args],env=env,text=True)
def js(code):
 raw=cli('eval','() => {'+code+'}')
 # CLI's result is a JSON string containing the serialized return value.
 line=next(l for l in raw.splitlines() if l.startswith('result: '))
 value=json.loads(line[8:]);return json.loads(value) if isinstance(value,str) else value
def openpage(theme,state,count=3):cli('open',f'http://127.0.0.1:19248/?theme={theme}&state={state}&count={count}')
def shot(name):cli('screenshot',str(out.resolve()/(name+'.png')))
receipts=[]
for width in [412,1280]:
 cli('resize',str(width),'892')
 for theme in ['bone','obsidian']:
  for state in ['idle','settled','working']:
   openpage(theme,state)
   receipt=js('''const s=document.querySelector('[data-testid="hanging-turn-chrome"]'), c=document.querySelector('[data-testid="composer"]'), t=document.querySelector('[data-testid="transcript"]'),css=getComputedStyle(s);return {slot:s.getBoundingClientRect().toJSON(),composer:c.getBoundingClientRect().toJSON(),transcript:t.getBoundingClientRect().toJSON(),background:css.backgroundColor,padding:css.padding,transform:css.transform};''')
   receipt.update(width=width,theme=theme,state=state);receipts.append(receipt)
   assert (receipt['background']!='rgba(0, 0, 0, 0)')==(state=='working'),receipt
   assert (receipt['padding']!='0px')==(state=='working'),receipt
   if width==412:shot('web-'+state+'-'+theme)
  if width==412:
   shot('web-three-collapsed-'+theme)
   assert js("const e=document.querySelector('[data-testid=notification-run-expand-source]');e.click();return e.textContent;")=='3 corners opened'
   assert js("return document.querySelectorAll('[data-testid^=corner-opened-marker-]').length;")==3
   shot('web-three-expanded-'+theme)
   assert js("document.querySelector('[data-testid=corner-opened-marker-corner-2]').click();return document.querySelector('#result').textContent;")=='corner-2'
   openpage(theme,'idle',1)
   assert js("return document.querySelectorAll('[data-testid=notification-run-expand-source]').length;")==0
   shot('web-single-'+theme)
  else:
   js("document.querySelector('[data-testid=notification-run-expand-source]').click();return true;")
   shot('web-desktop-three-expanded-'+theme)
for theme in ['bone','obsidian']:
 openpage(theme,'idle',4)
 js("document.querySelector('[data-testid=notification-run-expand-source]').click();return true;")
 assert js("return document.querySelectorAll('[data-testid^=corner-opened-marker-]').length;")==2
 js("document.querySelector('[data-testid=notification-run-more-source]').click();return true;")
 assert js("return document.querySelectorAll('[data-testid^=corner-opened-marker-]').length;")==4
for width in [412,1280]:
 for theme in ['bone','obsidian']:
  subset=[r for r in receipts if r['width']==width and r['theme']==theme]
  assert len({(r['composer']['y'],r['composer']['height'],r['transcript']['height']) for r in subset})==1
out.joinpath('web-layouts.json').write_text(json.dumps(receipts,indent=2)+'\n')
print('PASS: phone and desktop; both themes; idle/settled transparent, thinking covered; fixed composer/list bounds; single, three and four corners, expanded navigation and more.')
