import json,time
from phone_fixture import Fixture,P,api,adb
from native_ui import wait_room,type_text,tap,capture,clear_draft
rooms=json.loads((P/'head3a-functional-rooms.json').read_text());source=rooms['empty'];target=rooms['navigate'];primary=json.loads((P/'room.json').read_text());f=Fixture('head3a-functional');report={'sourceHead':'3a77888f6b99465e9156efc237cfab7d5a5167e4','scenarios':[]}
def saved(): (f.out/'results.json').write_text(json.dumps(report,indent=2))
def read(room):
 view=api('/v1/phone/rooms/'+room['roomId']);assert view['room']['workspaceId']==room['workspaceId'];assert all(m['identity']['kind']!='agent'for m in view['members']);return view
try:
 report['bundleSha256']=f.install(next((P/'head3a-export/_expo/static/js/android').glob('*.hbc')),'functional-current',report['sourceHead']);assert not read(source)['messages'];assert not read(target)['messages'];f.open(source);wait_room('latency-empty');f.screenshot('empty-before');clear_draft();type_text('emptyproofGamma');pressed=capture(f.out,'empty-send',lambda:tap());f.screenshot('empty-after');view=read(source);seen=[m for m in view['messages']if m['text']=='emptyproofGamma'];assert len(seen)==1;report['scenarios'].append({'name':'empty Room send and canonical handoff','token':'emptyproofGamma','tap':pressed,'canonicalIds':[m['id']for m in seen],'passed':True});saved();print('Empty Room send delivered exactly once',flush=True)
 type_text('doubleproofGamma');pressed=capture(f.out,'double-tap',lambda:tap(count=2));f.screenshot('double-after');view=read(source);seen=[m for m in view['messages']if m['text']=='doubleproofGamma'];assert len(seen)==1;report['scenarios'].append({'name':'double tap','token':'doubleproofGamma','tap':pressed,'canonicalIds':[m['id']for m in seen],'passed':True});saved();print('Double tap delivered exactly once',flush=True)
 type_text('navproofGamma')
 def navigate():
  pressed=tap();start=adb('shell','cat /proc/uptime').strip();f.open(target);end=adb('shell','cat /proc/uptime').strip();wait_room('latency-navigate');return{'send':pressed,'navigateBeforeElapsedNs':round(float(start.split()[0])*1e9),'navigateAfterElapsedNs':round(float(end.split()[0])*1e9)}
 timing=capture(f.out,'navigate-first-paint',navigate);wait_room('latency-navigate');f.screenshot('navigate-after');old=read(source);new=read(target);seen=[m for m in old['messages']if m['text']=='navproofGamma'];assert len(seen)==1 and not new['messages'];report['scenarios'].append({'name':'navigate away during first paint','token':'navproofGamma','timing':timing,'sourceCanonicalIds':[m['id']for m in seen],'targetMessages':0,'passed':True});saved();print('Navigation delivered only to source; target Room remains empty',flush=True)
finally:f.restore(primary)
