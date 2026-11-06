// Built service proof with an isolated database; never touches a running daemon.
import assert from 'node:assert/strict';
import { PgliteDatabase, insertCornerFacts } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { refreshCornerAttention } from '../apps/server/dist/corner-attention.js';

const db = new PgliteDatabase();
const ws = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64), peer = 'd'.repeat(64);
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),
    ($3,'agent','Worker','worker'),($4,'agent','Peer','peer')`, [human,commander,worker,peer]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [commander,worker,peer,human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'CHAIN-WAIT proof')`, [ws]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)`, [room,ws,human]);
  for (const identity of [human,commander,worker,peer]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [ws,identity,room]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [corner,ws,room,commander]);
  await insertCornerFacts(db, { cornerId: corner, ownerAgentId: worker, commissionedBy: human });
  const phone = new PhoneService(db, 'http://isolated-proof');
  const state = async () => {
    await refreshCornerAttention(db,corner);
    return (await phone.readCorners(room,human)).corners[0].state;
  };
  const question = async (id, author = worker) => db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES($1,$2,$3,'needs-decision: @owner Which scope?','message')`, [id,corner,author]);
  const order = async (id, author) => createAgentCommand(db, { id, roomId: corner, agentId: worker,
    sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: author, fromRoomId: room, text: 'Proceed' } });
  await question('commander-question',commander);
  assert.equal(await state(),'waiting');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('parent-answer',$1,$2,'Narrow scope','message')`, [room,human]);
  await order('answer-down-chain',commander);
  assert.notEqual(await state(),'waiting');
  await question('worker-question');
  assert.equal(await state(),'waiting');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('peer-answer',$1,$2,'Proceed','message')`, [corner,peer]);
  assert.equal(await state(),'waiting');
  await db.query(`UPDATE corner_github_cache SET lifecycle='{"pr":{"headSha":"proof-head"},"checks":"pending"}'::jsonb WHERE corner_id=$1`, [corner]);
  assert.equal(await state(),'waiting');
  await order('superior-direct-order',human);
  assert.notEqual(await state(),'waiting');
  console.log('Reproduction CHAIN-WAIT demonstrated: phone corner list clears after commander/superior orders; peer replies and worker pushes preserve Waiting.');
} finally { await db.close(); }
