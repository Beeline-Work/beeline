"""Measure actual screenshot ink at DPR 2 using the existing proof kit."""
from PIL import Image
import runpy,json,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
ink=runpy.run_path(str(root.parent/'room-list-icon-centre/kit/ink.py'))['ink']
report={}
for folder in ['before','after','after-room','after-corner']:
 report[folder]={}
 for p in (root/folder).glob('*.json'):
  s=json.loads(p.read_text()); im=Image.open(p.with_suffix('.png'))
  mark=ink(im,s['svg']); stop=ink(im,s['stop'])
  report[folder][p.stem]={'markInk':mark,'stopInk':stop,'textEdges':[s['text']['l'],s['text']['r']],'markLeftDelta':mark[0]-s['text']['l'],'stopRightDelta':stop[1]-s['text']['r'],'nameBoxLeft':s['name']['l']}
  if folder.startswith('after'):
   assert abs(mark[0]-s['text']['l'])<=1,(folder,p.stem,'mark',mark)
   assert abs(stop[1]-s['text']['r'])<=1,(folder,p.stem,'stop',stop)
   assert abs(s['name']['l']-s['glyph']['r']-8)<=.02
for folder,cases in report.items():
 assert len(cases)==4,(folder,'Expected all four viewport/theme captures',len(cases))
(root/'measurements.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
