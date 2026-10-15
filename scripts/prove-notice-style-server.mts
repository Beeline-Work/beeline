import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { PhoneService } from '../apps/server/src/phone-service.js';

const rows = JSON.parse(await readFile('apps/mobile/notice-style-proof/rows.json', 'utf8'));
const db = new PgliteDatabase();
await migrate(db);
const workspace = 'f0b23d83-96a5-4ca4-9a46-fc8e3c1e82a1';
const parent = '11111111-2222-4333-8444-555555555555';
const corner = 'dac9d764-e14e-4ca0-b263-cda37ffa737a';
const viewer = '1'.repeat(64);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader')`, [viewer]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline local proof')`, [workspace]);
await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'beeline')`, [parent, workspace, viewer]);
await db.query(`INSERT INTO rooms(id,workspace_id,created_by,parent_id,name) VALUES($1,$2,$3,$4,'join-link-wrong-workspace')`, [corner, workspace, viewer, parent]);
for (const row of rows) {
  await db.query(`INSERT INTO identities(id,kind,name,handle,avatar,face_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
    [row.author_id,row.author_kind,row.author_name,row.author_handle,row.author_avatar,row.author_face]);
}
await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,objective) VALUES($1,$2,$3)`,
  [corner,rows[1].author_id,'On Android, opening a Workspace invite link with Beeline backgrounded must land existing members in the invited Workspace, not the last one']);
for (const roomId of [null, parent, corner])
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [workspace,roomId,viewer]);
await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace,corner,rows[1].author_id]);
for (const row of rows)
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,system_event,created_at,durable_fact)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [row.id,corner,row.author_id,row.text,row.presentation,row.card_type,JSON.stringify(row.card),JSON.stringify(row.system_event),row.created_at,row.durable_fact]);
const phone = new PhoneService(db, 'http://10.0.2.2:8893');
const view = await phone.readRoom(corner, viewer);
assert(view);
assert.equal(view.messages.length, 2);
assert.equal(view.messages[0]?.presentation, 'card');
assert.equal(view.messages[1]?.presentation, 'system');
for (const row of rows) {
  const stored = (await db.query(`SELECT presentation,card_type,card,system_event FROM messages WHERE id=$1`, [row.id])).rows[0];
  assert.deepEqual(stored, { presentation: row.presentation, card_type: row.card_type, card: row.card, system_event: row.system_event });
}
await writeFile('apps/mobile/notice-style-proof/room.json', JSON.stringify(view, null, 2) + '\n');
const server = createServer(async (request, response) => {
  if (request.method !== 'GET' || request.url !== '/room') {
    response.writeHead(404); response.end(); return;
  }
  try {
    const fresh = await phone.readRoom(corner, viewer);
    console.log('NOTICE-STYLE-1 GET /room: card, system; unchanged seed');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(fresh));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(8893, '127.0.0.1', () => console.log('NOTICE-STYLE-1 local server ready on 8893'));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => void db.close().then(() => process.exit(0))));
