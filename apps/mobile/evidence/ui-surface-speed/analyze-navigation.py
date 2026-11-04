import os,pathlib,json,re,csv,collections,math,sys
root=pathlib.Path(os.environ['UI_SURFACE_PROOF_ROOT'])
def q(xs,p):
 return round(sorted(xs)[max(0,math.ceil(p*len(xs))-1)],2) if xs else None
surfaces={'tray':'TrayScreen','members':'BuzzMembers','corners':'RoomCornersList','list':'BuzzChannels','room':'RootLayout','foreground':'RootLayout'}
prefix={'tray':'/beeline/tray','members':'/beeline/members','corners':'/beeline/corners/','list':'/beeline/channels','room':'/beeline/chat/'}
def parse(arm):
 samples=[];folder=root/arm/'captures'
 for f in sorted(folder.glob('*.meta.json')):
  name=f.name.split('-')[0];index=int(f.name.split('-')[1].split('.')[0]);
  if index<10:continue
  stem=str(f).removesuffix('.meta.json');log=pathlib.Path(stem+'.log')
  if not log.exists() or not pathlib.Path(stem+'.gfx').exists():continue
  meta=json.loads(f.read_text());start=meta['shellStartMs'];rows=[];events=[];bad=0
  for line in log.read_text().splitlines():
   try:
    if '[UI_SURFACES] 'in line:rows.extend(json.loads(line.split('[UI_SURFACES] ')[1])['rows'])
    elif '[LATENCY_FRAME] 'in line:events.append(json.loads(line.split('[LATENCY_FRAME] ')[1]))
   except json.JSONDecodeError:bad+=1
  rows=[r for r in rows if r.get('t',r.get('commitTime',0))>=start]
  frames=[];header=None
  for line in pathlib.Path(stem+'.gfx').read_text().splitlines():
   if line.startswith('Flags,'):header=line.rstrip(',').split(',')
   elif header and re.match(r'^\d+,',line):
    values=line.rstrip(',').split(',');frame=dict(zip(header,map(int,values)))
    if frame.get('Flags')==0 and frame.get('DrawStart',0)<=frame.get('FrameCompleted',0)<10**18:frames.append(frame)
  ready=next((e['t']for e in events if e.get('phase')=='meaningful-frame' and e.get('t',0)>=start and e.get('route','').startswith(prefix.get(name,'__none'))),None)
  if name=='foreground':ready=start
  native=next((x['FrameCompleted']/1e6 for x in sorted(frames,key=lambda f:f['FrameCompleted']) if ready is not None and x['DrawStart']/1e6>=ready),None)
  rootCommits=[r['actualDuration']for r in rows if r.get('id')=='RootLayout'];surfaceCommits=[r['actualDuration']for r in rows if r.get('id')==surfaces[name]]
  bodies=dict(collections.Counter(r['body']for r in rows if 'body'in r));visual=meta.get('visual');visibleUpper=None
  if visual and visual['matched']:visibleUpper=visual['checks'][-1]['afterMs']-start
  samples.append({'arm':arm,'case':name,'sample':index,'startMs':start,'rootRenderTotalMs':sum(rootCommits),'rootMaxCommitRenderMs':max(rootCommits,default=0),'surfaceRenderTotalMs':sum(surfaceCommits),'surfaceMaxCommitRenderMs':max(surfaceCommits,default=0),'surfaceCommitCount':len(surfaceCommits),'bodyRenders':bodies,'jsTouchMs':next((e['t']for e in events if e.get('kind')=='tap'and e.get('phase')=='start'and e['t']>=start),None),'meaningfulFrameCandidateMs':None if ready is None else ready-start,'nextNativeFrameBoundMs':None if native is None else native-start,'tapToNativeFrameProxyMs':None if native is None else native-next((e['t']for e in events if e.get('kind')=='tap'and e.get('phase')=='start'and e['t']>=start),start),'visibleTextUpperMs':visibleUpper,'visualProbe':visual,'badLogLines':bad,'hostLoad':meta['hostLoad']})
 return samples
allSamples=[];summary={}
for arm in sys.argv[1:]:
 values=parse(arm);allSamples+=values;summary[arm]={}
 for case in surfaces:
  selected=[v for v in values if v['case']==case];metrics={}
  for key in ['rootRenderTotalMs','rootMaxCommitRenderMs','surfaceRenderTotalMs','surfaceMaxCommitRenderMs','surfaceCommitCount','meaningfulFrameCandidateMs','nextNativeFrameBoundMs','tapToNativeFrameProxyMs','visibleTextUpperMs']:
   xs=[x[key]for x in selected if x[key]is not None];metrics[key]={'n':len(xs),'p50':q(xs,.5),'p95':q(xs,.95)}
  metrics['bodyRenders']={key:{'p50':q([v['bodyRenders'].get(key,0)for v in selected],.5),'p95':q([v['bodyRenders'].get(key,0)for v in selected],.95)}for key in ['ConversationRow','MemberRosterRow','NeedsYouCell','RoomCornersList','TurnProgressLine']}
  metrics['n']=len(selected);summary[arm][case]=metrics
(root/'measurements.json').write_text(json.dumps({'samples':allSamples,'summary':summary},indent=2))
for arm,cases in summary.items():
 for case,m in cases.items():print(arm,case,m['n'],'root peak',m['rootMaxCommitRenderMs'],'row renders',m['bodyRenders']['ConversationRow'],'native candidate',m['nextNativeFrameBoundMs'],'visible bound',m['visibleTextUpperMs'])
