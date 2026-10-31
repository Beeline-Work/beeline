import { flushDueCommanderWakes } from './commander-wakes.js';
import { advanceCorner } from './corner-lifecycle.js';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { MemoryObjectStorage, PgliteDatabase } from './test-support.js';
import { ObjectService } from './object-service.js';
import { callAgentTool, postArtifact } from '../../body/src/read-only-mcp.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { PushDeliveryLoop } from './background.js';
import { createAgentCommand, noteBlockedCornerChecks, readAgentCommands } from './agent-command.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';

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
  await db.query('UPDATE agents SET wake_batch_minutes=0');
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
const commands = async (roomId: string, agentId: string) => {
  await db.query(`UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL`);
  await flushDueCommanderWakes(db);
  return (await readAgentCommands(db, roomId, agentId)).commands;
};
async function open(name = 'Widget') {
  return daemon.execute(
    'createCorner',
    {
      ...authority(order),
      requestId: order.turnRequestId,
      targetRoomId: ROOM,
      name,
      ...(name !== 'Widget' ? { idempotencyKey: name } : {}),
      objective: 'Build the widget',
      implementer: 'worker',
      brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
    },
    RUBY,
  );
}
async function worker(cornerId: string) {
  const command = (await commands(cornerId, WORKER))[0]!;
  await claim(command);
  return command;
}

it.each(['report', 'postRoomMessage'] as const)('Reproduction FILE-HANDOFF: batched reports retain every file through %s', async (delivery) => {
  await daemon.execute('setWakeDelivery', { roomId: DM, delivery: 'batch:1' }, RUBY);
  const objects = new ObjectService(db, new MemoryObjectStorage(), 'http://test');
  const attachments = [];
  const turns = [];
  // Both workers finish before the commander consumes the batched wake.
  for (const name of ['first.txt', 'second.txt']) {
    const opened = await open(name);
    const turn = await worker(opened.cornerId);
    const bytes = Buffer.from(`${delivery}:${name}`);
    const uploaded = await objects.uploadArtifact(WORKER, bytes, 'text/plain', name);
    const attachment = { url: uploaded.url, name, mimeType: 'text/plain', size: bytes.length };
    attachments.push(attachment);
    await daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER);
    turns.push(turn);
  }
  for (const [index, turn] of turns.entries()) {
    await daemon.execute('report', { ...authority(turn), status: 'done', text: `done: attached ${attachments[index]!.name}` }, WORKER);
  }
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.source.attachments).toEqual(attachments);
  await claim(report);
  if (delivery === 'report') {
    await daemon.execute('report', { ...authority(report), status: 'done', text: 'done: first.txt and second.txt attached' }, RUBY);
  } else {
    await daemon.execute('postRoomMessage', { ...authority(report), text: 'first.txt and second.txt attached' }, RUBY);
  }
  const visible = (await phone.readRoom(DM, HUMAN))!.messages.filter(message => message.attachments?.length);
  expect(visible).toHaveLength(1);
  expect(visible[0]!.attachments).toEqual(attachments.map(attachment => expect.objectContaining(attachment)));
  const readable = await daemon.execute('getRoomMessage', { roomId: DM, messageId: visible[0]!.id }, RUBY);
  expect(readable.attachments).toEqual(attachments.map(attachment => expect.objectContaining(attachment)));
  for (const attachment of readable.attachments) {
    const mediaId = attachment.url.split('/').at(-1)!;
    expect(Buffer.from((await objects.readOwnedBytes(WORKER, mediaId))!).toString()).toBe(`${delivery}:${attachment.name}`);
  }
});

it.each(['report', 'postRoomMessage'] as const)('Reproduction FILE-HANDOFF: %s keeps batched files on their own commander route', async delivery => {
  const objects = new ObjectService(db, new MemoryObjectStorage(), 'http://test');
  const commanders = ['12'.repeat(32), '13'.repeat(32)];
  const incoming = [];
  for (const commander of commanders) {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Commander') ON CONFLICT DO NOTHING`, [commander]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [commander, HUMAN]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, commander]);
    const parent = (await createAgentCommand(db, {
      roomId: ROOM, agentId: RUBY, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: commander, fromRoomId: ROOM, text: 'Prepare my file' },
    }))!;
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [parent.id]);
    const name = `${commander.slice(0, 2)}.txt`;
    // Distinct objects with identical bytes also exercise deduplication after routing.
    const uploaded = await objects.uploadArtifact(commander, Buffer.from(`private-${delivery}`), 'text/plain', name);
    incoming.push({ parent, attachment: { url: uploaded.url, name, mimeType: 'text/plain', size: Buffer.byteLength(`private-${delivery}`) } });
  }
  await daemon.execute('setWakeDelivery', { roomId: DM, delivery: 'batch:1' }, RUBY);
  for (const { parent, attachment } of incoming) {
    await createAgentCommand(db, {
      roomId: ROOM, agentId: RUBY, sourceMessageId: null, reason: 'report', parent, retainDepth: true,
      privatePayload: { kind: 'report', authorId: WORKER, fromRoomId: ROOM, text: 'done: file ready', attachments: [attachment] },
    });
  }
  const batched = (await commands(ROOM, RUBY)).find(command => command.reason === 'report')!;
  expect(batched.source.attachments).toHaveLength(2);
  await claim(batched);
  if (delivery === 'report') {
    await daemon.execute('report', { ...authority(batched), status: 'done', text: 'done: files attached' }, RUBY);
  } else {
    await daemon.execute('postRoomMessage', { ...authority(batched), text: 'Files attached' }, RUBY);
  }
  for (const [index, commander] of commanders.entries()) {
    const delivered = (await commands(ROOM, commander)).find(command => command.reason === 'report')!;
    expect(delivered.source.attachments).toEqual([incoming[index]!.attachment]);
    const read = await daemon.execute('getRoomMessage', { roomId: ROOM, messageId: delivered.id }, commander);
    expect(read.attachments).toEqual([expect.objectContaining(incoming[index]!.attachment)]);
    await expect(daemon.execute('getRoomMessage', { roomId: ROOM, messageId: delivered.id }, commanders[1 - index]!))
      .rejects.toThrow('message access denied');
  }
});

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
  await daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: Other follow-up' }, WORKER);
  expect((await commands(DM, RUBY)).some((c) => c.source.body === 'done: Other follow-up')).toBe(
    false,
  );
  expect((await commands(ROOM, OTHER)).some((c) => c.reason === 'report')).toBe(true);
});
it('keeps approval resume provenance and posts progress only in the corner', async () => {
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
  ).toBe(1);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body === 'done: PRIVATE COORDINATION LEAK',
    ),
  ).toBe(false);
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
  await daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: report is attached' }, WORKER);
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
  await daemon.execute('report', { status: 'done', ...authority(report), text: 'done: report is attached' }, RUBY);
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
        zeroChecksConfirmed: true,
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
  await zero.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
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
    daemon.execute('report', { status: 'done', ...authority(merged), text: 'done: watched corner merged' }, WORKER),
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
it.each([false, true])('the commander revises from its DM after a check wake (cited approval: %s)', async citedApproval => {
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
  expect(check.rootSourceMessageId).toBe(order.rootSourceMessageId);
  const stored = (await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY)).brief!;
  await daemon.execute(
    'reviseCornerBrief',
    {
      ...authority(order),
      cornerId: opened.cornerId,
      expectedRevision: 1,
      brief: {
        spec: 'Build the widget with the necessary CI repair',
        ...(citedApproval ? { approval: { sourceMessageId: stored.approval!.sourceMessageId } } : {}),
        change: 'Repair CI',
      },
    },
    RUBY,
  );
  expect(
    (
      await db.query(
        `SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2`,
        [opened.cornerId],
      )
    ).rows[0],
  ).toMatchObject({
    approval_basis: citedApproval ? {
      kind: 'initiating-command',
      approvedBy: HUMAN,
      sourceMessageId: stored.approval!.sourceMessageId,
      snapshot: 'Build the widget in the target Room',
    } : {
      kind: 'commander-direct',
      approvedBy: RUBY,
      sourceMessageId: '',
      snapshot: 'Commander revised the corner brief directly',
    },
  });
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

it('keeps file-only corner final replies in the corner without reporting progress', async () => {
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
  expect(returned).toHaveLength(0);
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
  ).toBe(1);
});

