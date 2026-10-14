import { advanceCorner } from './corner-lifecycle.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { PushDeliveryLoop } from './background.js';
import { createAgentCommand, noteBlockedCornerChecks, readAgentCommands } from './agent-command.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const HUMAN = 'a'.repeat(64),
  RUBY = 'b'.repeat(64),
  WORKER = 'c'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
let order: AgentCommand;
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Captain','captain'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`,
    [HUMAN, RUBY, WORKER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    RUBY,
    WORKER,
    HUMAN,
  ]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Review command proof')`, [WS]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
    VALUES($1,$3,'Target Room',NULL,$4),($2,$3,'Captain and Ruby',jsonb_build_array($4::text,$5::text),$4)`,
    [ROOM, DM, WS, HUMAN, RUBY],
  );
  for (const person of [HUMAN, RUBY, WORKER]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,
      [WS, person, ROOM],
    );
    if (person !== WORKER)
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`,
        [WS, DM, person],
      );
  }
  await phone.execute(
    'sendRoomMessage',
    {
      roomId: DM,
      messageId: randomBytes(32).toString('hex'),
      text: 'Build the widget in the target Room',
    },
    HUMAN,
  );
  order = (await daemon.execute('getAgentCommands', { roomId: DM }, RUBY)).commands[0]!;
  await claim(order);
});
const claim = (command: AgentCommand) =>
  daemon.execute(
    'claimAgentCommand',
    {
      roomId: command.roomId,
      commandId: command.id,
      generationId: 'proof-generation',
    },
    command.agentId,
  );
const authority = (command: AgentCommand) => ({
  roomId: command.roomId,
  requestId: command.turnRequestId,
  generationId: 'proof-generation',
});
const commands = (roomId: string, agentId: string) =>
  readAgentCommands(db, roomId, agentId).then((r) => r.commands);
async function open() {
  return daemon.execute(
    'createCorner',
    {
      ...authority(order),
      requestId: order.turnRequestId,
      targetRoomId: ROOM,
      name: 'Widget',
      objective: 'Build the widget',
      implementer: 'worker',
      brief: { spec: 'Build the widget', approval: { sourceMessageId: order.sourceMessageId } },
    },
    RUBY,
  );
}
async function worker(cornerId: string) {
  const command = (await commands(cornerId, WORKER))[0]!;
  await claim(command);
  return command;
}

