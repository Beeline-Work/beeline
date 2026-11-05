import { afterEach, expect, it } from 'vitest';
import { ensureSystemDirectMessageRoom } from './system-line.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

let database: PgliteDatabase;
afterEach(async () => database?.close());

it('R1: System DM and Room approval cards show current absolute avatars and faces', async () => {
  database = await migratedDatabase();
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
    expect(view).not.toBeNull();
    const cards = view!.messages.flatMap(message => message.grantRequest ? [message.grantRequest]
      : message.squireApproval ? [message.squireApproval] : []);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.agent).toEqual({ pubkey: agent, kind: 'agent', name: 'Jellybean',
        avatar: 'https://phone.example/v1/agent-avatars/44444444-4444-4444-8444-444444444444', face: 'fox' });
      expect(card.owner?.avatar).toBe('https://phone.example/v1/objects/owner');
      if ('requester' in card) expect(card.requester).toEqual(card.agent);
    }
  }
});
