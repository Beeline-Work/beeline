import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const OWNER = 'a'.repeat(64), JELLYBEAN = 'b'.repeat(64), BABY = 'c'.repeat(64), CANDY = 'd'.repeat(64), EARTH = 'e'.repeat(64);
const AGENTS = [JELLYBEAN, BABY, CANDY, EARTH];
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
let order: AgentCommand;

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Jellybean','jellybean'),($3,'agent','Baby','baby'),
    ($4,'agent','Candy','candy'),($5,'agent','Earth','earth')`, [OWNER, ...AGENTS]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$5),($2,$5),($3,$5),($4,$5)`, [...AGENTS, OWNER]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Order target proof')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
    VALUES($1,$3,'beeline',NULL,$4),($2,$3,'Owner and Jellybean',jsonb_build_array($4::text,$5::text),$4)`,
    [ROOM, DM, WS, OWNER, JELLYBEAN]);
  for (const person of [OWNER, ...AGENTS])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, person, ROOM]);
  for (const person of [OWNER, JELLYBEAN])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, DM, person]);
  await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Get Candy to look at the build' }, OWNER);
  order = (await daemon.execute('getAgentCommands', { roomId: DM }, JELLYBEAN)).commands[0]!;
  await daemon.execute('claimAgentCommand', { roomId: DM, commandId: order.id, generationId: 'g1' }, JELLYBEAN);
});
const authority = () => ({ roomId: order.roomId, requestId: order.turnRequestId, generationId: 'g1' });
const orderWakes = async () => (await db.query<{ agent_id: string; room_id: string }>(
  `SELECT agent_id,room_id FROM agent_commands WHERE reason='order' ORDER BY agent_id`)).rows;

it('Reproduction room-broadcast: replays the four incident Room orders and wakes nobody', async () => {
  for (const text of ['Candy only: check the build', 'Baby only: rerun the proof', 'Candy only: post the URL', 'Baby only: stop'])
    await expect(daemon.execute('order', { ...authority(), address: ROOM, text }, JELLYBEAN))
      .rejects.toThrow('a Room order must name exactly one agent');
  expect(await orderWakes()).toEqual([]);
  console.info('Demonstrated room-broadcast: 4 Room-address orders without agent were refused; 0 agents woken (was Baby, Candy, Earth)');
});

it('wakes only the named agent at a Room address, by handle, @handle or id', async () => {
  await daemon.execute('order', { ...authority(), address: ROOM, agent: '@candy', text: 'Candy only: check the build' }, JELLYBEAN);
  expect(await orderWakes()).toEqual([{ agent_id: CANDY, room_id: ROOM }]);
  await daemon.execute('order', { ...authority(), address: ROOM, agent: BABY, text: 'Baby only: rerun the proof' }, JELLYBEAN);
  expect((await orderWakes()).map(row => row.agent_id).sort()).toEqual([BABY, CANDY].sort());
  console.info('Demonstrated room-broadcast: agent=@candy woke Candy only; agent=<Baby id> woke Baby only; Earth never woken');
});

it('refuses a Room order naming a non-member, a human or the sender', async () => {
  for (const agent of ['nobody', 'owner', 'jellybean', ' '])
    await expect(daemon.execute('order', { ...authority(), address: ROOM, agent, text: 'Do it' }, JELLYBEAN)).rejects.toThrow('agent');
  expect(await orderWakes()).toEqual([]);
});

it('keeps corner and agent DM orders unchanged', async () => {
  const opened = await daemon.execute('createCorner', { ...authority(), targetRoomId: ROOM, name: 'Widget',
    objective: 'Build the widget', implementer: 'candy',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } }, JELLYBEAN);
  await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [opened.cornerId]);
  await daemon.execute('order', { ...authority(), address: opened.cornerId, text: 'Use the new endpoint' }, JELLYBEAN);
  expect(await orderWakes()).toEqual([{ agent_id: CANDY, room_id: opened.cornerId }]);
  await expect(daemon.execute('order', { ...authority(), address: opened.cornerId, agent: 'baby', text: 'Wrong worker' }, JELLYBEAN))
    .rejects.toThrow("agent must be this corner's implementer");

  const agentDM = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Jellybean and Earth',jsonb_build_array($3::text,$4::text))`, [agentDM, WS, JELLYBEAN, EARTH]);
  for (const agent of [JELLYBEAN, EARTH]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, agentDM, agent]);
  await daemon.execute('order', { ...authority(), address: agentDM, text: 'Research the endpoint' }, JELLYBEAN);
  expect((await orderWakes()).filter(row => row.room_id === agentDM)).toEqual([{ agent_id: EARTH, room_id: agentDM }]);
  expect((await orderWakes()).some(row => row.agent_id === BABY)).toBe(false);
});