it('reports a later corner order to its actual orderer', async () => {
  const opened = await open();
  const OTHER = 'd'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other')`, [
    OTHER,
  ]);
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, ROOM, OTHER],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('second-command',$1,$2,'Follow up')`,
    [ROOM, HUMAN],
  );
  const incoming = (await createAgentCommand(db, {
    roomId: ROOM,
    agentId: OTHER,
    sourceMessageId: 'second-command',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: OTHER,
    id: incoming.id,
  } as unknown as AgentCommand);
  await daemon.execute(
    'order',
    {
      roomId: ROOM,
      requestId: incoming.turn_request_id,
      generationId: 'proof-generation',
      address: opened.cornerId,
      text: 'Other requests a follow-up',
    },
    OTHER,
  );
  const turn = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'order')!;
  await claim(turn);
  await daemon.execute('report', { ...authority(turn), text: 'done: Other follow-up' }, WORKER);
  expect((await commands(DM, RUBY)).some((c) => c.source.body === 'done: Other follow-up')).toBe(
    false,
  );
  expect((await commands(ROOM, OTHER)).some((c) => c.reason === 'report')).toBe(true);
});
it('keeps approval resumes private and reports final prose', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await systemLine(db, {
    roomId: opened.cornerId,
    authorId: WORKER,
    subject: { kind: 'agent', id: WORKER, name: 'Worker' },
    verb: 'received approval',
    kind: 'squire-approval-decided',
    wakes: [WORKER],
    requestId: turn.turnRequestId,
  });
  const resumed = (await commands(opened.cornerId, WORKER)).find((c) => c.action === 'resume')!;
  expect(resumed.private).toBe(true);
  expect(resumed.source.body).toContain('received approval');
  expect(resumed.source.body).toContain('Build the widget');
  await claim(resumed);
  await daemon.execute(
    'postRoomMessage',
    { ...authority(resumed), text: 'PRIVATE COORDINATION LEAK' },
    WORKER,
  );
  expect(
    (await db.query(`SELECT text FROM messages WHERE text='PRIVATE COORDINATION LEAK'`)).rowCount,
  ).toBe(0);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body === 'done: PRIVATE COORDINATION LEAK',
    ),
  ).toBe(true);
});
it('replays private work interrupted by a routine update', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const result = await daemon.execute(
    'postAgentTurnReceipt',
    {
      ...authority(turn),
      agentId: WORKER,
      status: 'failed',
      reason: 'helper update interrupted the turn',
      reasonKind: 'update-interrupted',
    },
    WORKER,
  );
  expect(result.updateRequeued).toBe(true);
  expect(
    (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0],
  ).toMatchObject({ state: 'pending' });
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.startsWith('failed:'),
    ),
  ).toBe(false);
});
it('reports overdue private opening delivery once', async () => {
  const opened = await open();
  await db.query(
    `UPDATE agent_commands SET created_at=now()-interval '10 minutes' WHERE room_id=$1`,
    [opened.cornerId],
  );
  await noteBlockedCornerChecks(db);
  expect((await commands(DM, RUBY)).filter((c) => c.reason === 'report')).toHaveLength(1);
});
it('retains workflow run and attempt guidance in private commands', async () => {
  const opened = await open();
  await systemLine(db, {
    id: 'specific-run-id',
    roomId: opened.cornerId,
    authorId: WORKER,
    subject: { kind: 'agent', id: WORKER, name: 'Worker' },
    verb: 'started',
    object: 'a workflow',
    kind: 'workflow-handoff',
    presentation: 'card',
    cardType: 'workflow-handoff',
    card: {
      runId: 'specific-run-id',
      workflowSlug: 'specific-workflow',
      seq: 1,
      toState: 'build',
      runStatus: 'live',
    },
    wakes: [WORKER],
  });
  const fired = (await commands(opened.cornerId, WORKER)).find(
    (c) => c.reason === 'subscribed_event',
  )!;
  expect(fired.source.body).toContain('specific-run-id');
  expect(fired.source.body).toContain('attempt');
  await claim(fired);
  await systemLine(db, {
    roomId: opened.cornerId,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'approved a credential',
    kind: 'squire-approval-decided',
    requestId: fired.turnRequestId,
    wakes: [WORKER],
  });
  const resumed = (await commands(opened.cornerId, WORKER)).find((c) => c.action === 'resume')!;
  expect(resumed.source.body).toContain('specific-run-id');
  expect(resumed.source.body).toContain('attempt 1');
});
it('opens a sibling when given a corner target', async () => {
  const opened = await open();
  const nested = await daemon.execute(
    'createCorner',
    {
      ...authority(order),
      targetRoomId: opened.cornerId,
      idempotencyKey: 'nested',
      name: 'Nested',
      objective: 'Nested venue',
      brief: { spec: 'Nested work', approval: { sourceMessageId: order.sourceMessageId } },
    },
    RUBY,
  );
  expect(
    (await db.query(`SELECT parent_id FROM rooms WHERE id=$1`, [nested.cornerId])).rows[0],
  ).toMatchObject({ parent_id: ROOM });
});

it('delivers artifacts privately and forwards them in human reports', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at) VALUES($1,$2,'artifact',$3,'text/plain','report.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'report.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await daemon.execute('report', { ...authority(turn), text: 'done: report is attached' }, WORKER);
  await daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'report is attached' },
    WORKER,
  );
  expect(
    (
      await db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await db.query(`SELECT 1 FROM messages WHERE attachments::text LIKE $1`, ['%' + media + '%']))
      .rowCount,
  ).toBe(0);
  const report = (await commands(DM, RUBY)).find((c) => c.reason === 'report')!;
  expect(report.source.attachments).toEqual([expect.objectContaining({ name: 'report.txt' })]);
  await claim(report);
  await daemon.execute('report', { ...authority(report), text: 'done: report is attached' }, RUBY);
  expect(
    (await db.query(`SELECT 1 FROM messages WHERE attachments::text LIKE $1`, ['%' + media + '%']))
      .rowCount,
  ).toBe(1);
});
it('routes zero-check completion through a durable lifecycle fact', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    head = '7'.repeat(40);
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    opened.cornerId,
    JSON.stringify({ checks: 'pending', pr: { number: 21, headSha: head, mergeability: 'clean' } }),
  ]);
  const zero = new DaemonService(
    db,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    async () =>
      ({
        checks: 'pending',
        checkCount: 0,
        headSha: head,
        approved: false,
        held: false,
        mergeAllowed: false,
      }) as any,
  );
  await zero.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Finished zero-check work' },
    WORKER,
  );
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.includes('foreign key constraint'),
    ),
  ).toBe(false);
  expect(
    (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0],
  ).toMatchObject({ state: 'complete' });
  expect(
    (
      await db.query(
        `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='subscribed_event'`,
        [opened.cornerId, RUBY],
      )
    ).rowCount,
  ).toBe(1);
});
it('retries private provider hiccups without escalating', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const result = await daemon.execute(
    'postAgentTurnReceipt',
    {
      ...authority(turn),
      agentId: WORKER,
      status: 'failed',
      reason: 'provider error 429 concurrency_limit',
      reasonKind: 'hiccup',
    },
    WORKER,
  );
  expect(result.hiccupRestart).toBe(true);
  expect(
    (await db.query(`SELECT state,hiccup_attempts FROM agent_commands WHERE id=$1`, [turn.id]))
      .rows[0],
  ).toMatchObject({ state: 'pending', hiccup_attempts: 1 });
});

it('maintains human follows through private orders', async () => {
  const opened = await open(),
    other = 'e'.repeat(64);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Second Person','secondperson')`,
    [other],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, ROOM, other],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('follow-up-person',$1,$2,'@ruby update the widget')`,
    [ROOM, other],
  );
  const incoming = (await createAgentCommand(db, {
    roomId: ROOM,
    agentId: RUBY,
    sourceMessageId: 'follow-up-person',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: RUBY,
    id: incoming.id,
  } as unknown as AgentCommand);
  await daemon.execute(
    'order',
    {
      roomId: ROOM,
      requestId: incoming.turn_request_id,
      generationId: 'proof-generation',
      address: opened.cornerId,
      text: 'Update as the second person asked',
    },
    RUBY,
  );
  expect(
    (
      await db.query(`SELECT 1 FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [
        opened.cornerId,
        other,
      ])
    ).rowCount,
  ).toBe(1);
});

