import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const HUMAN = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64),
  OUTSIDER = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Alpha','alpha'),($3,'agent','Beta','beta')`,
    [HUMAN, A, B],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, HUMAN]);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Outsider','outsider')`,
    [OUTSIDER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [OUTSIDER, HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Dispatch')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Dispatch')`, [
    ROOM,
    WORKSPACE,
  ]);
  for (const who of [HUMAN, A, B])
    for (const room of [null, ROOM])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, room, who],
      );
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`,
    [ROOM, A],
  );
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`,
    [ROOM, B],
  );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());

async function input(agent = A) {
  await phone.execute(
    'sendRoomMessage',
    {
      roomId: ROOM,
      messageId: randomBytes(32).toString('hex'),
      text: `${agent === A ? '@alpha' : '@beta'} dispatch this work`,
    },
    HUMAN,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId: ROOM }, agent)).commands.at(
    -1,
  )!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: ROOM, commandId: command.id, generationId: 'g1' },
    agent,
  );
  return {
    repository: 'owner/widgets',
    brief: { spec: 'Dispatch this work', approval: { sourceMessageId: command.sourceMessageId } },
    roomId: ROOM,
    requestId: command.turnRequestId,
    generationId: 'g1',
    idempotencyKey: randomBytes(16).toString('hex'),
    name: 'Dispatch work',
    objective: 'Dispatch this work',
  };
}

it('Reproduction O1-1: naming Beta assigns the work to Beta and keeps Alpha as author', async () => {
  const request = { ...(await input()), implementer: 'beta', hold: true };
  const { cornerId } = await daemon.execute('createCorner', request, A);
  const fact = (
    await db.query(`SELECT owner_agent_id,commissioned_by FROM corner_facts WHERE corner_id=$1`, [
      cornerId,
    ])
  ).rows[0];
  const commands = (
    await db.query(
      `SELECT agent_id FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'`,
      [cornerId],
    )
  ).rows;
  console.log('Reproduction O1-1:', { fact, commands });
  expect(fact).toEqual({ owner_agent_id: B, commissioned_by: HUMAN });
  expect(commands).toEqual([{ agent_id: B }]);
  expect((await daemon.execute('getAgentCommands', { roomId: cornerId }, A)).commands).toEqual([]);
  expect((await db.query(`SELECT created_by FROM rooms WHERE id=$1`, [cornerId])).rows).toEqual([
    { created_by: A },
  ]);
  expect(
    (
      await db.query(
        `SELECT identity_id,role FROM memberships WHERE room_id=$1 AND identity_id=ANY($2) ORDER BY identity_id`,
        [cornerId, [A, B]],
      )
    ).rows,
  ).toEqual([
    { identity_id: A, role: 'member' },
    { identity_id: B, role: 'owner' },
  ]);
  expect(
    (
      await db.query(
        `SELECT author_id,source_message_id FROM corner_brief_revisions WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows,
  ).toEqual([{ author_id: A, source_message_id: request.brief.approval.sourceMessageId }]);
  const card = (
    await db.query(
      `SELECT system_event FROM messages WHERE card->>'type'='corner-open' AND card->>'cornerId'=$1`,
      [cornerId],
    )
  ).rows[0];
  expect(card?.system_event.subject.id).toBe(A);
  const workflow = (await db.query(`SELECT card FROM messages WHERE id=$1`, [cornerId])).rows[0];
  expect(workflow?.card.roleBindings.implementer).toBe(B);
  const beforeReplay = await openingCounts();
  expect(await daemon.execute('createCorner', request, A)).toEqual({ cornerId });
  expect(await openingCounts()).toEqual(beforeReplay);
  await expect(
    daemon.execute('createCorner', { ...request, implementer: 'alpha' }, A),
  ).rejects.toThrow('assignment conflict');
  await expect(
    daemon.execute('createCorner', { ...request, implementer: 'alpha' }, A),
  ).rejects.toThrow('implementer');
  const otherOpener = {
    ...(await input(B)),
    implementer: 'beta',
    idempotencyKey: request.idempotencyKey,
  };
  await expect(daemon.execute('createCorner', otherOpener, B)).rejects.toThrow('opener');
  expect(
    (
      await db.query(
        `SELECT actor_id FROM corner_merge_holds WHERE corner_id=$1 AND released_at IS NULL`,
        [cornerId],
      )
    ).rows,
  ).toEqual([{ actor_id: HUMAN }]);
  expect(
    (
      await db.query(`SELECT count(*)::int count FROM rooms WHERE parent_id=$1 AND id=$2`, [
        ROOM,
        cornerId,
      ])
    ).rows,
  ).toEqual([{ count: 1 }]);
  console.log(
    'Reproduction O1-1 demonstrated: Beta owns and receives the work; Alpha remains author and receives no work command',
  );
}, 30_000);

async function openingCounts() {
  const counts: Record<string, unknown> = {};
  for (const table of [
    'rooms',
    'memberships',
    'corner_facts',
    'corner_brief_revisions',
    'agent_commands',
    'messages',
  ])
    counts[table] = (await db.query(`SELECT count(*) FROM ${table}`)).rows[0];
  return counts;
}

it.each([
  ['outsider', 'current member'],
  ['missing', 'current member'],
  ['ada', 'must be an agent'],
  ['@beta', 'current member'],
  ['Beta', 'current member'],
])('refuses implementer %s without any opening writes', async (implementer, error) => {
  const request = { ...(await input()), implementer };
  const before = await openingCounts();
  await expect(daemon.execute('createCorner', request, A)).rejects.toThrow(error);
  expect(await openingCounts()).toEqual(before);
});

it('refuses a removed parent member without any opening writes', async () => {
  const request = { ...(await input()), implementer: 'beta' };
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    ROOM,
    B,
  ]);
  try {
    const before = await openingCounts();
    await expect(daemon.execute('createCorner', request, A)).rejects.toThrow('current member');
    expect(await openingCounts()).toEqual(before);
  } finally {
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [
      ROOM,
      B,
    ]);
  }
});

it.each([undefined, 'alpha'])('keeps caller assignment for implementer %s', async (implementer) => {
  const request = { ...(await input()), ...(implementer ? { implementer } : {}) };
  const { cornerId } = await daemon.execute('createCorner', request, A);
  expect(
    (await db.query(`SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows,
  ).toEqual([{ owner_agent_id: A }]);
  expect(
    (
      await db.query(
        `SELECT agent_id FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'`,
        [cornerId],
      )
    ).rows,
  ).toEqual([{ agent_id: A }]);
  expect(await daemon.execute('createCorner', { ...request, implementer: 'alpha' }, A)).toEqual({
    cornerId,
  });
});
