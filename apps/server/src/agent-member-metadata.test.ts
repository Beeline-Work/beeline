import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const OWNER = 'a'.repeat(64), JELLYBEAN = 'b'.repeat(64), RUBY = 'c'.repeat(64), NEW = 'd'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
let database: PgliteDatabase;
let service: DaemonService;
beforeAll(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','lunchboxfortwo','lunchboxfortwo'),($2,'agent','Jellybean','jellybean'),
    ($3,'agent','Ruby','ruby'),($4,'agent','New','new')`, [OWNER, JELLYBEAN, RUBY, NEW]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_name) VALUES
    ($2,$1,'squire'),($3,$1,'squire'),($4,$1,NULL)`, [OWNER, JELLYBEAN, RUBY, NEW]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [ROOM, CORNER, WORKSPACE]);
  await database.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [ROOM, CORNER]);
  for (const id of [OWNER, JELLYBEAN, RUBY, NEW]) {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($1,$3,$2,'member') `, [WORKSPACE, id, ROOM]);
  }
  await database.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
    VALUES($1,$2,'presence','presence','{"status":"online","held":true}')`, [ROOM, JELLYBEAN]);
  service = new DaemonService(database, new LiveHub());
}, 30000);
afterAll(async () => database.close());

it('returns owner and host through Room, corner and workspace member operations', async () => {
  const owner = { id: OWNER, handle: 'lunchboxfortwo', name: 'lunchboxfortwo' };
  for (const roomId of [ROOM, CORNER]) {
    const result = await service.execute('listRoomMembers', { roomId }, JELLYBEAN);
    expect(result.members.find(member => member.id === JELLYBEAN)).toEqual({
      id: JELLYBEAN, kind: 'agent', name: 'Jellybean', handle: 'jellybean', role: 'member',
      owner, machine: 'squire', online: true, model: null,
    });
    expect(result.members.find(member => member.id === RUBY)).toEqual({
      id: RUBY, kind: 'agent', name: 'Ruby', handle: 'ruby', role: 'member', owner, machine: 'squire', model: null,
    });
    expect(result.members.find(member => member.id === NEW)).toMatchObject({ owner, machine: null });
    expect(result.members.find(member => member.id === OWNER)).toEqual({
      id: OWNER, kind: 'human', name: 'lunchboxfortwo', handle: 'lunchboxfortwo', role: 'member',
    });
    console.log('Staging fixture listRoomMembers:', JSON.stringify(result));
  }
  const roster = await service.execute('getWorkspaceRoster', { workspaceId: WORKSPACE, agentId: JELLYBEAN }, JELLYBEAN);
  expect(roster.members.find(member => member.identityId === JELLYBEAN)).toMatchObject({ owner, machine: 'squire', online: true });
  expect(roster.members.find(member => member.identityId === NEW)).toMatchObject({ owner, machine: null });
  await database.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [JELLYBEAN]);
  const offline = await service.execute('listRoomMembers', { roomId: ROOM }, JELLYBEAN);
  expect(offline.members.find(member => member.id === JELLYBEAN)).toMatchObject({ machine: 'squire', online: false });
});

it('returns provider quota, billing and parent reviewer roles only to Room members', async () => {
  const usage = { updatedAt: 1000, windows: [{ rateLimitType: 'weekly', status: 'allowed', utilization: 0.25, updatedAt: 1000, resetsAt: 2000 }], plan: 'pro' };
  await database.query(`UPDATE agents SET selected_model='test-model',usage_snapshot=$2::jsonb WHERE agent_id=$1`, [JELLYBEAN, JSON.stringify(usage)]);
  await database.query(`UPDATE agents SET usage_snapshot=$2::jsonb WHERE agent_id=$1`, [RUBY, JSON.stringify({ updatedAt: 1000, windows: [], spend: { today: 0, remaining: 12 } })]);
  await database.query(`UPDATE rooms SET reviewer_agent_id=$2,reviewer_fallback_ids=ARRAY[$3] WHERE id=$1`, [ROOM, RUBY, JELLYBEAN]);
  for (const roomId of [ROOM, CORNER]) {
    const result = await service.execute('listRoomMembers', { roomId }, JELLYBEAN);
    expect(result.members.find(m => m.id === JELLYBEAN)).toMatchObject({ model: 'test-model', billing: 'subscription', reviewer: 'fallback', remainingAllowance: { updatedAt: 1000, windows: [{ rateLimitType: 'weekly', remaining: 0.75, resetsAt: 2000 }] } });
    expect(result.members.find(m => m.id === RUBY)).toMatchObject({ billing: 'pay-per-use', reviewer: 'primary', remainingAllowance: { usd: 12 } });
    expect(result.members.find(m => m.id === NEW)).not.toHaveProperty('remainingAllowance');
  }
  const roster = await service.execute('getWorkspaceRoster', { workspaceId: WORKSPACE, agentId: JELLYBEAN }, JELLYBEAN);
  expect(roster.members.find(m => m.identityId === JELLYBEAN)).not.toHaveProperty('remainingAllowance');
  await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, NEW]);
  try {
    await expect(service.execute('listRoomMembers', { roomId: ROOM }, NEW)).rejects.toThrow();
    await expect(service.execute('listRoomMembers', { roomId: CORNER }, NEW)).rejects.toThrow();
  } finally {
    await database.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [ROOM, NEW]);
  }
});

it('includes a known free token allowance without inventing billing', async () => {
  await database.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'fixture')`, [NEW, WORKSPACE, OWNER]);
  await database.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,(now() AT TIME ZONE 'UTC')::date,123000)`, [OWNER]);
  const result = await service.execute('listRoomMembers', { roomId: ROOM }, JELLYBEAN);
  expect(result.members.find(m => m.id === NEW)).toMatchObject({ remainingAllowance: { tokens: { remaining: 2877000 } } });
  expect(result.members.find(m => m.id === NEW)).not.toHaveProperty('billing');
});