it('resumes the incoming human order for a non-opener watch', async () => {
  const opened = await open();
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('watch-request',$1,$2,'@worker watch the widget')`,
    [ROOM, HUMAN],
  );
  const incoming = (await createAgentCommand(db, {
    roomId: ROOM,
    agentId: WORKER,
    sourceMessageId: 'watch-request',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: WORKER,
    id: incoming.id,
  } as unknown as AgentCommand);
  await daemon.execute(
    'watchCorner',
    { roomId: ROOM, cornerId: opened.cornerId, kinds: ['merged'] },
    WORKER,
  );
  await systemLine(db, { roomId: opened.cornerId, authorId: HUMAN, subject: { kind: 'system', name: 'GitHub' }, verb: 'merged', kind: 'merged' });
  const merged = (await commands(ROOM, WORKER)).find((c) => c.reason === 'watched_corner')!;
  expect(merged.parentCommandId).toBe(incoming.id);
  await claim(merged);
  await expect(
    daemon.execute('report', { ...authority(merged), text: 'done: watched corner merged' }, WORKER),
  ).resolves.toHaveProperty('id');
});

it('rejects stale private workflow wakes after their run ends', async () => {
  const opened = await open(),
    run = randomBytes(32).toString('hex');
  await systemLine(db, {
    id: run,
    roomId: opened.cornerId,
    authorId: WORKER,
    subject: { kind: 'agent', id: WORKER, name: 'Worker' },
    verb: 'started',
    object: 'a workflow',
    kind: 'workflow-handoff',
    presentation: 'card',
    cardType: 'workflow-handoff',
    card: {
      runId: run,
      workflowSlug: 'stale-workflow',
      seq: 0,
      toState: 'build',
      runStatus: 'live',
    },
    wakes: [WORKER],
  });
  const stale = (await commands(opened.cornerId, WORKER)).find(
    (c) => c.reason === 'subscribed_event',
  )!;
  await claim(stale);
  await db.query(`UPDATE messages SET card=card||'{"runStatus":"done"}'::jsonb WHERE id=$1`, [run]);
  await db.query(
    `UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [stale.id],
  );
  expect((await commands(opened.cornerId, WORKER)).some((c) => c.id === stale.id)).toBe(false);
  await expect(claim(stale)).rejects.toThrow('command claim conflict');
  expect(
    (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [stale.id])).rows[0],
  ).toMatchObject({ state: 'cancelled' });
});
it('commits terminal failure when the commander has left', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    DM,
    RUBY,
  ]);
  await db.query(`UPDATE agent_commands SET hiccup_attempts=99 WHERE id=$1`, [turn.id]);
  await expect(
    daemon.execute(
      'postAgentTurnReceipt',
      {
        ...authority(turn),
        agentId: WORKER,
        status: 'failed',
        reason: 'provider outage',
        reasonKind: 'hiccup',
      },
      WORKER,
    ),
  ).resolves.toHaveProperty('id');
  expect(
    (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0],
  ).toMatchObject({ state: 'complete' });
  expect(
    (
      await db.query(
        `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [opened.cornerId, turn.turnRequestId, WORKER],
      )
    ).rows[0],
  ).toMatchObject({ status: 'failed' });
});
it('authorizes a brief revision from the original private order during a check wake', async () => {
  const opened = await open();
  const head = '9'.repeat(40);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    opened.cornerId,
    JSON.stringify({ checks: 'failing', pr: { number: 21, headSha: head } }),
  ]);
  await advanceCorner(db, opened.cornerId, { kind: 'push', contents: { headSha: head } });
  await systemLine(db, {
    roomId: opened.cornerId,
    authorId: WORKER,
    subject: GITHUB_SUBJECT,
    verb: 'failed checks',
    kind: 'check-failed',
  });
  const check = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'corner_check')!;
  await claim(check);
  expect(check.sourceMessageId).toBe(check.id);
  await daemon.execute(
    'reviseCornerBrief',
    {
      ...authority(check),
      cornerId: opened.cornerId,
      expectedRevision: 1,
      brief: {
        spec: 'Build the widget with the necessary CI repair',
        approval: { sourceMessageId: check.sourceMessageId },
        change: 'Repair CI',
      },
    },
    WORKER,
  );
  expect(
    (
      await db.query(
        `SELECT approval_basis->>'snapshot' snapshot FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2`,
        [opened.cornerId],
      )
    ).rows[0],
  ).toMatchObject({ snapshot: 'Build the widget' });
});

it('discovers only reachable member addresses and corners from a DM', async () => {
  const opened = await open();
  const hidden = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Hidden')`, [hidden, WS]);
  const addresses = await daemon.execute('listRooms', { roomId: DM }, RUBY);
  expect(addresses.rooms).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ roomId: ROOM, name: 'Target Room' }),
      expect.objectContaining({ roomId: opened.cornerId, parentRoomId: ROOM }),
    ]),
  );
  expect(addresses.rooms.some((room) => room.roomId === hidden)).toBe(false);
  expect((await daemon.execute('listReachableCorners', { roomId: DM }, RUBY)).corners).toEqual([
    expect.objectContaining({ cornerId: opened.cornerId }),
  ]);
  expect((await daemon.execute('listRoomMembers', { roomId: ROOM }, RUBY)).members).toEqual(
    expect.arrayContaining([expect.objectContaining({ handle: 'worker' })]),
  );
});

