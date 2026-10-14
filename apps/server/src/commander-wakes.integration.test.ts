import { flushDueCommanderWakes } from './commander-wakes.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { advanceCorner } from './corner-lifecycle.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { GitHubOperations } from './github-operations.js';
import { readAgentCommands, createAgentCommand, type CommandRow } from './agent-command.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64), RUBY = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
let order: AgentCommand;
let ready = false;
const checks = vi.fn(async () => ({ stage: 'waiting_for_yes' as const, checks: 'passed' as const, checkCount: 1,
  checkStates: { passed: 1, pending: 0, failed: 0, unlisted: 0, pendingNames: [], failedNames: [] },
  pullRequest: 'https://github.com/owner/widgets/pull/42', headSha: '9'.repeat(40), approved: ready,
  reviewer: '@reviewer', reviewerExists: true, reviewerWake: { status: 'dispatched' as const, detail: '' },
  held: false, holds: [], mergeAllowed: ready }));
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Captain','captain'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`,
    [HUMAN, RUBY, WORKER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [RUBY, WORKER, HUMAN]);
  daemon = new DaemonService(db, new LiveHub(), undefined, undefined, false, undefined, false, undefined, checks);
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  ready = false; checks.mockClear();
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Review command proof')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
    VALUES($1,$3,'Target Room',NULL,$4),($2,$3,'Captain and Ruby',jsonb_build_array($4::text,$5::text),$4)`, [ROOM, DM, WS, HUMAN, RUBY]);
  for (const person of [HUMAN, RUBY, WORKER]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, person, ROOM]);
    if (person !== WORKER) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [WS, DM, person]);
  }
  await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Build the widget in the target Room' }, HUMAN);
  order = (await daemon.execute('getAgentCommands', { roomId: DM }, RUBY)).commands[0]!;
  await claim(order);
});
const claim = (command: AgentCommand) => daemon.execute('claimAgentCommand', {
  roomId: command.roomId, commandId: command.id, generationId: 'proof-generation',
}, command.agentId);
const authority = (command: AgentCommand) => ({ roomId: command.roomId,
  requestId: command.turnRequestId, generationId: 'proof-generation' });
const commands = (roomId: string, agentId: string) => readAgentCommands(db, roomId, agentId).then(r => r.commands);
async function open(repositoryWork = true) {
  return daemon.execute('createCorner', { ...authority(order), requestId: order.turnRequestId,
    targetRoomId: ROOM, name: 'Widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork, approval: { sourceMessageId: order.sourceMessageId } },
  }, RUBY);
}
async function worker(cornerId: string) {
  const command = (await commands(cornerId, WORKER))[0]!;
  await claim(command);
  return command;
}

async function event(id: string, body: string) {
  return db.transaction(async tx => {
    const parent = (await tx.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [order.id])).rows[0]!;
    return createAgentCommand(tx, { id, roomId: DM, agentId: RUBY, sourceMessageId: null,
      reason: 'watched_corner', privatePayload: { text: body, kind: 'lifecycle', authorId: WORKER,
        fromRoomId: ROOM }, parent, retainDepth: true });
  });
}
async function expireWindow(database = db) {
  await database.query(`UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE wake_after IS NOT NULL`);
  await flushDueCommanderWakes(database);
}
it('Reproduction FR-report: rejects corner progress disguised as done before a PR is ready', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await expect(daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: PR opened, tests running' }, WORKER))
    .rejects.toThrow('post progress in the corner');
  expect((await commands(DM, RUBY)).some(c => c.reason === 'report')).toBe(false);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'PR opened, tests running' }, WORKER);
  expect((await db.query(`SELECT room_id FROM messages WHERE text='PR opened, tests running'`)).rows)
    .toEqual([{ room_id: opened.cornerId }]);
  expect((await commands(DM, RUBY)).some(c => c.reason === 'report')).toBe(false);
  console.info('Demonstrated FR-report: unready done refused; progress remains in the corner; commander receives no wake');
});
it('requires a status that matches the report prefix', async () => {
  await expect(daemon.execute('report', { ...authority(order), text: 'done: delivered' } as never, RUBY))
    .rejects.toThrow('requires status');
  await expect(daemon.execute('report', { ...authority(order), status: 'done', text: 'blocked: missing input' }, RUBY))
    .rejects.toThrow('matching its text prefix');
});
it('accepts done with live merge-ready checks, and batches its commander wake', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  ready = true;
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('pr',jsonb_build_object('number',42,'headSha',$2::text)) WHERE corner_id=$1`, [opened.cornerId, '9'.repeat(40)]);
  await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: ready to merge' }, WORKER);
  expect(checks).toHaveBeenCalledWith({ cornerId: opened.cornerId });
  expect((await commands(DM, RUBY)).some(c => c.reason === 'report')).toBe(false);
  await expireWindow();
  expect((await commands(DM, RUBY)).find(c => c.reason === 'report')?.source.body).toBe('done: ready to merge');
});
it('accepts done for a committed merged PR without requiring another GitHub read', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_build_object('pr',jsonb_build_object('number',42,'mergeCommitSha',$2::text)) WHERE corner_id=$1`, [opened.cornerId, '8'.repeat(40)]);
  await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: PR merged' }, WORKER);
  expect(checks).not.toHaveBeenCalled();
  await expireWindow();
  expect((await commands(DM, RUBY)).find(c => c.reason === 'report')?.source.body).toBe('done: PR merged');
});
it('allows completed non-PR deliverables and agent DM orders', async () => {
  const opened = await open(false), turn = await worker(opened.cornerId);
  await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: non-PR artifact delivered' }, WORKER);
  const workerDM = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Ruby and Worker',jsonb_build_array($3::text,$4::text))`, [workerDM, WS, RUBY, WORKER]);
  for (const agent of [RUBY, WORKER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, workerDM, agent]);
  await daemon.execute('order', { ...authority(order), address: workerDM, text: 'Research the endpoint' }, RUBY);
  const research = (await commands(workerDM, WORKER)).find(c => c.reason === 'order')!;
  await claim(research);
  await daemon.execute('report', { ...authority(research), status: 'done', text: 'done: research delivered' }, WORKER);
  expect(checks).not.toHaveBeenCalled();
  await expireWindow();
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports)).toContain('research delivered');
  expect(JSON.stringify(reports)).toContain('artifact delivered');
});
it('Reproduction FR-batch: merges two lifecycle events five seconds apart into one durable wake', async () => {
  const first = await event('merge-1', 'Watched corner one: merged');
  await db.query(`UPDATE agent_commands SET created_at=now()-interval '5 seconds',wake_after=now()+interval '55 seconds' WHERE id=$1`, [first!.id]);
  const second = await event('merge-2', 'Watched corner two: merged');
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'watched_corner')).toHaveLength(0);
  expect(second!.wake_after).toEqual((await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [first!.id])).rows[0]!.wake_after);
  await expect(claim({ ...order, id: first!.id })).rejects.toThrow('command claim conflict');
  const restarted = PgliteDatabase.fromSnapshot(await db.snapshot());
  try {
    await expireWindow(restarted);
    const wakes = (await readAgentCommands(restarted, DM, RUBY)).commands.filter(c => c.reason === 'watched_corner');
    expect(wakes).toHaveLength(1);
    expect(JSON.stringify(wakes)).toContain('corner one: merged');
    expect(JSON.stringify(wakes)).toContain('corner two: merged');
    await flushDueCommanderWakes(restarted);
    expect((await readAgentCommands(restarted, DM, RUBY)).commands.filter(c => c.reason === 'watched_corner')).toHaveLength(1);
  } finally { await restarted.close(); }
  console.info('Demonstrated FR-batch: two merges five seconds apart produce one wake after restart, with both events retained');
});
it.each(['blocked', 'failed', 'needs_decision'] as const)('%s reports wake immediately and flush queued facts into the same wake', async status => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await event('merge-1', 'Watched corner one: merged');
  const text = `${status.replace('_', '-')}: urgent result`;
  await daemon.execute('report', { ...authority(turn), status, text }, WORKER);
  const pending = (await commands(DM, RUBY)).filter(c => c.id !== order.id);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source.body).toBe(text);
  expect(pending[0]!.coalescedContext).toContain('corner one: merged');
  console.info(`Demonstrated FR-urgent: ${status} wakes at once and includes the queued merge`);
});
it('a human message bypasses the window and includes queued commander facts', async () => {
  await event('merge-1', 'Watched corner one: merged');
  await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Change the endpoint' }, HUMAN);
  const pending = (await commands(DM, RUBY)).filter(c => c.id !== order.id);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.source.body).toBe('Change the endpoint');
  expect(pending[0]!.coalescedContext).toContain('corner one: merged');
});