it('acknowledges explicit reports so final prose does not send a second report', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: widget tested' }, WORKER);
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
    { status: 'needs_decision', ...authority(incoming), ask: 'Which endpoint should we use?', text: 'needs-decision: choose an endpoint @captain' },
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

it('keeps files queued after an explicit report on the corner final reply', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await daemon.execute(
    'report',
    { status: 'done', ...authority(turn), text: 'done: preparing the artifact' },
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
  expect(reports).toHaveLength(1);
  expect((await phone.readRoom(opened.cornerId, HUMAN))?.messages.some(message =>
    message.attachments?.some(attachment => attachment.name === 'late.txt'))).toBe(true);
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
    { ...authority(order), address: ROOM, agent: WORKER, text: 'One-off Room instruction' },
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
    { status: 'needs_decision', ...authority(turn), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint' },
    WORKER,
  );
  const returned = (await commands(ROOM, RUBY)).find((c) => c.reason === 'report')!;
  await claim(returned);
  await daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(returned), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint @captain' },
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
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
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
    { status: 'needs_decision', ...authority(turn), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint' },
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
    { status: 'needs_decision', ...authority(returned), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint @captain' },
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

it('R1 carries a closed corner artifact into a successor brief and refuses private archived sources', async () => {
  const source = (await phone.execute('createHumanCorner', { roomId: ROOM, title: 'Source-evidence' }, HUMAN)) as { id: string };
  await phone.execute('sendRoomMessage', { roomId: source.id, messageId: randomBytes(32).toString('hex'), text: '@worker record evidence' }, HUMAN);
  const turn = await worker(source.id);
  const bytes = Buffer.from('R1 evidence');
  const objects = new ObjectService(db, new MemoryObjectStorage(), 'http://test');
  await postArtifact({ bytes: bytes.toString('base64'), title: 'evidence.txt', mime: 'text/plain' }, {
    roomId: source.id, roots: [],
    upload: (content, mime, title) => objects.uploadArtifact(WORKER, content, mime, title),
    queue: async (attachment) => { await daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER); },
  });
  const media = (await db.query<{ id: string }>(`SELECT id FROM objects WHERE title='evidence.txt' AND owner_id=$1`, [WORKER])).rows[0]!.id;
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'Evidence recorded' }, WORKER);
  const message = (await db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND text='Evidence recorded'`, [source.id])).rows[0]!;
  expect((await daemon.execute('getRoomMessage', { roomId: source.id, messageId: message.id }, WORKER)).attachments)
    .toEqual([expect.objectContaining({ name: 'evidence.txt' })]);
  await daemon.execute('archiveCorner', { ...authority(order), cornerId: source.id }, RUBY);
  expect((await daemon.execute('getRoomMessage', { ...authority(order), messageId: message.id }, RUBY)).attachments)
    .toEqual([expect.objectContaining({ name: 'evidence.txt' })]);
  // An archived corner in another Room remains unavailable even when its
  // object id is known to the caller.
  const privateRoom = randomUUID(), privateCorner = randomUUID(), privateMedia = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by,archived_at)
    VALUES($1,$3,'Private-room',NULL,$4,NULL),($2,$3,'Private-source',$1,$4,now())`,
    [privateRoom, privateCorner, WS, HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'member'),($1,$2,$4,'member') `,
    [WS, privateRoom, HUMAN, WORKER]);
  await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','private.txt',2,$4,'ready',now()+interval '24 hours')`,
    [privateMedia, WORKER, 'artifact/' + privateMedia, randomBytes(32).toString('hex')]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments)
    VALUES($1,$2,$3,'Private evidence',$4::jsonb)`, [randomBytes(32).toString('hex'), privateCorner, WORKER,
    JSON.stringify([{ url: 'http://test/v1/media/' + privateMedia, name: 'private.txt' }])]);
  const tryPrivate = () => daemon.execute('createCorner', {
    ...authority(order), idempotencyKey: 'private-source-proof', targetRoomId: ROOM, name: 'Refused-successor', objective: 'Continue from evidence', implementer: 'worker',
    brief: { spec: 'Read private evidence', repositoryWork: false,
      approval: { sourceMessageId: order.sourceMessageId },
      attachments: [{ objectId: privateMedia, purpose: 'Private evidence', required: true }] },
  }, RUBY);
  await expect(tryPrivate()).rejects.toThrow('missing or unavailable in this Room');
  // Even if the commander is a member, a successor audience without access
  // cannot receive the file. The human requester is also checked.
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'member') `, [WS, privateRoom, RUBY]);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [privateRoom, HUMAN]);
  await expect(tryPrivate()).rejects.toThrow('missing or unavailable in this Room');
  await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [privateRoom, HUMAN]);
  const outsider = 'f'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader')`, [outsider]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, outsider]);
  await expect(tryPrivate()).rejects.toThrow('missing or unavailable in this Room');
  await db.query(`DELETE FROM memberships WHERE identity_id=$1`, [outsider]);
  const remoteSuccessor = await tryPrivate();
  const remoteBrief = await daemon.execute('listCornerBriefRevisions', { ...authority(order), cornerId: remoteSuccessor.cornerId, limit: 1 }, RUBY);
  expect(remoteBrief.revisions[0]!.attachments).toEqual([expect.objectContaining({ objectId: privateMedia })]);
  const successor = await daemon.execute('createCorner', {
    ...authority(order), targetRoomId: ROOM, name: 'Successor-evidence', objective: 'Continue from evidence', implementer: 'worker',
    brief: { spec: 'Read the source evidence', repositoryWork: false,
      approval: { sourceMessageId: order.sourceMessageId },
      attachments: [{ objectId: media, purpose: 'Source evidence', required: true }] },
  }, RUBY);
  const next = await worker(successor.cornerId);
  const brief = await daemon.execute('listCornerBriefRevisions', { ...authority(next), cornerId: successor.cornerId, limit: 1 }, WORKER);
  expect(brief.revisions[0]!.attachments).toEqual([expect.objectContaining({ objectId: media, title: 'evidence.txt' })]);
  // Drive the actual read tool through a loopback transport to the service,
  // then verify the downloaded file, rather than just manifest metadata.
  const scratch = await mkdtemp(join(tmpdir(), 'beeline-r1-'));
  const bridge = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/daemon/operations/listCornerBriefRevisions' || request.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const result = await daemon.execute(request.url.endsWith('getRoomMessage') ? 'getRoomMessage' : 'listCornerBriefRevisions', input, WORKER);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } else if (request.url === '/v1/media/' + media) {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(await objects.readOwnedBytes(WORKER, media));
      } else response.writeHead(404).end();
    } catch (error) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  try {
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing proof port');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', successor.cornerId);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', successor.cornerId);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', scratch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const downloaded = JSON.parse(await callAgentTool('read', { facet: 'attachment', attachmentId: media }, 'r1'));
    expect(await readFile(downloaded.path)).toEqual(bytes);
    await expect(callAgentTool('read', { facet: 'attachment', attachmentId: privateMedia }, 'unattached')).rejects.toThrow('not_found');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', source.id);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', source.id);
    const ownMessage = JSON.parse(await callAgentTool('read', { facet: 'attachment', messageId: message.id, attachmentId: media }, 'own-message'));
    expect(await readFile(ownMessage.path)).toEqual(bytes);
    // The file remains readable through its brief after its message no longer carries it.
    await db.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id=$1`, [message.id]);
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', ROOM);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    const pinnedOnly = JSON.parse(await callAgentTool('read', { facet: 'attachment', attachmentId: media }, 'pinned-only'));
    expect(await readFile(pinnedOnly.path)).toEqual(bytes);
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});

// Reproduction commander-files: the commander's open_corner, revise_corner and
// order tools run in-process against the daemon service; the worker then reads
// the brief file with its own read tool.
it('Reproduction commander-files: a commander home file reaches the worker as the same bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-home-'));
  const workerHome = await mkdtemp(join(tmpdir(), 'worker-home-'));
  const trace = join(home, 'trace.csv');
  const bytes = Buffer.from('at,step\n1,open\n2,fail\n');
  await writeFile(trace, bytes);
  await writeFile(join(home, 'turn.json'), JSON.stringify(authority(order)));
  const objects = new ObjectService(db, new MemoryObjectStorage(), 'http://test');
  let caller = RUBY;
  const bridge = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = request.url ?? '';
      let result: unknown;
      if (url === '/v1/daemon/artifacts') {
        result = await objects.uploadArtifact(caller, body, String(request.headers['content-type']),
          decodeURIComponent(String(request.headers['x-artifact-title'])));
      } else if (url.startsWith('/v1/media/')) {
        const owned = await objects.readOwnedBytes(RUBY, url.slice('/v1/media/'.length));
        response.writeHead(200, { 'content-type': 'text/csv' }).end(owned);
        return;
      } else if (url.startsWith('/v1/daemon/operations/')) {
        result = await daemon.execute(url.slice('/v1/daemon/operations/'.length) as never, JSON.parse(body.toString()) as never, caller);
      } else throw new Error('unexpected proof route');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  const openCorner = (name: string, brief: object) => callAgentTool('open_corner', {
    room: ROOM, name, objective: 'Find the failing step', implementer: 'worker',
    brief: { repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId }, ...brief },
  }, name);
  const cornerCount = async () => Number((await db.query<{ count: string }>(
    `SELECT count(*) FROM rooms WHERE parent_id=$1`, [ROOM])).rows[0]!.count);
  try {
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const port = (bridge.address() as { port: number }).port;
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', DM);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    vi.stubEnv('BEELINE_ATTACH_ROOT', home);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', home);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', join(home, 'turn.json'));
    const before = await cornerCount();
    // A brief that names the private file without attaching it is refused by name.
    await expect(openCorner('Named-only', { spec: `Read ${trace} and find the failing step.` }))
      .rejects.toThrow(`the brief names ${trace}, which only you can open`);
    // Quoted filenames and missing home files must never silently reach a worker.
    const spaced = join(home, 'trace data.csv');
    await writeFile(spaced, bytes);
    for (const named of [`"${spaced}"`, `'${spaced}'`, `\`${spaced}\``, join(home, 'missing.csv'), `"${join(home, 'missing trace.csv')}"`]) {
      const path = named.replace(/^["'`]|["'`]$/g, '');
      await expect(openCorner('Private-path', { spec: `Read ${named}` }))
        .rejects.toThrow(`the brief names ${path}, which only you can open`);
      await expect(callAgentTool('order', { address: ROOM, agent: 'worker', text: `Read ${named}` }, 'order-private'))
        .rejects.toThrow(`the order names ${path}, which recipients cannot open`);
    }
    // A path that cannot be read is refused by name.
    await expect(openCorner('Missing-file', { spec: 'Read the trace.', attachments: [
      { path: join(home, 'gone.csv'), purpose: 'Failing trace', required: true }] }))
      .rejects.toThrow(`brief attachment ${join(home, 'gone.csv')} cannot be delivered`);
    expect(await cornerCount()).toBe(before);
    // An order that names the private file is refused by name.
    await expect(callAgentTool('order', { address: ROOM, agent: 'worker', text: `Read ${trace}` }, 'order-named'))
      .rejects.toThrow(`the order names ${trace}, which recipients cannot open`);
    const opened = JSON.parse(await openCorner('Attached-trace', { spec: `Read "${spaced}" and find the failing step.`,
      attachments: [{ path: spaced, purpose: 'Failing trace', required: true }] }));
    const next = await worker(opened.address);
    const brief = await daemon.execute('listCornerBriefRevisions', { ...authority(next), cornerId: opened.address, limit: 1 }, WORKER);
    const [file] = brief.revisions[0]!.attachments;
    expect(file).toMatchObject({ title: 'trace data.csv', mime: 'text/csv', required: true,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    // The worker opens the brief file with its own read tool.
    caller = WORKER;
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', opened.address);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', opened.address);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', workerHome);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const downloaded = JSON.parse(await callAgentTool('read', { facet: 'attachment', attachmentId: file!.objectId }, 'worker-read'));
    expect(await readFile(downloaded.path)).toEqual(bytes);
    console.info(`Demonstrated commander-files: worker read ${downloaded.path} (${bytes.length} bytes, same sha256)`);
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(workerHome, { recursive: true, force: true });
  }
});

