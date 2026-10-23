// Disposable fixture: one "Beeline" workspace with three Rooms and two DMs, like the approved mock.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const pg = createRequire(new URL('../../../../../package.json', import.meta.url))('pg');
const db = new pg.Client({ connectionString: process.env.LATENCY_RIG_DATABASE_URL });
await db.connect();
const uuid = (n) => { const h = createHash('sha256').update('rlm88b:' + n).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const hid = (n) => createHash('sha256').update('rlm88-id:' + n).digest('hex');
const viewer = createHash('sha256').update('beeline:play-review-identity').digest('hex');
const ws = 'bee11e00-0000-4000-8000-000000000105';
// The review sign-in lands in its own workspace; rename it and archive its starter Rooms.
await db.query(`UPDATE workspaces SET name='Beeline' WHERE id=$1`, [ws]);
await db.query(`UPDATE rooms SET archived_at=now() WHERE workspace_id=$1 AND name IN ('general','proof','release proof')`, [ws]);
// Hide the rig workspaces so the viewer lands on Beeline.
await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND workspace_id<>$2 AND removed_at IS NULL`, [viewer, ws]);
const add = async (room, who, role) => db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NOT DISTINCT FROM $2 AND identity_id=$3 AND removed_at IS NULL)`, [ws, room, who, role]);
await add(null, viewer, 'owner');
const agents = {};
for (const name of ['Speedy', 'Niglet', 'Ruby']) {
  agents[name] = hid(name);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3) ON CONFLICT(id) DO NOTHING`, [agents[name], name, name.toLowerCase()]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT(agent_id) DO NOTHING`, [agents[name], viewer]);
  await add(null, agents[name], 'member');
}
const rooms = [
  ['beeline', null, 'Speedy', 'Merged #2814. Composer tags now show as plain text.', 5, true],
  ['markets', null, 'Niglet', 'Z.ai is down 28% from its high two weeks ago.', 10, false],
  ['design', null, 'Ruby', 'The header mock is ready for a look.', 15, false],
  ['Ruby', ['Ruby'], 'Ruby', 'Sounds good, I will pick it up after lunch.', 20, false],
  ['Speedy', ['Speedy'], 'Speedy', 'Review is done. Ready to land.', 25, true],
];
for (const [name, dm, author, text, minutes, unread] of rooms) {
  const room = uuid('room-' + name + (dm ? '-dm' : ''));
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants,updated_at) VALUES($1,$2,$3,$4,$5,now()-make_interval(mins=>$6)) ON CONFLICT(id) DO NOTHING`,
    [room, ws, viewer, name, dm ? JSON.stringify([viewer, agents[dm[0]]]) : null, minutes]);
  await add(room, viewer, 'owner');
  await add(room, agents[author], 'member');
  const mid = hid('msg-' + room);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,now()-make_interval(mins=>$5)) ON CONFLICT(id) DO NOTHING`, [mid, room, agents[author], text, minutes]);
  if (unread) await db.query(`DELETE FROM room_read_marks WHERE room_id=$1 AND identity_id=$2`, [room, viewer]);
  if (!unread) await db.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,read_at) SELECT $1,$2,created_at,id,now() FROM messages WHERE id=$3 ON CONFLICT(room_id,identity_id) DO UPDATE SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id,read_at=now()`, [room, viewer, mid]);
}
console.log(JSON.stringify({ ws, beeline: uuid('room-beeline') }));
await db.end();
