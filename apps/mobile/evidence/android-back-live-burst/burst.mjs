import pg from 'pg';import {createHash} from 'node:crypto';
const connectionString=process.env.LATENCY_RIG_DATABASE_URL;
if(!connectionString)throw new Error('LATENCY_RIG_DATABASE_URL is required');
const targetUrl=new URL(connectionString);
if(!['localhost','127.0.0.1','::1'].includes(targetUrl.hostname)||!targetUrl.pathname.includes('latency_rig')||
 (targetUrl.searchParams.has('host')&&targetUrl.searchParams.get('host')!=='/var/run/postgresql'))
 throw new Error('Burst writes require a loopback latency_rig database');
const db=new pg.Client({connectionString});await db.connect();
const human=createHash('sha256').update('beeline:play-review-identity').digest('hex');
const agent=createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
const mode=process.argv[2]??'spread';const target=process.argv[3]??'f13fbac4-e500-4f81-8c20-78bc02c3aac8';
const rooms=(await db.query("SELECT id FROM rooms WHERE workspace_id='dc27ab0c-32d1-49ca-8361-e3ff4664bcd1' AND parent_id IS NULL AND direct_participants IS NULL ORDER BY name")).rows;
const corners=(await db.query("SELECT corner_id FROM corner_facts WHERE corner_id IN (SELECT id FROM rooms WHERE parent_id='f13fbac4-e500-4f81-8c20-78bc02c3aac8') ORDER BY corner_id LIMIT 50")).rows;
const start=Date.now(),times=[];
const writes=mode==='draft'||mode==='corners'?50:25;
for(let n=0;n<writes;n++){
 const room=mode==='spread'?rooms[n%rooms.length].id:target;
 const marker=room==='a04a1c5f-e21b-4006-8eef-894e73c02b5b'?'bbbbbbbbbbbbbbbb':'aaaaaaaaaaaaaaaa';
 const id=createHash('sha256').update('back-burst-'+mode+'-'+room+'-'+n).digest('hex');
 if(mode==='corners') await db.query('UPDATE corner_facts SET objective=$2 WHERE corner_id=$1',[corners[n].corner_id,'Corner burst '+n+' '+start]);
 else if(mode==='draft') await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'back-draft','draft',$3) ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=excluded.body,updated_at=now()`,[room,agent,JSON.stringify({text:'Draft '+('live transcript text. '.repeat(n*10))})]);
 else await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET text=excluded.text,created_at=excluded.created_at`,[id,room,human,'Burst '+n+' '+('Transcript paragraph. '.repeat(mode==='spread'?2:100))+' '+start+' '+marker]);
 times.push(Date.now());await new Promise(r=>setTimeout(r,Math.max(0,start+(n+1)*1000/writes-Date.now())));
}
await db.end();console.log(JSON.stringify({start,end:Date.now(),mode,target,times}));