// Reproduction duplicate-artifact: worker report -> commander upload -> human DM.
for (const delivery of ['report', 'postRoomMessage'] as const) {
  it(`delivers identical carried and uploaded artifacts once through ${delivery}`, async () => {
    const opened = await open();
    const turn = await worker(opened.cornerId);
    const original = randomUUID(), copy = randomUUID();
    await db.query(`DELETE FROM objects WHERE sha256=$1`, ['c97fb129a60faa9cdb824abfecf20b2dbcc3e1b8b8c8b590c61e3238a6db282b']);
    const hash = 'c97fb129a60faa9cdb824abfecf20b2dbcc3e1b8b8c8b590c61e3238a6db282b';
    const attachment = (id: string, name: string) => ({
      url: 'http://test/v1/media/' + id, name, mimeType: 'text/html', size: 11867,
    });
    for (const [id, owner] of [[original, WORKER], [copy, RUBY]]) {
      await db.query(
        `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
         VALUES($1,$2,'artifact',$3,'text/html','design',11867,$4,'ready',now()+interval '24 hours')`,
        [id, owner, 'artifact/' + id, hash]);
    }
    await daemon.execute('postAgentAttachment', {
      ...authority(turn), attachment: attachment(original, 'owner approval'),
    }, WORKER);
    await daemon.execute('report', {
      ...authority(turn), status: 'done', text: 'done: design ready',
    }, WORKER);
    const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
    await claim(report);
    await daemon.execute('postAgentAttachment', {
      ...authority(report), attachment: attachment(copy, 'design for approval'),
    }, RUBY);
    if (delivery === 'report') {
      await daemon.execute('report', {
        ...authority(report), status: 'done', text: 'done: design attached',
      }, RUBY);
    } else {
      await daemon.execute('postRoomMessage', {
        ...authority(report), text: 'Here is the design',
      }, RUBY);
    }
    const visible = (await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.attachments?.length);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.attachments).toEqual([expect.objectContaining({
      url: 'http://test/v1/media/' + original, name: 'owner approval',
    })]);
    expect((await db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`,
      [report.turnRequestId])).rowCount).toBe(0);
  });
}

it('Reproduction R-ID: supplied private report and order ids reopen their payloads and refuse other readers', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const read = (messageId: string, agent = WORKER, roomId = opened.cornerId) =>
    daemon.execute('getRoomMessage', { roomId, messageId }, agent);
  expect(await read(turn.id)).toMatchObject({ body: expect.stringContaining('Build the widget') });
  await expect(read(turn.id, RUBY, ROOM)).resolves.toBeDefined();
  const uploaded = await new ObjectService(db, new MemoryObjectStorage(), 'http://test')
    .uploadArtifact(WORKER, Buffer.from('Synthetic handoff'), 'text/plain', 'handoff.txt');
  const attachment = { url: uploaded.url, name: 'handoff.txt', mimeType: 'text/plain', size: Buffer.byteLength('Synthetic handoff') };
  await daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER);
  const report = await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: evidence ready' }, WORKER);
  expect(await read(report.id, RUBY, DM)).toMatchObject({ body: 'done: evidence ready', attachments: [expect.objectContaining({ name: 'handoff.txt' })] });
  expect(await read(report.id)).toMatchObject({ body: 'done: evidence ready' });
  // Continuations retain private payloads and expose their own command ids.
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{kind}','\"lifecycle\"'::jsonb) WHERE id=$1`, [report.id]);
  expect(await read(report.id, RUBY, DM)).toMatchObject({ body: 'done: evidence ready' });
  // A current Room member who is neither sender nor recipient cannot see it.
  const outsider = 'e'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Observer') ON CONFLICT DO NOTHING`, [outsider]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, outsider]);
  await expect(read(report.id, outsider, ROOM)).rejects.toThrow('message access denied');
  await expect(read(turn.id, outsider, ROOM)).rejects.toThrow('message access denied');
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [DM, RUBY]);
  await expect(read(report.id, RUBY, ROOM)).rejects.toThrow('message access denied');
});

