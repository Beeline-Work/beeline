import pg from 'pg';
import { createHash } from 'node:crypto';
const db = new pg.Client({connectionString:'postgresql://localhost/beeline_latency_rig_jellybean_responsive?host=%2Fvar%2Frun%2Fpostgresql'});
await db.connect();
const room='f13fbac4-e500-4f81-8c20-78bc02c3aac8', corner='a04a1c5f-e21b-4006-8eef-894e73c02b5b';
const agent=createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
const human=createHash('sha256').update('beeline:play-review-identity').digest('hex');
// Older rig rows used 32-character ids; the current phone contract requires 64.
await db.query(`UPDATE messages SET id=id||id WHERE room_id=$1 AND presentation='message' AND length(id)=32`, [room]);
await db.query(`DELETE FROM messages WHERE id=ANY($1::text[])`, [['aaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbb','cccccccccccccccc']]);
for (const [id,target,text] of [['a'.repeat(64),room,'Room ready aaaaaaaaaaaaaaaa'],['b'.repeat(64),corner,'Corner ready bbbbbbbbbbbbbbbb']]) {
 await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(id) DO UPDATE SET created_at=now()`,[id,target,human,text]);
}
await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL)`,[corner,agent]);
await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
 VALUES('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',$1,$2,'Opened rig-corner-001','card','daemon-fact',$3,now())
 ON CONFLICT(id) DO UPDATE SET card=excluded.card,created_at=now()`,
 [room,human,JSON.stringify({type:'corner-open',cornerId:corner,name:'rig-corner-001',objective:'Latency rig corner'})]);
await db.end();
console.log({room,corner,agent});
