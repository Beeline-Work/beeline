// node seed.mjs <tray|actions|chat>: disposable Tray fixture in the review Workspace.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const pg = createRequire('/home/alan/.local/state/beeline/corners/cf8ffb2b-4d7e-40dd-9844-6452ba9889b0/package.json')('pg');
const db = new pg.Client({ connectionString: 'postgres://latency_rig:local-proof-only@127.0.0.1:55494/tray_latency_rig' });
await db.connect();
const scene = process.argv[2];
const hid = (n) => createHash('sha256').update('niglet-tray:' + n).digest('hex');
const uuid = (n) => { const h = hid('u' + n); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const viewer = createHash('sha256').update('beeline:play-review-identity').digest('hex');
const ws = 'bee11e00-0000-4000-8000-000000000105';
await db.query(`UPDATE workspaces SET name='Tubing Crew' WHERE id=$1`, [ws]);
const add = (room, who, role) => db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NOT DISTINCT FROM $2 AND identity_id=$3 AND removed_at IS NULL)`, [ws, room, who, role]);
const agents = {};
for (const name of ['Luna', 'Emberus', 'Ruby', 'Jellybean', 'Hoots']) {
  agents[name] = hid(name);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3) ON CONFLICT(id) DO NOTHING`, [agents[name], name, name.toLowerCase()]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT(agent_id) DO NOTHING`, [agents[name], viewer]);
  await add(null, agents[name], 'member');
}
const general = uuid('general');
const rooms = { general: [general, null], 'avatar-system-mocks': [uuid('asm'), general], 'required-app-update': [uuid('rau'), general], 'hold-not-waiting': [uuid('hnw'), general] };
for (const [name, [id, parent]] of Object.entries(rooms)) {
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET archived_at=NULL`, [id, ws, parent, viewer, name]);
  await add(id, viewer, 'owner');
  for (const agent of Object.values(agents)) await add(id, agent, 'member');
}
await db.query(`UPDATE rooms SET archived_at=now() WHERE workspace_id=$1 AND NOT (id=ANY($2::uuid[]))`, [ws, Object.values(rooms).map(([id]) => id)]);
// Fresh scene: drop earlier fixture messages, marks and bookmarks.
const ids = Object.values(rooms).map(([id]) => id);
await db.query(`DELETE FROM message_bookmarks WHERE identity_id=$1`, [viewer]);
await db.query(`DELETE FROM needs_you_marks WHERE identity_id=$1`, [viewer]);
await db.query(`DELETE FROM agent_grants WHERE room_id=ANY($1::uuid[])`, [ids]);
await db.query(`DELETE FROM messages WHERE room_id=ANY($1::uuid[])`, [ids]);
let n = 0;
const msg = async (room, author, text, minutes, card) => {
  const id = hid(`${scene}-msg-${++n}`);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now()-make_interval(mins=>$8))`,
    [id, rooms[room][0], author, text, card ? 'card' : 'message', card?.type ?? null, card ? JSON.stringify(card.body) : null, minutes]);
  return id;
};
const bookmark = async (id, room, minutes) => db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at,created_at)
  SELECT $1,$2,room_id,id,$3,$4,created_at,now()-make_interval(mins=>$5) FROM messages WHERE id=$6`, [viewer, ws, room, rooms[room][1] ? 'corner' : 'room', minutes, id]);
const day = 24 * 60;
if (scene === 'tray' || scene === 'actions' || scene === 'all') {
  const ember = await msg('avatar-system-mocks', agents.Emberus, 'Attached **Inscriptions—ancient signs, personal color.**\n\n…', 4 * day + 60);
  const ruby = await msg('avatar-system-mocks', agents.Ruby, 'You’re right that round 2 mixed two design languages. I measured the 21 marks I seeded for this Room: most sit on a 24 px grid, but the inscriptions drift by half a pixel.', 4 * day + 50);
  await bookmark(ember, 'avatar-system-mocks', 4 * day + 10);
  await bookmark(ruby, 'avatar-system-mocks', 4 * day + 20);
}
if (scene === 'tray' || scene === 'all') {
  await msg('general', agents.Luna, '@play-review The Trusty Squire sign-in card is ready; please open it here on your phone to continue.', 21 * 60);
  await msg('general', agents.Luna, 'card', 21 * 60 + 1, { type: 'app-sign-in', body: { appId: uuid('app-squire'), appKey: 'trustysquire', name: 'Trusty Squire', ask: 'Sign in to Trusty Squire?', ownerId: viewer, agentId: agents.Luna, status: 'pending' } });
}
if (scene === 'actions' || scene === 'all') {
  const soon = (m) => Date.now() + m * 60_000;
  await msg('general', agents.Ruby, 'card', 2, { type: 'squire-approval', body: { agent: { pubkey: agents.Ruby, kind: 'agent', name: 'Ruby' }, tool: 'fetch_credential', title: 'Reveal Fly deploy key', action: 'reveal a key', reason: 'Fly deploy key, to ship the preview build.', approvalUrl: 'https://trustysquire.ai/approve/local-1', approvalId: 'local-1', expiresAt: soon(59), linkKind: 'approval', sourceRoomId: general } });
  await msg('required-app-update', agents.Jellybean, 'card', 6, { type: 'squire-approval', body: { agent: { pubkey: agents.Jellybean, kind: 'agent', name: 'Jellybean' }, tool: 'fetch_credential', title: 'Read the reviewer sign-in link', action: 'read the reviewer sign-in link', approvalUrl: 'https://trustysquire.ai/approve/local-2', approvalId: 'local-2', expiresAt: soon(56), linkKind: 'passkey', sourceRoomId: rooms['required-app-update'][0] } });
  const grant = uuid('grant-1');
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,created_at) VALUES($1,$2,$3,'command','pnpm test --filter mobile','run the mobile tests',$2,$4,'pending',now()-interval '1 hour')`, [grant, agents.Hoots, ws, rooms['hold-not-waiting'][0]]);
  await msg('hold-not-waiting', agents.Hoots, 'Hoots asks you', 60, { type: 'grant-request', body: { agent: { pubkey: agents.Hoots, kind: 'agent', name: 'Hoots' }, grants: [{ grantId: grant, kind: 'command', target: 'pnpm test --filter mobile', reason: 'run the mobile tests', status: 'pending' }] } });
}
if (scene === 'chat') {
  await msg('general', agents.Luna, 'I need Gmail to read the release thread.', 3);
  await msg('general', agents.Luna, 'card', 2, { type: 'app-sign-in', body: { appId: uuid('app-gmail'), appKey: 'gmail', name: 'Gmail', ownerId: viewer, agentId: agents.Luna, status: 'pending', continuation: 'Luna reads the release thread right after.' } });
}
console.log(JSON.stringify({ scene, general, rooms }));
await db.end();