it('Reproduction R-ID: an order card id returns the expanded text and archived sibling messages retain read access', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Build the widget from evidence' }, RUBY);
  const card = (await db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type='agent-command'`, [opened.cornerId])).rows[0]!;
  expect(await daemon.execute('getRoomMessage', { ...authority(turn), messageId: card.id }, WORKER))
    .toMatchObject({ body: expect.stringContaining('Build the widget') });
  const sibling = await open();
  const messageId = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Archived evidence')`, [messageId, opened.cornerId, WORKER]);
  await daemon.execute('archiveCorner', { ...authority(order), cornerId: opened.cornerId }, RUBY);
  expect(await daemon.execute('getRoomMessage', { ...authority(order), messageId }, RUBY))
    .toMatchObject({ body: 'Archived evidence' });
  expect(await daemon.execute('getRoomMessage', { roomId: sibling.cornerId, messageId }, WORKER))
    .toMatchObject({ body: 'Archived evidence' });
});

it('Reproduction R-ID2: archived activity and readable prefixes resolve without exposing inaccessible candidates', async () => {
  const opened = await open();
  const sibling = await open();
  const prefix = randomBytes(12).toString('hex');
  const activity = prefix + 'a'.repeat(40);
  const person = prefix + 'b'.repeat(40);
  const hidden = prefix + 'c'.repeat(40);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES
    ($1,$4,$6,'Archived activity','activity'),($2,$4,$7,'Person evidence','message'),
    ($3,$5,$7,'Private evidence','message')`, [activity, person, hidden, opened.cornerId, DM, WORKER, HUMAN]);
  await daemon.execute('archiveCorner', { ...authority(order), cornerId: opened.cornerId }, RUBY);
  const read = (messageId: string) => daemon.execute('getRoomMessage', { roomId: sibling.cornerId, messageId }, WORKER);
  expect(await read(activity)).toMatchObject({ messageId: activity, body: 'Archived activity' });
  expect(await read(person.slice(0, 25))).toMatchObject({ messageId: person, body: 'Person evidence' });
  expect(await daemon.execute('getRoomMessage', { ...authority(order), messageId: activity }, RUBY))
    .toMatchObject({ messageId: activity, body: 'Archived activity' });
  expect(await daemon.execute('getRoomMessage', { ...authority(order), messageId: person.slice(0, 25) }, RUBY))
    .toMatchObject({ messageId: person, body: 'Person evidence' });
  await expect(read(prefix + '%')).rejects.toThrow('message not found');
  expect(await read(activity.slice(0, 25))).toMatchObject({ messageId: activity, body: 'Archived activity' });
  await expect(read(prefix)).rejects.toThrow(`ambiguous message id: ${activity}, ${person}`);
  await expect(read(hidden)).rejects.toThrow('message access denied');
  await expect(read(hidden.slice(0, 25))).rejects.toThrow('message not found');
});

it('Reproduction R-ID: the read tool downloads bytes from a private report hand-off', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const bytes = Buffer.from('Synthetic private report attachment');
  const uploaded = await new ObjectService(db, new MemoryObjectStorage(), 'http://test')
    .uploadArtifact(WORKER, bytes, 'text/plain', 'report-evidence.txt');
  const media = uploaded.url.split('/').at(-1)!;
  await daemon.execute('postAgentAttachment', { ...authority(turn), attachment: {
    url: uploaded.url, name: 'report-evidence.txt', mimeType: 'text/plain', size: bytes.length,
  } }, WORKER);
  const report = await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: evidence attached' }, WORKER);
  const scratch = await mkdtemp(join(tmpdir(), 'beeline-read-id-'));
  const bridge = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await daemon.execute('getRoomMessage', JSON.parse(Buffer.concat(chunks).toString()), RUBY);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } else if (request.url === '/v1/media/' + media) {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(bytes);
      } else response.writeHead(404).end();
    } catch (error) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  try {
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing proof port');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', opened.cornerId);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', opened.cornerId);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', scratch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const message = JSON.parse(await callAgentTool('read', { facet: 'message', messageId: report.id }, 'read-report'));
    expect(message.body).toBe('done: evidence attached');
    const downloaded = JSON.parse(await callAgentTool('read', { facet: 'attachment', messageId: report.id, attachmentId: media }, 'read-report-file'));
    expect(await readFile(downloaded.path)).toEqual(bytes);
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});


it.each(['success', 'failure', 'replacement'])('Reproduction ARTIFACT-REPORT: shipped MCP waits for upload %s before reporting', async (outcome) => {
  const scratch = await mkdtemp(join(tmpdir(), 'artifact-report-proof-'));
  await writeFile(join(scratch, 'turn.json'), JSON.stringify(authority(order)));
  await writeFile(join(scratch, 'evidence.txt'), 'Artifact report evidence');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const uploading = new Promise<void>(resolve => { started = resolve; });
  const objects = new ObjectService(db, new MemoryObjectStorage(), 'http://test');
  let reportCalls = 0;
  let uploadAttempts = 0;
  const bridge = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let result: unknown;
      if (request.url === '/v1/daemon/artifacts') {
        started(); await held;
        if (outcome === 'failure' || (outcome === 'replacement' && uploadAttempts++ === 0)) {
          response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'storage_unavailable' }));
          return;
        }
        result = await objects.uploadArtifact(RUBY, body, 'text/plain', 'evidence.txt');
      } else if (request.url === '/v1/daemon/operations/postAgentAttachment') {
        result = await daemon.execute('postAgentAttachment', JSON.parse(body.toString()), RUBY);
      } else if (request.url === '/v1/daemon/operations/report') {
        reportCalls++;
        result = await daemon.execute('report', JSON.parse(body.toString()), RUBY);
      } else throw new Error('unexpected proof route');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const port = (bridge.address() as { port: number }).port;
  const child = spawn(process.execPath, [new URL('../../body/dist/read-only-mcp.js', import.meta.url).pathname], {
    env: { ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${port}`,
      BEELINE_DAEMON_TOKEN: 'isolated-proof', BEELINE_DAEMON_ROOM_ID: DM, BEELINE_DAEMON_CORNER_ID: '',
      BEELINE_ATTACH_ROOT: scratch, BEELINE_TURN_CONTEXT_FILE: join(scratch, 'turn.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  type ToolResult = { isError?: boolean; content: { text: string }[] };
  const pending = new Map<number, (result: ToolResult) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response.result);
  });
  const call = (id: number, name: string, args: object) => new Promise<ToolResult>(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  try {
    const upload = call(1, 'post_artifact', { path: join(scratch, 'evidence.txt') });
    await uploading;
    const report = call(2, 'report', { status: 'done', text: 'done: evidence attached' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const sentEarly = reportCalls > 0;
    release();
    const [uploaded, reported] = await Promise.all([upload, report]);
    expect(sentEarly).toBe(false);
    if (outcome === 'failure') {
      expect(uploaded.isError).toBe(true);
      expect(reported).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('storage_unavailable') }] });
      expect(reportCalls).toBe(0);
    } else if (outcome === 'replacement') {
      expect(uploaded.isError).toBe(true);
      expect(reported.isError).toBe(true);
      expect(reportCalls).toBe(0);
      const replacement = await call(3, 'post_artifact', { path: join(scratch, 'evidence.txt') });
      expect(replacement.isError).not.toBe(true);
      const retried = await call(4, 'report', { status: 'done', text: 'done: replacement evidence attached' });
      expect(retried.isError).not.toBe(true);
      const result = JSON.parse(retried.content[0]!.text);
      const message = await daemon.execute('getRoomMessage', { ...authority(order), messageId: result.id }, RUBY);
      expect(message).toMatchObject({ body: 'done: replacement evidence attached', attachments: [expect.objectContaining({ name: 'evidence.txt' })] });
      console.info('Demonstrated upload-1: failed upload and refused report, successful replacement, delivered report with readable attachment metadata');
    } else {
      expect(uploaded.isError).not.toBe(true);
      expect(reported.isError).not.toBe(true);
      const result = JSON.parse(reported.content[0]!.text);
      const message = await daemon.execute('getRoomMessage', { ...authority(order), messageId: result.id }, RUBY);
      expect(message).toMatchObject({ body: 'done: evidence attached', attachments: [expect.objectContaining({ name: 'evidence.txt' })] });
      console.info('Demonstrated ARTIFACT-REPORT: shipped MCP delivered the report with evidence.txt through the daemon service');
    }
  } finally {
    release(); child.kill(); lines.close();
    bridge.closeAllConnections();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});

