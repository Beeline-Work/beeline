// R1: built service stand-in; isolated PGlite, no production writes.
import assert from 'node:assert/strict';
import { migrate } from '../apps/server/dist/database.js';
import { ensureSystemDirectMessageRoom } from '../apps/server/dist/system-line.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';

let database;


try {
  database = new PgliteDatabase();
  await migrate(database);
  const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '33333333-3333-4333-8333-333333333333';
  await database.query(`INSERT INTO identities(id,kind,name,avatar,face_id) VALUES
    ($1,'human','Owner','/v1/objects/owner',NULL),
    ($2,'agent','Jellybean','/v1/agent-avatars/44444444-4444-4444-8444-444444444444','fox')`, [owner, agent]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [workspace]);
  const system = await ensureSystemDirectMessageRoom(database, workspace, owner);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$3,$4,'member')`,
    [workspace, owner, room, agent]);
  const stale = { pubkey: agent, kind: 'agent', name: 'Old name', avatar: '/v1/agent-avatars/55555555-5555-4555-8555-555555555555' };
  const person = { pubkey: owner, kind: 'human', name: 'Owner' };
  for (const target of [system, room]) for (const kind of ['grant-request', 'squire-approval']) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Approve?','card',$4,$5::jsonb)`,
      [`${target}-${kind}`, target, owner, kind, JSON.stringify({ agent: stale, owner: person,
        ...(kind === 'grant-request' ? { requester: stale } : {}), grants: [{ grantId: 'proof-grant', kind: 'command', target: 'npm test', reason: 'Run the checks', status: 'pending', requestedBy: stale, roomId: target, createdAt: 1793356800, auto: false }], tool: 'test', title: 'Test', detail: 'Test',
        approvalUrl: 'https://example.com/approve', linkKind: 'approval' })]);
  }
  const phone = new PhoneService(database, 'https://phone.example');
  for (const target of [system, room]) for (const read of [
    () => phone.readRoom(target, owner),
    () => phone.readHistory(target, owner),
  ]) {
    const view = await read();
    assert.ok(view);
    const cards = view.messages.flatMap(message => message.grantRequest ? [message.grantRequest]
      : message.squireApproval ? [message.squireApproval] : []);
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.deepEqual(card.agent, { pubkey: agent, kind: 'agent', name: 'Jellybean',
        avatar: 'https://phone.example/v1/agent-avatars/44444444-4444-4444-8444-444444444444', face: 'fox' });
      assert.equal(card.owner?.avatar, 'https://phone.example/v1/objects/owner');
      if ('requester' in card) assert.deepEqual(card.requester, card.agent);
    }
  }
  console.log('R1 PASS: built PhoneService returns current absolute avatar and face on System DM and Room cards, including history.');
} finally { await database.close(); }
