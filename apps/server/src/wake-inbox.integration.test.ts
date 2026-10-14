import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { createAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';
import { flushDueCommanderWakes } from './commander-wakes.js';
import { systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService, humanCommand: AgentCommand;
const id = () => randomBytes(32).toString('hex');
const authority = (command: AgentCommand) => ({ roomId: command.roomId,
  requestId: command.turnRequestId, generationId: 'inbox-proof' });
const inbox = (database: SqlDatabase = db, roomId = ROOM, agentId = AGENT) =>
  readAgentCommands(database, roomId, agentId).then(result => result.commands);
const claim = (command: AgentCommand) => daemon.execute('claimAgentCommand', {
  roomId: command.roomId, commandId: command.id, generationId: 'inbox-proof',
}, command.agentId);
const delivery = (value: 'immediate' | `batch:${number}`, agentId = AGENT) =>
  daemon.execute('setWakeDelivery', { roomId: ROOM, delivery: value }, agentId);
async function mature(database: SqlDatabase = db) {
  await database.query("UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE wake_after IS NOT NULL");
  return flushDueCommanderWakes(database);
}
async function wake(text: string, reason = 'corner_brief', roomId = ROOM, agentId = AGENT) {
  return createAgentCommand(db, { id: id(), roomId, agentId, sourceMessageId: null, reason,
    privatePayload: { text, authorId: WORKER, fromRoomId: roomId, kind: 'lifecycle' } });
}
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Inbox','inbox'),($3,'agent','Worker','worker')`, [HUMAN, AGENT, WORKER]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [AGENT, WORKER, HUMAN]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM workspaces');
  await db.query('UPDATE agents SET wake_batch_minutes=0');
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Inbox proof')", [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES
    ($1,$3,'Inbox Room',$4),($2,$3,'Other Room',$4)`, [ROOM, OTHER, WS, HUMAN]);
  for (const member of [HUMAN, AGENT, WORKER]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$4,$2,'member')`, [WS, member, ROOM, OTHER]);
  }
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id(), text: '@inbox Review the queue' }, HUMAN);
  humanCommand = (await inbox())[0]!;
  await claim(humanCommand);
});
it('defaults to immediate and permits only the authenticated agent to change its own setting', async () => {
  expect(await daemon.execute('getWakeDelivery', { roomId: ROOM }, AGENT)).toEqual({ delivery: 'immediate' });
  await wake('Default system wake');
  expect((await inbox()).some(command => command.source.body === 'Default system wake')).toBe(true);
  await delivery('batch:5');
  expect(await daemon.execute('getWakeDelivery', { roomId: OTHER }, AGENT)).toEqual({ delivery: 'batch:5' });
  expect(await daemon.execute('getWakeDelivery', { roomId: ROOM }, WORKER)).toEqual({ delivery: 'immediate' });
  await expect(daemon.execute('setWakeDelivery', { roomId: ROOM, delivery: 'batch:5', agentId: WORKER } as never, AGENT))
    .rejects.toThrow('does not own requested agent');
  for (const value of ['batch:0', 'batch:-1', 'batch:1.5', 'batch:NaN', 'batch:2147483648', 'later']) {
    await expect(daemon.execute('setWakeDelivery', { roomId: ROOM, delivery: value } as never, AGENT))
      .rejects.toThrow('positive whole minutes');
  }
  expect((await db.query('SELECT wake_batch_minutes FROM agents WHERE agent_id=$1', [AGENT])).rows[0])
    .toEqual({ wake_batch_minutes: 5 });
});
it('demonstrates one digest covering system, subscription, lifecycle, order, report and scheduler producers', async () => {
  // Obtain a worker order so a real report has its normal commander provenance.
  await daemon.execute('order', { ...authority(humanCommand), address: OTHER, agent: 'worker', text: 'Review other Room' }, AGENT);
  const workerOrder = (await inbox(db, OTHER, WORKER))[0]!;
  await claim(workerOrder);
  await delivery('batch:5');
  await delivery('batch:5', WORKER);
  await daemon.execute('setEventSubscriptions', { roomId: ROOM, kinds: ['joined'] }, AGENT);
  await systemLine(db, { roomId: ROOM, authorId: HUMAN, subject: { kind: 'system', name: 'Beeline' },
    verb: 'joined', kind: 'joined', object: { text: 'system-subscriber-proof' } });
  await wake('lifecycle-proof');
  await daemon.execute('report', { ...authority(workerOrder), status: 'blocked', text: 'blocked: report-proof' }, WORKER);
  // An order to this agent also enters the same Room's pending window.
  await daemon.execute('order', { ...authority(workerOrder), address: ROOM, agent: 'inbox', text: 'order-proof' }, WORKER);
  const schedule = await daemon.execute('createAgentSchedule', { roomId: ROOM, agentId: AGENT,
    cadence: { kind: 'interval', everyMinutes: 10 }, prompt: 'scheduler-proof' }, AGENT);
  await db.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 second' WHERE id=$1", [schedule.scheduleId]);
  expect(await new AgentScheduleLoop(db).runOnce(new Date())).toBe(1);
  const stored = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE agent_id=$1
    AND state='pending' ORDER BY inbox_sequence`, [AGENT])).rows;
  expect(stored).toHaveLength(5);
  expect(stored.every(command => command.wake_after instanceof Date)).toBe(true);
  expect(new Set(stored.map(command => command.wake_after!.toISOString())).size).toBe(1);
  expect((await inbox()).filter(command => command.id !== humanCommand.id)).toHaveLength(0);
  expect(await mature()).toBe(1);
  const digests = (await inbox()).filter(command => command.id !== humanCommand.id);
  expect(digests).toHaveLength(1);
  expect(digests[0]!.id).toBe(stored[0]!.id);
  const remaining = digests[0]!.coalescedContext!.split('\n').map(line => JSON.parse(line));
  expect(remaining.map(command => command.id)).toEqual(stored.slice(1).map(command => command.id));
  const contents = JSON.stringify(digests[0]);
  for (const text of ['system-subscriber-proof', 'lifecycle-proof', 'report-proof', 'order-proof', 'scheduler-proof'])
    expect(contents).toContain(text);
  await claim(digests[0]!);
  console.info('Demonstrated inbox-batch: daemon batch:5 setting holds all five producer paths; one claimed Room digest retains every source in arrival order');
});
it('keeps actual human messages immediate without shortening the pending digest window', async () => {
  await delivery('batch:5');
  const delayed = await wake('queued-system-proof');
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id(), text: '@inbox Human follow-up' }, HUMAN);
  const delivered = (await inbox()).filter(command => command.id !== humanCommand.id);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.source.body).toBe('@inbox Human follow-up');
  expect((await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [delayed!.id])).rows[0]!.wake_after)
    .toEqual(delayed!.wake_after);
  await claim(delivered[0]!);
  expect(await mature()).toBe(1);
  expect((await inbox()).some(command => command.source.body === 'queued-system-proof')).toBe(true);
  console.info('Demonstrated inbox-human: human follow-up claims immediately while nonhuman digest retains its original deadline');
});
it('uses separate durable windows for the same agent in a Room and corner', async () => {
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1', [OTHER, ROOM]);
  await db.query("INSERT INTO corner_facts(corner_id,workflow_state,owner_agent_id) VALUES($1,'implement',$2)", [OTHER, AGENT]);
  await delivery('batch:3');
  await wake('Room first'); await wake('Room second');
  await wake('Corner first', 'corner_brief', OTHER); await wake('Corner second', 'corner_brief', OTHER);
  expect(await mature()).toBe(2);
  const room = (await inbox()).filter(command => command.id !== humanCommand.id);
  const corner = await inbox(db, OTHER);
  expect(room).toHaveLength(1); expect(corner).toHaveLength(1);
  expect(JSON.stringify(room)).not.toContain('Corner first');
  expect(JSON.stringify(corner)).not.toContain('Room first');
});
it('recovers a crash mid-window, rolls back partial digestion, and retries without loss or duplicate digests', async () => {
  await delivery('batch:5');
  await wake('Restart first'); await wake('Restart second');
  const restarted = PgliteDatabase.fromSnapshot(await db.snapshot());
  try {
    await restarted.query("UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE wake_after IS NOT NULL");
    await expect(restarted.transaction(async tx => {
      await flushDueCommanderWakes(tx);
      throw new Error('simulated crash before commit');
    })).rejects.toThrow('simulated crash');
    expect((await restarted.query("SELECT id FROM agent_commands WHERE state='pending' AND wake_after IS NOT NULL")).rows)
      .toHaveLength(2);
    expect(await flushDueCommanderWakes(restarted)).toBe(1);
    expect(await flushDueCommanderWakes(restarted)).toBe(0);
    const digests = (await inbox(restarted)).filter(command => command.id !== humanCommand.id);
    expect(digests).toHaveLength(1);
    expect(JSON.stringify(digests)).toContain('Restart first');
    expect(JSON.stringify(digests)).toContain('Restart second');
    expect((await restarted.query("SELECT id FROM agent_commands WHERE cancellation_reason LIKE 'coalesced_into:%'")).rows)
      .toHaveLength(1);
  } finally { await restarted.close(); }
  console.info('Demonstrated inbox-restart: persisted wakes survive restart and transaction rollback; repeated digestion releases exactly one complete digest');
});
it('emits no wake for empty windows and keeps recorded deadlines when changing the setting', async () => {
  await delivery('batch:1');
  expect(await mature()).toBe(0);
  const first = await wake('Existing window');
  await delivery('batch:10');
  const second = await wake('Same existing window');
  expect(second!.wake_after).toEqual(first!.wake_after);
  await delivery('immediate');
  await wake('New immediate wake');
  expect((await inbox()).some(command => command.source.body === 'New immediate wake')).toBe(true);
  expect((await inbox()).some(command => command.source.body === 'Existing window')).toBe(false);
});
it('retains insertion order when transaction timestamps tie, even when ids sort in reverse', async () => {
  await delivery('batch:2');
  await db.transaction(async tx => {
    for (const [commandId, text] of [['z-first', 'First in transaction'], ['a-second', 'Second in transaction']]) {
      await createAgentCommand(tx, { id: commandId, roomId: ROOM, agentId: AGENT,
        sourceMessageId: null, reason: 'corner_brief',
        privatePayload: { text: text!, authorId: WORKER, fromRoomId: ROOM, kind: 'lifecycle' } });
    }
  });
  const timestamps = (await db.query<{ created_at: Date }>("SELECT created_at FROM agent_commands WHERE id IN ('z-first','a-second')")).rows;
  expect(timestamps[0]!.created_at).toEqual(timestamps[1]!.created_at);
  await mature();
  const digest = (await inbox()).find(command => command.id !== humanCommand.id)!;
  expect(digest.id).toBe('z-first');
  expect(digest.source.body).toBe('First in transaction');
  expect(JSON.parse(digest.coalescedContext!).id).toBe('a-second');
});
it('starts a fresh window for an arrival after an unserviced deadline', async () => {
  await delivery('batch:2');
  const first = await wake('Window one');
  await db.query("UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1", [first!.id]);
  const later = await wake('Window two');
  expect(later!.wake_after!.getTime()).toBeGreaterThan(Date.now());
  expect(await flushDueCommanderWakes(db)).toBe(1);
  const released = (await inbox()).filter(command => command.id !== humanCommand.id);
  expect(released).toHaveLength(1);
  expect(released[0]!.source.body).toBe('Window one');
  expect(await mature()).toBe(1);
  expect((await inbox()).filter(command => command.id !== humanCommand.id)).toHaveLength(2);
});
it('batches an unsubscribed approval resume and preserves its original turn authority', async () => {
  await delivery('batch:2');
  await systemLine(db, { roomId: ROOM, authorId: HUMAN, subject: { kind: 'system', name: 'Beeline' },
    verb: 'decided', kind: 'grant-decided', wakes: [AGENT], requestId: humanCommand.turnRequestId,
    object: { text: 'approval-proof' } });
  await wake('Following lifecycle fact');
  expect(await inbox()).toHaveLength(0);
  await mature();
  const digest = (await inbox())[0]!;
  expect(digest.action).toBe('resume');
  expect(digest.turnRequestId).toBe(humanCommand.turnRequestId);
  expect(digest.source.body).toContain('approval-proof');
  expect(digest.coalescedContext).toContain('Following lifecycle fact');
  await claim(digest);
  console.info('Demonstrated inbox-system: an unsubscribed approval resume is batched and claims under its original turn authority');
});
it('retains message and private attachments in a digest without modifying the source messages', async () => {
  await delivery('batch:2');
  const firstId = id(), secondId = id();
  const firstAttachment = { id: 'photo-first', name: 'First.png', type: 'image/png', size: 12 };
  const secondAttachment = { id: 'photo-second', name: 'Second.png', type: 'image/png', size: 14 };
  await db.query('INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,$4,$5::jsonb)',
    [firstId, ROOM, WORKER, 'First message', JSON.stringify([firstAttachment])]);
  await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId: firstId, reason: 'agent_tag' });
  await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId: null, id: secondId, reason: 'order',
    privatePayload: { text: 'Second private wake', authorId: WORKER, fromRoomId: ROOM, kind: 'order', attachments: [secondAttachment] } });
  await mature();
  const digest = (await inbox())[0]!;
  expect(digest.source.attachments).toEqual([firstAttachment, secondAttachment]);
  expect(JSON.parse(digest.coalescedContext!).attachments).toEqual([secondAttachment]);
  expect((await db.query('SELECT attachments FROM messages WHERE id=$1', [firstId])).rows[0]!.attachments)
    .toEqual([firstAttachment]);
});
it('does not lose a released digest during offline queue recovery', async () => {
  await delivery('batch:2');
  // End the fixture's initial turn so the ordinary return-queue recovery runs.
  await db.query("UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1", [humanCommand.id]);
  const firstId = id();
  await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)', [firstId, ROOM, WORKER, 'Offline first']);
  await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId: firstId, reason: 'agent_tag' });
  await wake('Offline second');
  await mature();
  await db.query("UPDATE agent_commands SET created_at=now()-interval '5 minutes',created_offline=true WHERE state='pending'");
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id(), text: '@inbox Latest human request' }, HUMAN);
  const commands = await inbox();
  expect(commands).toHaveLength(2);
  expect(JSON.stringify(commands)).toContain('Offline first');
  expect(JSON.stringify(commands)).toContain('Offline second');
  expect(JSON.stringify(commands)).toContain('Latest human request');
});
async function workflowWake() {
  const runId = id();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES($1,$2,$3,'Workflow attempt','card','workflow-handoff',$4::jsonb)`,
    [runId, ROOM, WORKER, JSON.stringify({ runId, workflowSlug: 'digest-test', seq: 1, toState: 'work', runStatus: 'live' })]);
  await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId: runId, reason: 'subscribed_event' });
  return runId;
}
it.each(['head', 'absorbed'] as const)('revalidates a %s workflow source after release and before claim, preserving other work', async position => {
  await delivery('batch:2');
  if (position === 'absorbed') await wake('Valid unrelated work');
  const runId = await workflowWake();
  if (position === 'head') await wake('Valid unrelated work');
  await mature();
  const cached = (await inbox())[0]!;
  expect(JSON.stringify(cached)).toContain('Workflow attempt');
  await db.query("UPDATE messages SET card=card||'{\"runStatus\":\"abandoned\",\"cancellation\":{\"reason\":\"cancelled\"}}'::jsonb WHERE id=$1", [runId]);
  if (position === 'head') await expect(claim(cached)).rejects.toThrow('command claim conflict');
  else {
    const refreshed = await claim(cached);
    expect(refreshed.coalescedContext).toBe('');
    expect(refreshed.source?.body).toBe('Valid unrelated work');
  }
  const delivered = position === 'head' ? (await inbox())[0]! : undefined;
  if (delivered) {
    expect(delivered.id).not.toBe(cached.id);
    expect(delivered.source.body).toBe('Valid unrelated work');
    expect(JSON.stringify(delivered)).not.toContain('Workflow attempt');
    await claim(delivered);
  }
  expect((await db.query("SELECT id FROM agent_commands WHERE cancellation_reason='workflow_attempt_expired'")).rows)
    .toHaveLength(1);
  console.info(`Demonstrated inbox-workflow: cancelled ${position} attempt loses authority at claim; unrelated work survives in a refreshed digest`);
});
it('reports a digest to each actual orderer even when an unrelated lifecycle fact opened the window', async () => {
  await delivery('batch:2');
  await wake('Unrelated lifecycle');
  await phone.execute('sendRoomMessage', { roomId: OTHER, messageId: id(), text: '@worker Lead this work' }, HUMAN);
  const workerCommand = (await inbox(db, OTHER, WORKER))[0]!;
  await claim(workerCommand);
  await daemon.execute('order', { ...authority(workerCommand), address: ROOM, agent: 'inbox', text: 'First assigned task' }, WORKER);
  // A second real agent orderer in the same execution scope.
  const secondAgent = 'd'.repeat(64);
  await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Second','second') ON CONFLICT DO NOTHING", [secondAgent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [secondAgent, HUMAN]);
  await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$4,$3,'member')", [WS, ROOM, secondAgent, OTHER]);
  await phone.execute('sendRoomMessage', { roomId: OTHER, messageId: id(), text: '@second Lead another task' }, HUMAN);
  const secondCommand = (await inbox(db, OTHER, secondAgent))[0]!;
  await claim(secondCommand);
  await daemon.execute('order', { ...authority(secondCommand), address: ROOM, agent: 'inbox', text: 'Second assigned task' }, secondAgent);
  await mature();
  const digest = (await inbox())[0]!;
  await claim(digest);
  await daemon.execute('report', { ...authority(digest), status: 'done', text: 'done: both assigned tasks complete' }, AGENT);
  for (const commander of [WORKER, secondAgent]) {
    const reports = (await inbox(db, OTHER, commander)).filter(command => command.reason === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.source.body).toBe('done: both assigned tasks complete');
  }
  console.info('Demonstrated inbox-provenance: one digest executes two orders and each actual orderer receives one completion report');
});
it('delivers and claims ordinary work inside a browser-led digest despite later queued windows', async () => {
  await delivery('batch:2');
  const first = await wake('Browser observation', 'computer_activity');
  await createAgentCommand(db, { roomId: ROOM, agentId: AGENT, sourceMessageId: null,
    reason: 'order', privatePayload: { text: 'Released ordinary order', authorId: WORKER, fromRoomId: ROOM, kind: 'order' } });
  await mature();
  await wake('Future batch work');
  const delivered = await inbox();
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.id).toBe(first!.id);
  expect(delivered[0]!.coalescedContext).toContain('Released ordinary order');
  await claim(delivered[0]!);
  console.info('Demonstrated inbox-browser: ordinary work in a browser-led digest remains deliverable and claimable ahead of a later batch window');
});