it('QUEUE-1: a tag, order and brief revision during a running corner turn queue into the next prompt', async () => {
  const opened = await open();
  await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [opened.cornerId, WORKER]);
  const root = await mkdtemp(join(tmpdir(), 'queue-proof-'));
  const abort = new AbortController();
  const ctx = new CommandExecutionContext(root);
  const prompts: AgentCommand[] = [];
  const stops: string[] = [];
  const errors: unknown[] = [];
  let pushed: ((rows: readonly AgentCommand[]) => void) | undefined;
  let finishOld!: () => void;
  const oldRun = new Promise<void>((resolve) => { finishOld = resolve; });
  const api = {
    execute: (name: string, input: object) => daemon.execute(name as never, input as never, WORKER),
    liveSubscribe: (_room: unknown, _cursor: unknown, _items: unknown, _state: unknown,
      _presence: unknown, onCommands: typeof pushed) => { pushed = onCommands; return () => {}; },
  } as unknown as DaemonApiClient;
  const running = runServerCommandIntake({ api, roomId: opened.cornerId, agentId: WORKER,
    context: ctx, signal: abort.signal, onError: (error) => errors.push(error),
    stop: (id) => { stops.push(id); },
    run: async (command) => {
      prompts.push(command);
      if (prompts.length > 1) { abort.abort(); return; }
      await oldRun;
      await daemon.execute('postAgentTurnReceipt', { roomId: opened.cornerId, requestId: command.turnRequestId,
        generationId: ctx.generationId, agentId: WORKER, status: 'complete' }, WORKER);
    },
  });
  try {
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const old = prompts[0]!;
    await phone.execute('sendRoomMessage', { roomId: opened.cornerId,
      messageId: randomBytes(32).toString('hex'), text: '@worker First: use the blue widget' }, HUMAN);
    await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Second: add rounded edges' }, RUBY);
    await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: opened.cornerId,
      expectedRevision: 1, brief: { spec: 'Third: keep the approved width', repositoryWork: false,
        approval: { sourceMessageId: order.sourceMessageId }, change: 'Third: keep the approved width' } }, RUBY);
    const delivered = await daemon.execute('getAgentCommands', { roomId: opened.cornerId }, WORKER);
    pushed?.(delivered.commands);
    // The running turn keeps working; no message is an implicit Stop.
    expect(delivered.commands.filter(command => command.action === 'stop')).toEqual([]);
    expect((await db.query(`SELECT count(*)::int n FROM agent_commands WHERE room_id=$1 AND action='stop'`,
      [opened.cornerId])).rows[0]?.n).toBe(0);
    expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
      [opened.cornerId, old.turnRequestId])).rows[0]?.status).toBe('working');
    expect(delivered.commands.filter(command => command.action === 'input')).toHaveLength(1);
    finishOld();
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await running;
    // The test's own abort ends the intake after the second prompt.
    expect(stops).not.toContain(old.turnRequestId);
    expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
      [opened.cornerId, old.turnRequestId])).rows[0]?.status).toBe('complete');
    const body = prompts[1]!.source.body;
    const at = ['First: use the blue widget', 'Second: add rounded edges', 'revised the corner brief'].map(text => body.indexOf(text));
    expect(at.every(index => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).not.toContain('interrupted');
    expect(errors).toEqual([]);
    console.log('QUEUE-1 corner: running turn completed; next prompt holds tag, order and brief revision in arrival order');
  } finally {
    abort.abort(); finishOld(); await running; await rm(root, { recursive: true, force: true });
  }
});

