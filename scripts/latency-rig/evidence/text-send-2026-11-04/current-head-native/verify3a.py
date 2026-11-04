from pathlib import Path
import json,urllib.request,urllib.parse,sys
from collections import Counter
p=Path('.beeline-proof/send-latency');room=json.loads((p/'room.json').read_text());unused=None
sys.path.insert(0,str(p));from phone_fixture import api
def read(path):return api(path)
view=read('/v1/phone/rooms/'+room['roomId']);assert view['room']['workspaceId']==room['workspaceId']and view['room']['id']==room['roomId']
expected={s['token']for group in json.loads((p/'head3a-paired/results.json').read_text()).values()for s in group['samples']};records={m['id']:m for m in view['messages']};seen={m['text']:m['id']for m in records.values()};cursor=None;pages=0
while not expected.issubset(seen)and pages<4:
 query='?'+urllib.parse.urlencode({'before':str(cursor['createdAt'])+','+cursor['id']})if cursor else''
 history=read('/v1/phone/rooms/'+room['roomId']+'/history'+query);assert history['roomId']==room['roomId'];records.update({m['id']:m for m in history['messages']});seen={m['text']:m['id']for m in records.values()};cursor=history.get('nextBefore');pages+=1
 if not cursor:break
counts=Counter(m['text'] for m in records.values());assert all(counts[t]==1 for t in expected),{t:counts[t] for t in expected if counts[t]!=1}
result={'exactlyOnce':True,'roomId':room['roomId'],'workspaceId':room['workspaceId'],'expected':len(expected),'canonicalTextsFound':len(expected.intersection(seen)),'historyPages':pages,'complete':expected.issubset(seen),'matched':[{'token':t,'messageId':seen[t]}for t in sorted(expected)if t in seen]};(p/'head3a-paired/canonical.json').write_text(json.dumps(result,indent=2));print({k:v for k,v in result.items()if k!='matched'});assert result['complete'],'Canonical receipt mismatch'
