import { afterAll, beforeAll, expect, it } from 'vitest';
import { readRoomView } from '@beeline/api-contract/phone';
import { PhoneService } from './phone-service.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64), BEEBEE = 'b'.repeat(64), LUNA = 'c'.repeat(64), BBC = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
let database: PgliteDatabase;
let phone: PhoneService;
beforeAll(async () => {
  database = await migratedDatabase();
  await database.query(`INSERT INTO identities(id,kind,name) VALUES
    ($1,'human','Owner'),($2,'agent','Beebee'),($3,'agent','Luna'),($4,'agent','BBC')`, [OWNER, BEEBEE, LUNA, BBC]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'general')`, [ROOM, WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Corner',$3)`, [CORNER, WORKSPACE, ROOM]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
    ($2,$1,'beeline/deepseek/deepseek-v4.1-flash-1017'),($3,$1,'beeline/openai/gpt-6-luna'),($4,$1,'gpt-6.1-sol')`, [OWNER, BEEBEE, LUNA, BBC]);
  await database.query(`UPDATE agents SET model_catalog=$2::jsonb WHERE agent_id=$1`, [BBC, JSON.stringify([
    { id: 'model', category: 'model', currentValue: 'gpt-6.1-sol', options: [{ id: 'gpt-6.1-sol', name: '6.1 Sol' }] },
  ])]);
  for (const id of [OWNER, BEEBEE, LUNA, BBC]) {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WORKSPACE, id, ROOM]);
  }
  for (const id of [BEEBEE, LUNA]) await database.query(
    `INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'fixture')`, [id, WORKSPACE, OWNER]);
  phone = new PhoneService(database, 'http://local.test');
}, 30000);
afterAll(async () => database.close());

it('delivers free-agent model labels on Room entry before a helper catalog or Workspace read', async () => {
  for (const roomId of [ROOM, CORNER]) {
    const response = await phone.readRoom(roomId, OWNER);
    // Exercise the phone decoder too: optional member metadata must survive the wire.
    const view = readRoomView(JSON.parse(JSON.stringify(response)))!;
    expect(view.members.find(member => member.identity.pubkey === BEEBEE)).toHaveProperty('model', 'beeline/deepseek/deepseek-v4.1-flash-1017');
    expect(view.members.find(member => member.identity.pubkey === LUNA)).toHaveProperty('model', 'beeline/openai/gpt-6-luna');
    expect(view.members.find(member => member.identity.pubkey === BBC)).toHaveProperty('model', '6.1 Sol');
    expect(view.members.find(member => member.identity.pubkey === OWNER)).not.toHaveProperty('model');
  }
});

it('keeps model labels after cold-wake catalogs arrive and reflects selected-model changes', async () => {
  for (const [id, model] of [[BEEBEE, 'beeline/deepseek/deepseek-v4.1-flash-1017'], [LUNA, 'beeline/openai/gpt-6-luna']]) {
    await database.query(`UPDATE agents SET model_catalog=$2::jsonb WHERE agent_id=$1`, [id, JSON.stringify([
      { id: 'model', category: 'model', currentValue: model, options: [{ id: model, name: model }] },
    ])]);
  }
  const awake = readRoomView(await phone.readRoom(ROOM, OWNER))!;
  expect(awake.members.find(member => member.identity.pubkey === LUNA)).toHaveProperty('model', 'beeline/openai/gpt-6-luna');
  await database.query(`UPDATE agents SET selected_model='gpt-6-luna' WHERE agent_id=$1`, [BBC]);
  const changed = readRoomView(await phone.readRoom(ROOM, OWNER))!;
  expect(changed.members.find(member => member.identity.pubkey === BBC)).toHaveProperty('model', 'gpt-6-luna');
  expect(await phone.readRoom(ROOM, 'e'.repeat(64))).toBeNull();
});