it('QUEUE-1: direct messages sent during a running turn reach one next prompt in order', async () => {
  // beforeEach leaves Ruby working on the first DM.
  for (const text of ['Second question', 'Third question'])
    await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text }, HUMAN);
  const queued = await commands(DM, RUBY);
  expect(queued.some(command => command.action === 'stop')).toBe(false);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [DM, order.turnRequestId])).rows[0]?.status).toBe('working');
  await daemon.execute('postAgentTurnReceipt', { ...authority(order), agentId: RUBY, status: 'complete' }, RUBY);
  const next = (await commands(DM, RUBY)).filter(command => command.action === 'input');
  expect(next).toHaveLength(1);
  const claimed = await claim(next[0]!);
  const body = (claimed.source?.body ?? next[0]!.source.body) + (claimed.coalescedContext ?? '');
  expect(body.indexOf('Second question')).toBeGreaterThanOrEqual(0);
  expect(body.indexOf('Third question')).toBeGreaterThan(body.indexOf('Second question'));
});

it('AGENT-STOP-1: a commander stops its worker\'s running turn, then its new order runs next', async () => {
  const opened = await open();
  await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [opened.cornerId, WORKER]);
  const root = await mkdtemp(join(tmpdir(), 'agent-stop-proof-'));
  const abort = new AbortController();
  const ctx = new CommandExecutionContext(root);
  const prompts: AgentCommand[] = [];
  const stops: string[] = [];
  const errors: unknown[] = [];
  let pushed: ((rows: readonly AgentCommand[]) => void) | undefined;
  let finishOld!: () => void;
  const oldRun = new Promise<void>((resolve) => { finishOld = resolve; });
  const api = {
    execute: (name: string, input: object) => daemon.execute(name as never, input as never, WORKER),
    liveSubscribe: (_room: unknown, _cursor: unknown, _items: unknown, _state: unknown,
      _presence: unknown, onCommands: typeof pushed) => { pushed = onCommands; return () => {}; },
  } as unknown as DaemonApiClient;
  const running = runServerCommandIntake({ api, roomId: opened.cornerId, agentId: WORKER,
    context: ctx, signal: abort.signal, onError: (error) => errors.push(error),
    stop: (id) => { stops.push(id); finishOld(); },
    run: async (command) => {
      prompts.push(command);
      if (prompts.length === 1) await oldRun;
      else abort.abort();
    },
  });
  try {
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const old = prompts[0]!;
    const result = await daemon.execute('stopAgentTurn', { ...authority(order), address: opened.cornerId }, RUBY);
    expect(result).toMatchObject({ stopped: true, agent: WORKER });
    expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
      [opened.cornerId, old.turnRequestId])).rows[0]?.status).toBe('cancelled');
    expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%stopped @%''s running turn%'`,
      [opened.cornerId])).rows.map((row) => row.text)).toEqual([expect.stringMatching(/^@\S+ stopped @\S+'s running turn$/)]);
    await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'New plan: paint it green' }, RUBY);
    pushed?.((await daemon.execute('getAgentCommands', { roomId: opened.cornerId }, WORKER)).commands);
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await running;
    expect(stops).toContain(old.turnRequestId);
    expect(prompts[1]!.source.body).toContain('New plan: paint it green');
    expect(errors).toEqual([]);
    console.log('AGENT-STOP-1: commander stop cancelled the running turn; the follow-up order ran next');
  } finally {
    abort.abort(); finishOld(); await running; await rm(root, { recursive: true, force: true });
  }
});

