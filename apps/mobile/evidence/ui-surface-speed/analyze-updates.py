import os,pathlib,json,re,math,collections,sys
root=pathlib.Path(os.environ['UI_SURFACE_PROOF_ROOT']);room='392e6046-9224-4fce-8224-72a734fd4abe'
def q(xs,p):return round(sorted(xs)[max(0,math.ceil(p*len(xs))-1)],3)if xs else None
def logs(path):
 rows=[];events=collections.defaultdict(list)
 for line in path.read_text().splitlines():
  try:
   if '[UI_SURFACES] 'in line:rows.extend(json.loads(line.split('[UI_SURFACES] ')[1])['rows'])
   else:
    for tag in ['UI_ARRIVAL','UI_SENT','UI_BOOKMARK_ARRIVAL','UI_BOOKMARK','UI_COUNTER']:
     if '['+tag+'] 'in line:events[tag].append(json.loads(line.split('['+tag+'] ')[1]))
  except json.JSONDecodeError:pass
 return rows,events
def frames(paths):
 values={}
 for path in paths:
  header=None
  for line in path.read_text().splitlines():
   if line.startswith('Flags,'):header=line.rstrip(',').split(',')
   elif header and re.match(r'^\d+,',line):
    f=dict(zip(header,map(int,line.rstrip(',').split(','))))
    if f.get('Flags')==0 and f.get('DrawStart',0)<=f.get('FrameCompleted',0)<10**18:values[f['IntendedVsync']]=f
 return sorted(values.values(),key=lambda x:x['DrawStart'])
def stats(samples):
 return {key:{'n':len(xs),'p50':q(xs,.5),'p95':q(xs,.95)}for key in ['renderMs','rootPeakCommitRenderMs','rowRenders','unchangedRowRenders','cellRenders','rootCommits','effectMs','nativeFrameProxyMs']if (xs:=[s[key]for s in samples if s.get(key)is not None])}
def update(arm,name,kind):
 folder=root/arm;rows,events=logs(folder/(name+'.log'));fs=frames(folder.glob(name+'*.gfx'));samples=[]
 triggers=events['UI_ARRIVAL'if kind=='arrival'else 'UI_BOOKMARK_ARRIVAL']
 expected={e['messageId']for e in events['UI_SENT']}if kind=='arrival'else None
 triggers=[e for e in triggers if e.get('type','message-delta')=='message-delta' and(expected is None or e.get('messageId')in expected)]
 for i,event in enumerate(triggers):
  t=event['t'];end=triggers[i+1]['t']if i+1<len(triggers)else t+1000
  bodies=[r for r in rows if 'body'in r and t<=r['t']<end]
  target=next((r for r in bodies if r['body']==('ConversationRow'if kind=='arrival'else 'TrayScreen')and(kind!='arrival'or(r.get('roomId')==room and r.get('messageId')==event['messageId']))),None)
  roots=[r for r in rows if r.get('id')=='RootLayout'and t<=r['commitTime']<end]
  frame=next((f for f in fs if target and f['DrawStart']/1e6>=target['t']),None)
  samples.append({'arm':arm,'kind':kind,'sample':i,'event':event,'renderMs':sum(r['actualDuration']for r in roots),'rootPeakCommitRenderMs':max((r['actualDuration']for r in roots),default=0),'rootCommits':len(roots),'unchangedRowRenders':sum(r['body']=='ConversationRow'and r.get('roomId')!=room for r in bodies),'rowRenders':sum(r['body']=='ConversationRow'for r in bodies),'cellRenders':sum(r['body']=='NeedsYouCell'for r in bodies),'effectMs':target['t']-t if target else None,'nativeFrameProxyMs':frame['FrameCompleted']/1e6-t if frame else None,'effect':target,'frame':frame})
 return {'samples':samples,'summary':stats(samples)}
def clock(arm):
 folder=root/arm;meta=json.loads((folder/'clock.meta.json').read_text());rows,events=logs(folder/'clock.log');fs=frames(folder.glob('clock-*.gfx'));start=meta['startMs'];end=meta['endMs'];rows=[r for r in rows if start<=r.get('t',r.get('commitTime',0))<end];samples=[]
 for e in events['UI_COUNTER']:
  if not start<=e['t']<end:continue
  commit=max((r for r in rows if r.get('id')=='ClockScene'and r['commitTime']<=e['t']),key=lambda r:r['commitTime'],default=None)
  frame=next((f for f in fs if f['DrawStart']/1e6>=e['t']),None)
  samples.append({'arm':arm,'kind':'clock','event':e,'renderMs':commit['actualDuration']if commit else None,'nativeFrameProxyMs':frame['FrameCompleted']/1e6-e['t']if frame else None,'frame':frame})
 bodies=dict(collections.Counter(r['body']for r in rows if 'body'in r));commits=[r['actualDuration']for r in rows if r.get('id')=='ClockScene']
 return {'samples':samples,'summary':stats(samples),'durationMs':end-start,'bodyCounts':bodies,'rootCommitRenderMs':{'n':len(commits),'p50':q(commits,.5),'p95':q(commits,.95)},'hostLoad':meta['hostLoad']}
result={}
for arm in ['before-final','after-final']:
 suffix='before'if arm=='before-final'else 'after';result[arm]={}
 for kind in ['arrival','bookmark']:
  name=kind+'-final-'+suffix
  if(root/arm/(name+'.log')).exists():result[arm][kind]=update(arm,name,kind)
for arm in ['clock-before','clock-after']:
 if(root/arm/'clock.meta.json').exists():result[arm]=clock(arm)
(root/'update-measurements.json').write_text(json.dumps(result,indent=2))
for arm,value in result.items():
 if arm.startswith('clock'):print(arm,value['bodyCounts'],value['summary'])
 else:
  for case,v in value.items():print(arm,case,v['summary'])
