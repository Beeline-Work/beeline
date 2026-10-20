import pg from 'pg';
import {createHash} from 'node:crypto';
const db=new pg.Client({connectionString:'postgresql://localhost/beeline_latency_rig_corner_b2aa?host=%2Fvar%2Frun%2Fpostgresql'});await db.connect();
const viewer=createHash('sha256').update('beeline:play-review-identity').digest('hex');
const agent=createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
const {rows:[workspace]}=await db.query("SELECT id FROM workspaces WHERE name='Latency Rig 1'");
const parent='b2aa0000-0000-4000-8000-000000000001';
const archive='b2aa0000-0000-4000-8000-000000000002';
const turn='b2aa0000-0000-4000-8000-000000000003';
for(const [id,name,parentId] of [[parent,'Corner proof',null],[archive,'archive-proof',parent],[turn,'turn-proof',parent]]){
 await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[id,workspace.id,parentId,viewer,name]);
 for(const who of [viewer,agent])await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,$3,'owner' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,[workspace.id,id,who]);
 if(parentId)await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective,kind) VALUES($1,$2,$3,'Isolated corner freshness proof','agent') ON CONFLICT(corner_id) DO NOTHING`,[id,agent,viewer]);
}
for(let i=0;i<257;i++){
 const id=`b2aa0001-0000-4000-8000-${String(i).padStart(12,'0')}`;
 await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[id,workspace.id,viewer,`Eviction ${String(i).padStart(3,'0')}`]);
}
await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('b2aaproofparentinitial',$1,$2,'Isolated freshness proof') ON CONFLICT(id) DO NOTHING`,[parent,viewer]);
console.log({parent,archive,turn,workspace:workspace.id});await db.end();
