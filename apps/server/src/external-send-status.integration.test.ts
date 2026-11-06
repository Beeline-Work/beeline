import { afterAll, beforeAll, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const H = 'a'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64), N = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Atlas','atlas'),
    ($3,'agent','Nova','nova'),($4,'agent','Native','native')`, [H, A, B, N]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [A, B, N, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Sent status')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES
    ($1,$3,'Room',NULL),($2,$3,'DM',$4::jsonb)`, [R, DM, W, JSON.stringify([H, A])]);
  for (const who of [H, A, B, N]) for (const room of [null, R, ...(who === H || who === A ? [DM] : [])])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W, room, who]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('sent-client','Sent client','[]'),('sent-client-2','Sent client 2','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label)
    VALUES('sent-client',$1,$2,'Atlas'),('sent-client-2',$1,$3,'Nova')`, [H, A, B]);
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());

it('acknowledges committed external mentions, without treating an unconnected native agent as external', async () => {
  const input = { roomId: R, messageId: '1'.repeat(64), text: '@nova @atlas @native please check this' };
  const result = await phone.sendMessage(input, H);
  expect(result.externalAgentHandles).toEqual(['atlas', 'nova']);
  expect(result.message?.id).toBe(input.messageId);
  expect((await db.query('SELECT id FROM messages WHERE id=$1', [input.messageId])).rows).toHaveLength(1);
  expect((await phone.sendMessage(input, H)).externalAgentHandles).toEqual(['atlas', 'nova']);
  expect((await phone.sendMessage({ roomId: R, text: '@native another question' }, H)).externalAgentHandles).toEqual([]);
});

it('uses routed recipients for natural DMs and explicit replies', async () => {
  expect((await phone.sendMessage({ roomId: DM, text: 'Please check the notes' }, H)).externalAgentHandles).toEqual(['atlas']);
  const parent = await phone.sendMessage({ roomId: R, text: 'Here are the notes' }, H);
  expect((await phone.sendReply({ roomId: R, parentMessageId: parent.messageId, text: '@nova check the reply' }, H))
    .externalAgentHandles).toEqual(['nova']);
});

it('does not acknowledge unaddressed or agent-authored messages as external sends', async () => {
  expect((await phone.sendMessage({ roomId: R, text: 'Hello everyone' }, H)).externalAgentHandles).toEqual([]);
  expect((await phone.sendMessage({ roomId: R, text: '@atlas hello' }, N)).externalAgentHandles).toEqual([]);
});

it('does not name an external nonmember when a typed handle cannot route', async () => {
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [R, B]);
  expect((await phone.sendMessage({ roomId: R, text: '@nova please check this' }, H)).externalAgentHandles).toEqual([]);
});
