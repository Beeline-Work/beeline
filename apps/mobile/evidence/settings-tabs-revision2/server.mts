/** Isolated authenticated design proof (settings-tabs revision 2); all data stays in memory.
 * Variant of members-settings-prototype/server.mts: adds seeded schedules so the
 * Schedules screen has several subtitled rows. Role toggle: /_proof/role/member|owner. */
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { PgliteDatabase } from '../../../server/src/test-support.ts';
import { migrate } from '../../../server/src/database.ts';
import { TokenAuth } from '../../../server/src/auth.ts';
import { PhoneService } from '../../../server/src/phone-service.ts';
import type { DaemonService } from '../../../server/src/daemon-service.ts';
import { LiveHub } from '../../../server/src/live.ts';
import { ReviewAccess, REVIEW_IDENTITY_ID } from '../../../server/src/review-access.ts';
import { REVIEW_WORKSPACE_ID, ensureReviewWorkspace } from '../../../server/src/review-proof-fixture.ts';
import { createAgentSubscription } from '../../../server/src/agent-subscriptions.ts';
import { SUBSCRIBABLE_EVENT_KINDS } from '@beeline/api-contract/phone';
import { createBeelineServer } from '../../../server/src/server.ts';
const database = new PgliteDatabase();
await migrate(database);
await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Play Review','play-review')`, [REVIEW_IDENTITY_ID]);
await ensureReviewWorkspace(database, REVIEW_IDENTITY_ID);
await database.query(`UPDATE workspaces SET name='Beeline',visibility='public' WHERE id=$1`,[REVIEW_WORKSPACE_ID]);
const humans = ['Robin', 'Morgan'];
const agents = ['Ruby', 'Jellybean'];
const ids = new Map<string,string>();
for (const [names, kind] of [[humans,'human'],[agents,'agent']] as const) {
  for (const name of names) {
    const id=createHash('sha256').update('design-proof:'+name).digest('hex'); ids.set(name,id);
    await database.query(`INSERT INTO identities(id,kind,name,handle,face_id) VALUES($1,$2,$3,$4,$5)`,[id,kind,name,name.toLowerCase(),kind==='agent'?'fox':'owl']);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[REVIEW_WORKSPACE_ID,id]);
    if(kind==='agent') await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'gpt-5')`,[id,REVIEW_IDENTITY_ID]);
  }
}
for(const [index,name,author,text] of [
  [0,'beeline','Ruby','The settings flow is ready for review.'],
  [1,'design','Robin','Keep the existing filters and search where they are.'],
  [2,'releases','Jellybean','Android screenshots are next on the checklist.'],
  [3,'feedback','Morgan','Search should find people and agents too.'],
  [4,'weekend-plans','Robin','Coffee and a walk on Saturday?'],
] as const) {
  const id=randomUUID();
  await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,$3,$4)`,[id,REVIEW_WORKSPACE_ID,name,REVIEW_IDENTITY_ID]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,[REVIEW_WORKSPACE_ID,id,REVIEW_IDENTITY_ID]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,now()-($5::text||' minutes')::interval)`,[createHash('sha256').update('message:'+name).digest('hex'),id,ids.get(author),text,index*4+2]);
}
const roomIds=new Map<string,string>((await database.query<{id:string,name:string}>(`SELECT id,name FROM rooms WHERE workspace_id=$1 AND parent_id IS NULL`,[REVIEW_WORKSPACE_ID])).rows.map(r=>[r.name,r.id]));
for(const [index,room,agent,title,cadence,message] of [
  [0,'beeline','Ruby','Morning card',{kind:'cron',expression:'0 8 * * 1-5',timeZone:'Europe/London'},'Post the morning card with open corners and anything waiting on people.'],
  [1,'beeline','Jellybean','Release',{kind:'cron',expression:'0 16 * * 4',timeZone:'Europe/London'},'Cut the weekly release and post the notes in this Room.'],
  [2,'beeline','Ruby','Design review digest',{kind:'interval',everyMinutes:720},'Summarise new screenshots and open questions for the design review.'],
  [3,'beeline','Jellybean','Feedback triage',{kind:'interval',everyMinutes:60},'Read new feedback, group duplicates and open corners for real bugs.'],
  [4,'beeline','Ruby','App speed test',{kind:'cron',expression:'30 2 * * *',timeZone:'Europe/London'},'Run the app speed test and report regressions over five percent.'],
  [5,'beeline','Jellybean','Dependency check',{kind:'cron',expression:'0 9 * * 1',timeZone:'Europe/London'},'Check for dependency updates with security fixes.'],
] as const){
  const roomId=roomIds.get(room)!;
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,[REVIEW_WORKSPACE_ID,roomId,ids.get(agent)]);
  await database.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,title,owner_id,max_runs) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,now()+($8::text||' hours')::interval,$9,$5,$10)`,
    [randomUUID(),REVIEW_WORKSPACE_ID,roomId,ids.get(agent),REVIEW_IDENTITY_ID,JSON.stringify(cadence),message,index+1,title,index%3===2?1:null]);
}
for(const [index,event] of SUBSCRIBABLE_EVENT_KINDS.slice(0,4).entries()){
  await createAgentSubscription(database,ids.get(index%2?'Jellybean':'Ruby')!,{roomId:roomIds.get('beeline')!,source:'room',event,prompt:`Review each ${event} event and post a short note in this Room.`});
}
await database.query(`UPDATE rooms SET archived_at=now() WHERE id IN ('bee11e00-0000-4000-8000-000000000103','bee11e00-0000-4000-8000-000000000104')`);
const general=(await database.query<{id:string}>(`SELECT id FROM rooms WHERE workspace_id=$1 AND name='general' AND parent_id IS NULL`,[REVIEW_WORKSPACE_ID])).rows[0]!;
await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'Welcome back. The next review is on Friday.',now()-interval '22 minutes')`,[createHash('sha256').update('message:general').digest('hex'),general.id,ids.get('Robin')]);
const dm=randomUUID();
await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by,direct_participants) VALUES($1,$2,'Ruby',$3,$4::jsonb)`,[dm,REVIEW_WORKSPACE_ID,REVIEW_IDENTITY_ID,JSON.stringify([REVIEW_IDENTITY_ID,ids.get('Ruby')])]);
await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[REVIEW_WORKSPACE_ID,dm,REVIEW_IDENTITY_ID]);
await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'I can walk through the admin settings with you.',now()-interval '5 minutes')`,[createHash('sha256').update('message:dm').digest('hex'),dm,ids.get('Ruby')]);
const phone=new PhoneService(database, process.env.PROOF_BASE_URL ?? 'http://10.0.2.2:45861');
await phone.completeWelcomeCards(REVIEW_IDENTITY_ID);
const auth=new TokenAuth(database,async()=>{throw new Error('No external auth in isolated design proof');});
const live=new LiveHub();
const review=new ReviewAccess({secret:'isolated-design-proof-secret-5678',mint:()=>auth.exchangeReviewIdentity()});
const app=createBeelineServer({database,auth,phone,daemon:{} as DaemonService,live,review,webAppOrigins:['http://127.0.0.1:18082','http://localhost:18082'],mediaMaximumBytes:1});
await new Promise<void>(resolve=>app.listen(45862,'127.0.0.1',resolve));
const proxy=createServer(async(req,res)=>{
  if(req.url?.startsWith('/_proof/badge/')) {
    const enabled=req.url.endsWith('/on');
    await database.query(`UPDATE messages SET text=$1 WHERE id=$2`,[enabled ? '@play-review please review this prototype?' : 'Welcome back. The next review is on Friday.',createHash('sha256').update('message:general').digest('hex')]);
    res.end(JSON.stringify({enabled}));return;
  }
  if(req.url?.startsWith('/_proof/role/')) {
    const role=req.url.endsWith('/member')?'member':'owner';
    await database.query(`UPDATE memberships SET role=$1 WHERE workspace_id=$2 AND room_id IS NULL AND identity_id=$3`,[role,REVIEW_WORKSPACE_ID,REVIEW_IDENTITY_ID]);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({role}));return;
  }
  const forward=httpRequest({hostname:'127.0.0.1',port:45862,path:req.url,method:req.method,headers:req.headers},answer=>{res.writeHead(answer.statusCode??502,answer.headers);answer.pipe(res);});
  forward.on('error',()=>{res.writeHead(503);res.end();});req.pipe(forward);
});
proxy.on('upgrade',(req,socket,head)=>{
  const forward=httpRequest({hostname:'127.0.0.1',port:45862,path:req.url,headers:req.headers});
  forward.on('upgrade',(response,upstream,upstreamHead)=>{
    socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
    if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);
    socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });forward.on('error',()=>socket.destroy());forward.end();
});
proxy.listen(45861,'127.0.0.1',()=>console.log('Isolated design proof ready on 45861'));
