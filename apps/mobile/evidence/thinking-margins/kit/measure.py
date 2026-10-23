"""DPR 2 ink measurement, adapted from PR #2847 kit/ink.py."""
from PIL import Image
from collections import Counter
import json, pathlib
root=pathlib.Path(__file__).resolve().parent.parent
report={}
for side in ['before','after','after-room','after-corner']:
 report[side]={}
 for p in (root/side).glob('*.json'):
  s=json.loads(p.read_text()); im=Image.open(p.with_suffix('.png')).convert('RGB')
  def ink(rect):
   l,t,r,b=[int(rect[k]*2) for k in ['l','t','r','b']]
   crop=im.crop((l,t,r,b)); bg=Counter(crop.getdata()).most_common(1)[0][0]
   xs=[x for x in range(crop.width) for y in range(crop.height) if sum(abs(a-b) for a,b in zip(crop.getpixel((x,y)),bg))>60]
   return [(l+min(xs))/2,(l+max(xs)+1)/2]
  name=ink(s['name']);stop=ink(s['stop']);text=ink(s['text'])
  report[side][p.stem]={'textBox':[s['text']['l'],s['text']['r']],'textInk':text,'nameInk':name,'stopInk':stop,'nameLeftDelta':name[0]-text[0],'stopRightDelta':stop[1]-s['text']['r']}
(root/'measurements.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

for side, cases in report.items():
 if side.startswith('after'):
  for key,m in cases.items():
   assert abs(m['nameLeftDelta'])<=1,(side,key,m)
   assert abs(m['stopRightDelta'])<=1,(side,key,m)
