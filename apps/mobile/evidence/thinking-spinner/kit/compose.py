from PIL import Image,ImageDraw
from pathlib import Path
root=Path(__file__).resolve().parent.parent
for surface in ['phone','desktop']:
 for theme in ['light','dark']:
  parts=[]
  for side in ['before','after']:
   im=Image.open(root/side/f'{surface}-{theme}.png'); w,h=im.size
   # Keep the transcript bottom, thinking status and composer in the comparison.
   crop=im.crop((680 if surface=='desktop' else 0,h-420,w,h))
   parts.append(crop)
  out=Image.new('RGB',(parts[0].width*2,450),'#ece4d5' if theme=='light' else '#14091a');d=ImageDraw.Draw(out)
  for i,p in enumerate(parts):
   out.paste(p,(i*p.width,30));d.text((i*p.width+12,8),['Current main','Spinner first'][i],fill='#171310' if theme=='light' else '#f0f0f3')
  out.save(root/f'{surface}-{theme}-comparison.png')
