from PIL import Image, ImageDraw
from pathlib import Path
import json, sys
root=Path(__file__).resolve().parent.parent
sides=sys.argv[1:3] or ['before','after']
suffix='-360' if sides[0]=='main-360' else ''
for name in ['phone-light','phone-dark','desktop-light','desktop-dark']:
 panels=[]
 for side in sides:
  im=Image.open(root/side/(name+'.png')).convert('RGB')
  s=json.loads((root/side/(name+'.json')).read_text())
  # Keep the full transcript/composer width; crop out unrelated desktop sidebar.
  left=0 if name.startswith('phone') else 340
  top=max(0,int(s['text']['t'])-90)
  crop=im.crop((left*2,top*2,im.width,min(im.height,int(s['row']['b']+70)*2)))
  draw=ImageDraw.Draw(crop)
  for x in [s['text']['l'],s['text']['r']]:
   draw.line(((x-left)*2,0,(x-left)*2,crop.height),fill=(200,40,70),width=1)
  panel=Image.new('RGB',(crop.width,crop.height+40),'white');panel.paste(crop,(0,40));ImageDraw.Draw(panel).text((10,10),f'{side} | {name} | red: transcript column edges',fill='black');panels.append(panel)
 out=Image.new('RGB',(panels[0].width+panels[1].width+12,max(p.height for p in panels)),'white');out.paste(panels[0],(0,0));out.paste(panels[1],(panels[0].width+12,0));out.save(root/(name+suffix+'-comparison.png'))
