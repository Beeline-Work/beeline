"""DPR 2 ink measurement, adapted from PR #2847 kit/ink.py."""
from PIL import Image
import runpy
import json, pathlib
root=pathlib.Path(__file__).resolve().parent.parent
ink_pixels = runpy.run_path(str(root.parent / "room-list-icon-centre/kit/ink.py"))["ink"]
report={}
for side in ['before','after','after-room','after-corner','main-360','pr-360']:
 report[side]={}
 for p in (root/side).glob('*.json'):
  s=json.loads(p.read_text()); im=Image.open(p.with_suffix('.png')).convert('RGB')
  def ink(rect):
   return list(ink_pixels(im,rect))
  name=ink(s['name']);stop=ink(s['stop']);text=ink(s['text'])
  report[side][p.stem]={'textBox':[s['text']['l'],s['text']['r']],'textInk':text,'nameInk':name,'stopInk':stop,'nameLeftDelta':name[0]-text[0],'stopRightDelta':stop[1]-s['text']['r']}
(root/'measurements.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

for side, cases in report.items():
 if side.startswith('after') or side=='pr-360':
  for key,m in cases.items():
   assert abs(m['nameLeftDelta'])<=1,(side,key,m)
   assert abs(m['stopRightDelta'])<=1,(side,key,m)