it('delivers plain and file-only ACP final replies to older helpers as private reports', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const media = randomUUID();
  await db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','legacy.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'legacy.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await daemon.execute('postRoomMessage', { ...authority(turn), text: '' }, WORKER);
  const returned = (await commands(DM, RUBY)).filter((c) => c.reason === 'report');
  expect(returned).toHaveLength(1);
  expect(returned[0]).toMatchObject({
    private: true,
    source: {
      body: 'done: completed the order',
      attachments: [expect.objectContaining({ name: 'legacy.txt' })],
    },
  });
  expect(
    (
      await db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND presentation='message'`, [
        opened.cornerId,
      ])
    ).rowCount,
  ).toBe(0);
});

it('acknowledges explicit reports so final prose does not send a second report', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await daemon.execute('report', { ...authority(turn), text: 'done: widget tested' }, WORKER);
  await daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'The widget is tested' },
    WORKER,
  );
  expect((await commands(DM, RUBY)).filter((c) => c.reason === 'report')).toHaveLength(1);
});

it('human Room reports with an agent-written mention enter the needs-you tray and push at Attention sensitivity', async () => {
  await db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [HUMAN]);
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment)
    VALUES('commander-device-token-12345678901234567890',$1,'android','physical')`,
    [HUMAN],
  );
  const send = vi.fn(async () => undefined);
  const loop = new PushDeliveryLoop(db, { send });
  await loop.runOnce();
  await phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@ruby decide the scope' },
    HUMAN,
  );
  const incoming = (await commands(ROOM, RUBY)).find((c) => c.reason === 'human_tag')!;
  await claim(incoming);
  const delivered = await daemon.execute(
    'report',
    { ...authority(incoming), ask: 'Which endpoint should we use?', text: 'needs-decision: choose an endpoint @captain' },
    RUBY,
  );
  expect((await phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ messageId: delivered.id })]),
  );
  await loop.runOnce();
  expect(send.mock.calls).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([expect.objectContaining({ messageId: delivered.id })]),
    ]),
  );
});

