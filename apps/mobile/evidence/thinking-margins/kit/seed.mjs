// Disposable fixture only. Never point this at a production database.
import pg from 'pg';
import { createHash } from 'node:crypto';
const url = process.env.LATENCY_RIG_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.includes('latency_rig')) throw Error('Local fixture database required');
const db = new pg.Client({ connectionString: url }); await db.connect();
const hash = s => createHash('sha256').update(s).digest('hex');
const viewer = hash('beeline:play-review-identity');
const ws = 'bee11e00-0000-4000-8000-000000000105';
await db.query(`INSERT INTO identities(id,kind,name,handle,welcome_cards_due) VALUES($1,'human','Play Review','play-review',false) ON CONFLICT(id) DO NOTHING`, [viewer]);
await db.query(`INSERT INTO workspaces(id,name,visibility) VALUES($1,'Beeline','invite-only') ON CONFLICT(id) DO NOTHING`, [ws]);
await db.end();
await import('../../room-list-icon-centre/kit/seed-beeline.mjs');
const fixture = new pg.Client({connectionString:url}); await fixture.connect();
await fixture.query(`DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE workspace_id=$1) AND text LIKE '%the turn stalled.%'`,[ws]);
const room = (await fixture.query(`SELECT id FROM rooms WHERE workspace_id=$1 AND name='Ruby'`,[ws])).rows[0].id;
const agent = hash('rlm88-id:Ruby');
await fixture.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Ruby, please think about the transcript alignment.') ON CONFLICT(id) DO NOTHING`,[hash('thinking-request'),room,viewer]);
await fixture.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at,created_at) VALUES($1,$2,$3,'working',now(),now()) ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='working',started_at=now(),created_at=now()`,[room,hash('thinking-request'),agent]);
const parent = '97a7dad0-1c24-4610-8236-a77cf0fbb81a';
const corner = 'bee11e00-0000-4000-8000-000000000106';
await fixture.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Thinking alignment') ON CONFLICT(id) DO NOTHING`,[corner,ws,parent,viewer]);
await fixture.query(`INSERT INTO corner_facts(corner_id,commissioned_by,objective,kind) VALUES($1,$2,'Align the thinking status margins','human') ON CONFLICT(corner_id) DO NOTHING`,[corner,viewer]);
await fixture.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,$3,'member' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,[ws,parent,agent]);
for (const target of [parent,corner]) {
 await fixture.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Ruby, please think about the transcript alignment.') ON CONFLICT(id) DO NOTHING`,[hash('thinking-'+target),target,viewer]);
 await fixture.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,$2,$3,'working') ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status='working',started_at=now(),created_at=now()`,[target,hash('thinking-'+target),agent]);
}
console.log(JSON.stringify({room,corner,parent,viewer,agent}));
await fixture.end();
