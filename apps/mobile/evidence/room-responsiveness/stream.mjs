import pg from 'pg';
import { createHash } from 'node:crypto';
const db = new pg.Client({connectionString:'postgresql://localhost/beeline_latency_rig_jellybean_responsive?host=%2Fvar%2Frun%2Fpostgresql'});
await db.connect();
const corner='a04a1c5f-e21b-4006-8eef-894e73c02b5b';
const agent=createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at,created_at) VALUES($1,'responsive-stream',$2,'working',now(),now()) ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='working',created_at=now()`,[corner,agent]);
for(let n=1;n<=100;n++) {
 const text='Stream test: '+('long reply scrolling stays smooth. '.repeat(n*4));
 await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'responsive-stream','draft',$3) ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=excluded.body,updated_at=now()`,[corner,agent,JSON.stringify({text})]);
 await new Promise(r=>setTimeout(r,100));
}
await db.end();