it('AGENT-STOP-3: an orderer stops a turn whose digest folded its order behind a human tag', async () => {
  const OTHER = 'd'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other') ON CONFLICT DO NOTHING`, [OTHER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [OTHER, HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, OTHER, ROOM]);
  const send = (text: string) => phone.execute('sendRoomMessage', { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text }, HUMAN);
  await send('@worker First: look at the widget');
  const first = (await commands(ROOM, WORKER))[0]!;
  await claim(first);
  await send('@worker Second: check the hinge');
  await daemon.execute('order', { ...authority(order), address: ROOM, agent: 'worker', text: 'Third: sand the edges' }, RUBY);
  await commands(ROOM, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(first), agentId: WORKER, status: 'complete' }, WORKER);
  const next = (await commands(ROOM, WORKER)).filter(command => command.action === 'input');
  expect(next).toHaveLength(1);
  const digest = await claim(next[0]!);
  expect((digest.source?.body ?? next[0]!.source.body) + (digest.coalescedContext ?? '')).toContain('Third: sand the edges');
  await send('@other Look at the widget');
  const otherTurn = (await commands(ROOM, OTHER))[0]!;
  await claim(otherTurn);
  await expect(daemon.execute('stopAgentTurn', { ...authority(otherTurn), address: ROOM, agent: 'worker' }, OTHER))
    .rejects.toThrow(/you did not order this turn and you do not command this corner/);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [ROOM, next[0]!.turnRequestId])).rows[0]?.status).toBe('working');
  const result = await daemon.execute('stopAgentTurn', { ...authority(order), address: ROOM, agent: 'worker' }, RUBY);
  expect(result).toMatchObject({ stopped: true, agent: WORKER });
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [ROOM, next[0]!.turnRequestId])).rows[0]?.status).toBe('cancelled');
  await daemon.execute('order', { ...authority(order), address: ROOM, agent: 'worker', text: 'New plan: paint it green' }, RUBY);
  const followUp = (await commands(ROOM, WORKER)).filter(command => command.action === 'input');
  expect(followUp).toHaveLength(1);
  const claimed = await claim(followUp[0]!);
  expect((claimed.source?.body ?? followUp[0]!.source.body) + (claimed.coalescedContext ?? '')).toContain('New plan: paint it green');
  console.log('AGENT-STOP-3: orderer stopped the human-led digest turn; unrelated agent refused; follow-up order runs next');
});

