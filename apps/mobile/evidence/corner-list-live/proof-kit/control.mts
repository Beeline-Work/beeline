import { LiveHub } from '../../../../server/src/live.ts';
import { createServer } from 'node:http';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
const url = process.env.DATABASE_URL!;
if (!url?.includes('localhost/beeline_latency_rig_corner_b2aa')) throw new Error('Local fixture only');
const db = new pg.Pool({connectionString:url, max:2});
const viewer = createHash('sha256').update('beeline:play-review-identity').digest('hex');
const agent = createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
const parent = 'b2aa0000-0000-4000-8000-000000000001';
const archive = 'b2aa0000-0000-4000-8000-000000000002';
const turn = 'b2aa0000-0000-4000-8000-000000000003';
let hub:LiveHub;
let phoneTokens: any;
let events:any[]=[];
const original=LiveHub.prototype.publish;
LiveHub.prototype.publish=function(event) {hub=this;events.push({at:Date.now(),roomId:event.roomId,type:event.type,reason:'reason' in event?event.reason:undefined});if(events.length>1000)events.shift();return original.call(this,event)};
const server=createServer(async(req,res)=>{
 try {
  const action=req.url;
  let result:any={};
  if(action==='/reset') {
   await db.query('DELETE FROM agent_turns WHERE room_id=ANY($1::uuid[])',[[archive,turn]]);
   await db.query('UPDATE rooms SET archived_at=NULL WHERE id=ANY($1::uuid[])',[[archive,turn]]);
   await db.query(`UPDATE corner_facts SET close_requested=false,lifecycle='{"lifecycle":"unknown","checks":"unknown"}'::jsonb,workflow_state='implement',workflow_outcome=NULL WHERE corner_id=ANY($1::uuid[])`,[[archive,turn]]);
   await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at) VALUES($1,$2,$3,'working',now())`,[archive,randomUUID(),agent]);
   for(let i=0;i<8;i++) hub?.publish({type:'invalidate',roomId:parent,reason:'corner-status'});
   result={parent,archive,turn};
  } else if(action==='/evict') {
   events=[];
   const rows=await db.query("SELECT id FROM rooms WHERE parent_id IS NULL AND name LIKE 'Eviction %' ORDER BY name");
   for(const row of rows.rows) {
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Local eviction activity')`,[randomUUID().replaceAll('-',''),row.id,viewer]);
   }
   // Listener notifications are asynchronous; barrier reaches its committed fanout.
   const expected=new Set(rows.rows.map(r=>r.id));
   const end=Date.now()+10000;
   while(Date.now()<end && new Set(events.filter(e=>expected.has(e.roomId)).map(e=>e.roomId)).size<257) await new Promise(r=>setTimeout(r,20));
   result={distinctActivityRooms:new Set(events.filter(e=>expected.has(e.roomId)).map(e=>e.roomId)).size};
   if(result.distinctActivityRooms<257) throw new Error('eviction notifications not observed');
  } else if(action==='/archive') {
   const tokens=phoneTokens ??= await (await fetch('http://127.0.0.1:9180/v1/auth/review/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:process.env.BEELINE_REVIEW_SECRET})})).json();
   const startedAt=Date.now();
   const response=await fetch('http://127.0.0.1:9180/v1/phone/operations/requestCornerClose',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${tokens.accessToken}`},body:JSON.stringify({roomId:archive})});
   result={startedAt,settledAt:Date.now(),status:response.status,body:await response.text()};
  } else if(action==='/turn') {
   const startedAt=Date.now();
   await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at) VALUES($1,$2,$3,'working',now())`,[turn,randomUUID(),agent]);
   result={startedAt,settledAt:Date.now()};
  } else if(action==='/events') result={events};
  else {res.writeHead(404).end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.writeHead(500).end(String(e))}
});
server.listen(9183,'127.0.0.1');
process.on('SIGTERM',()=>{server.close();void db.end();});
await import('../../../../server/src/index.ts');