it('delivers files queued after an explicit report on the final reply', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await daemon.execute(
    'report',
    { ...authority(turn), text: 'done: preparing the artifact' },
    WORKER,
  );
  await db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','late.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'late.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'The artifact is ready' },
    WORKER,
  );
  const reports = (await commands(DM, RUBY)).filter((c) => c.reason === 'report');
  expect(reports).toHaveLength(2);
  expect(reports.at(-1)!.source.attachments).toEqual([
    expect.objectContaining({ name: 'late.txt' }),
  ]);
  expect(
    (
      await db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
});

it('keeps unrelated Room subscriptions independent of completed orders', async () => {
  await daemon.execute(
    'order',
    { ...authority(order), address: ROOM, text: 'One-off Room instruction' },
    RUBY,
  );
  const prior = (await commands(ROOM, WORKER)).find((c) => c.reason === 'order')!;
  await claim(prior);
  await daemon.execute(
    'postRoomMessage',
    { ...authority(prior), text: 'One-off complete' },
    WORKER,
  );
  await systemLine(db, {
    roomId: ROOM,
    authorId: WORKER,
    subject: { kind: 'agent', id: WORKER, name: 'Worker' },
    verb: 'received',
    object: 'an unrelated Room event',
    kind: 'subscription-fired',
    wakes: [WORKER],
    subscriptionPrompt: 'POST IN THE ROOM',
    payload: { text: 'new event' },
  });
  const event = (await commands(ROOM, WORKER)).find((c) => c.reason === 'subscribed_event')!;
  await claim(event);
  await daemon.execute(
    'postRoomMessage',
    { ...authority(event), text: 'Unrelated subscription result' },
    WORKER,
  );
  expect(event.private).not.toBe(true);
  expect(event.parentCommandId).not.toBe(prior.id);
  expect(
    (
      await db.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND text='Unrelated subscription result'`,
        [ROOM],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.includes('Unrelated subscription result'),
    ),
  ).toBe(false);
});
it('refuses retired relay writes on private turns without reporting success', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const r = await daemon
    .execute(
      'postRoomMessage',
      {
        ...authority(turn),
        text: 'Old steer',
        relay: { fromRoomId: opened.cornerId, toRoomId: ROOM, direction: 'down' },
      } as any,
      WORKER,
    )
    .then(
      (v) => ({ ok: true, value: v }),
      (e) => ({ ok: false, status: e.status, message: e.message }),
    );
  expect(r).toMatchObject({ ok: false, status: 410 });
  expect(
    (await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0]?.state,
  ).toBe('claimed');
  expect((await commands(DM, RUBY)).some((c) => c.reason === 'report')).toBe(false);
});
it('keeps the originating corner waiting for a decision returned to its parent Room', async () => {
  await phone.execute(
    'sendRoomMessage',
    {
      roomId: ROOM,
      messageId: randomBytes(32).toString('hex'),
      text: '@ruby open a corner and choose endpoint',
    },
    HUMAN,
  );
  const incoming = (await commands(ROOM, RUBY)).find((c) => c.reason === 'human_tag')!;
  await claim(incoming);
  const opened = await daemon.execute(
    'createCorner',
    {
      ...authority(incoming),
      targetRoomId: ROOM,
      name: 'Endpoint',
      objective: 'Choose endpoint',
      implementer: 'worker',
      brief: { spec: 'Choose endpoint', approval: { sourceMessageId: incoming.sourceMessageId } },
    },
    RUBY,
  );
  const turn = await worker(opened.cornerId);
  await daemon.execute(
    'report',
    { ...authority(turn), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint' },
    WORKER,
  );
  const returned = (await commands(ROOM, RUBY)).find((c) => c.reason === 'report')!;
  await claim(returned);
  await daemon.execute(
    'report',
    { ...authority(returned), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint @captain' },
    RUBY,
  );
  expect(
    (await db.query(`SELECT 1 FROM corner_owed WHERE corner_id=$1`, [opened.cornerId])).rowCount,
  ).toBe(1);
  await daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Reported the decision' },
    WORKER,
  );
  const state = async () =>
    (await phone.readCorners(ROOM, HUMAN))?.corners.find(
      (item) => item.corner.id === opened.cornerId,
    )?.state;
  expect(await state()).toBe('waiting');
  await db.query('SELECT corner_owed_refresh($1,$2)', [opened.cornerId, HUMAN]);
  expect(await state()).toBe('waiting');
  await phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: 'Use endpoint v2' },
    HUMAN,
  );
  expect(
    (await db.query(`SELECT 1 FROM corner_owed WHERE corner_id=$1`, [opened.cornerId])).rowCount,
  ).toBe(0);
  expect(await state()).toBe('idle');
  await db.query('SELECT corner_owed_refresh($1,$2)', [opened.cornerId, HUMAN]);
  expect(await state()).toBe('idle');
  await db.query(
    `UPDATE messages SET deleted_at=now() WHERE room_id=$1 AND text IN ('Use endpoint v2','@ruby Use endpoint v2')`,
    [ROOM],
  );
  expect(await state()).toBe('waiting');
});

it('keeps DM-returned decisions indexed until answered or source membership ends', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await daemon.execute(
    'report',
    { ...authority(turn), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint' },
    WORKER,
  );
  await daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Reported the decision' },
    WORKER,
  );
  const returned = (await commands(DM, RUBY)).find((c) => c.reason === 'report')!;
  await claim(returned);
  await daemon.execute(
    'report',
    { ...authority(returned), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint @captain' },
    RUBY,
  );
  expect((await phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(true);
  await db.query('SELECT corner_owed_refresh($1,$2)', [opened.cornerId, HUMAN]);
  expect((await phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(true);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    DM,
    HUMAN,
  ]);
  expect((await phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(false);
  await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [
    DM,
    HUMAN,
  ]);
  expect((await phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(true);
});