it('AGENT-STOP-2: an agent with no command over the running turn is refused and nothing stops', async () => {
  const OTHER = 'd'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other') ON CONFLICT DO NOTHING`, [OTHER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [OTHER, HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, OTHER, ROOM]);
  const opened = await open();
  const running = await worker(opened.cornerId);
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@other Look at the widget' }, HUMAN);
  const otherTurn = (await commands(ROOM, OTHER))[0]!;
  await claim(otherTurn);
  await expect(daemon.execute('stopAgentTurn', { ...authority(otherTurn), address: opened.cornerId, agent: 'worker' }, OTHER))
    .rejects.toThrow(/you did not order this turn and you do not command this corner/);
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, running.turnRequestId])).rows[0]?.status).toBe('working');
  expect((await db.query(`SELECT count(*)::int n FROM agent_commands WHERE room_id=$1 AND action='stop'`,
    [opened.cornerId])).rows[0]?.n).toBe(0);
});

it('Reproduction files-2: explicit post binds uploaded media before the turn finishes', async () => {
  const media = randomUUID();
  await db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'artifact',$3,'text/plain','evidence.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, RUBY, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await daemon.execute('postAgentAttachment', { ...authority(order), attachment: {
    url: 'http://test/v1/media/' + media, name: 'evidence.txt', mimeType: 'text/plain', size: 2,
  } }, RUBY);
  // Posting elsewhere must not drain files scoped to the private current place.
  const elsewhere = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: ROOM, text: 'Work started' }, RUBY);
  expect((await daemon.execute('getRoomMessage', { roomId: ROOM, messageId: elsewhere.id }, WORKER)).attachments).toHaveLength(0);
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text: 'evidence.txt attached' }, RUBY);
  const read = await daemon.execute('getRoomMessage', { roomId: DM, messageId: posted.id }, RUBY);
  expect(read.attachments).toEqual([expect.objectContaining({ name: 'evidence.txt', url: 'http://test/v1/media/' + media })]);
  expect((await db.query('SELECT 1 FROM agent_pending_attachments WHERE request_id=$1', [order.turnRequestId])).rowCount).toBe(0);
  await expect(daemon.execute('getRoomMessage', { roomId: DM, messageId: posted.id }, WORKER)).rejects.toThrow();
});

// Reproduction ARTIFACT-READ-BY-ID: actual agent read tool over loopback HTTP.
it('ARTIFACT-READ-BY-ID reads sibling and parent artifacts without exposing private files', async () => {
  const source = randomUUID(), sibling = randomUUID(), remote = randomUUID(), remoteRoom = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by)
    VALUES($1,$3,'Artifact source',$4,$5),($2,$3,'Artifact reader',$4,$5)`, [source,sibling,WS,ROOM,HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other workspace')`, [remote]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Other Room',$3)`, [remoteRoom,remote,HUMAN]);
  const objects = new ObjectService(db, new MemoryObjectStorage(), 'http://test');
  const bytes = Buffer.from('sibling artifact read by id');
  const files: string[] = [];
  for (const roomId of [source, DM, remoteRoom]) {
    const attachment = await objects.uploadArtifact(WORKER, roomId === source ? bytes : Buffer.from('private ' + roomId), 'text/plain', 'report.txt');
    const media = /\/v1\/media\/([^/]+)$/.exec(attachment.url)![1]!;
    files.push(media);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Report',$4::jsonb)`,
      [randomBytes(32).toString('hex'),roomId,WORKER,JSON.stringify([attachment])]);
  }
  const unrelated = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'No file here')`, [unrelated,ROOM,HUMAN]);
  const scratch = await mkdtemp(join(tmpdir(), 'artifact-read-by-id-'));
  const bridge = createServer(async (request,response) => {
    try {
      if (request.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await daemon.execute('getRoomMessage', JSON.parse(Buffer.concat(chunks).toString()), WORKER);
        response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(result));
      } else if (request.url?.startsWith('/v1/media/')) {
        response.writeHead(200).end(await objects.readOwnedBytes(WORKER, request.url.split('/').pop()!));
      } else response.writeHead(404).end();
    } catch {
      response.writeHead(404).end(JSON.stringify({error:'not_found'}));
    }
  });
  try {
    await new Promise<void>(resolve => bridge.listen(0,'127.0.0.1',resolve));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing proof port');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', scratch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    for (const roomId of [sibling, ROOM]) {
      vi.stubEnv('BEELINE_DAEMON_ROOM_ID', roomId);
      const result = JSON.parse(await callAgentTool('read', {facet:'attachment',attachmentId:files[0]}, 'artifact-read-by-id'));
      expect(await readFile(result.path)).toEqual(bytes);
      const fallback = JSON.parse(await callAgentTool('read', {
        facet: 'attachment', messageId: unrelated, attachmentId: files[0],
      }, 'wrong-message'));
      expect(await readFile(fallback.path)).toEqual(bytes);
      for (const id of [files[1],files[2],randomUUID()]) {
        await expect(callAgentTool('read', {facet:'attachment',attachmentId:id}, 'unreachable')).rejects.toThrow('no attachment with this id');
      }
    }
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve,reject) => bridge.close(error => error ? reject(error) : resolve()));
    await rm(scratch,{recursive:true,force:true});
  }
});
