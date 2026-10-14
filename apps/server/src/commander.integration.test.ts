import { flushDueCommanderWakes } from './commander-wakes.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { advanceCorner } from './corner-lifecycle.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { GitHubOperations } from './github-operations.js';
import { createAgentCommand, readAgentCommands, noteCornerAgentUnreachable, noteBlockedCornerChecks, type CommandRow } from './agent-command.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64), RUBY = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = 'bb91a1c7-7cad-4fde-aafc-94fccb651ac8';
const DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
let order: AgentCommand;
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Captain','captain'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`,
    [HUMAN, RUBY, WORKER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [RUBY, WORKER, HUMAN]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
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
const commands = async (roomId: string, agentId: string) => {
  await db.query(`UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL`);
  await flushDueCommanderWakes(db);
  return (await readAgentCommands(db, roomId, agentId)).commands;
};
async function open() {
  return daemon.execute('createCorner', { ...authority(order), requestId: order.turnRequestId,
    targetRoomId: ROOM, name: 'Widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
  }, RUBY);
}
async function worker(cornerId: string) {
  const command = (await commands(cornerId, WORKER))[0]!;
  await claim(command);
  return command;
}
it('opens in an unrelated member Room from a DM and records the caller as commander', async () => {
  const opened = await open();
  expect((await db.query(`SELECT parent_id,created_by FROM rooms WHERE id=$1`, [opened.cornerId])).rows[0])
    .toMatchObject({ parent_id: ROOM, created_by: RUBY });
  expect((await commands(opened.cornerId, WORKER))[0]).toMatchObject({ private: true,
    source: { authorId: RUBY, body: 'Build the widget' } });
  expect(opened.watch?.kinds).toEqual(['opened', 'merged']);
});
it('delivers blocked privately to Ruby and Ruby orders the current worker privately', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { status: 'blocked', ...authority(turn), text: 'blocked: need an endpoint decision' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: WORKER, body: 'blocked: need an endpoint decision' } });
  await claim(report);
  await daemon.execute('order', { ...authority(report), address: opened.cornerId, text: 'Use endpoint v2' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'Use endpoint v2' } });
  expect((await db.query(`SELECT text FROM messages WHERE text IN ($1,$2)`,
    ['blocked: need an endpoint decision', 'Use endpoint v2'])).rowCount).toBe(0);
});
it.each(['needs-decision: choose the product scope', 'needs-decision: choose the product scope @captain'])('Ruby posts exactly her report text in the original DM: %s', async (text) => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(turn), text, ask: 'Which product scope should we use?' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(report), text, ask: 'Which product scope should we use?' }, RUBY);
  const rows = (await db.query(`SELECT room_id,author_id,text,card FROM messages WHERE text=$1`,
    [text])).rows;
  expect(rows).toEqual([{ room_id: DM, author_id: RUBY, text, card: { ask: 'Which product scope should we use?', reportToId: HUMAN } }]);
  expect((await phone.readRoom(DM, HUMAN))?.messages.some(m => m.text === rows[0]!.text)).toBe(true);
});
it('accepts needs-decision without an ask and validates optional asks', async () => {
  const reported = await daemon.execute('report', { status: 'needs_decision', ...authority(order), text: 'needs-decision: Which scope should we use? @captain' }, RUBY);
  expect((await phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items.find(item => item.messageId === reported.id)?.text).toBe('Which scope should we use?');
  await expect(daemon.execute('report', { status: 'needs_decision', ...authority(order), text: 'needs-decision: pick scope', ask: '**Which scope?**' }, RUBY)).rejects.toThrow('plain text');
});
it('nested Room orders forward reports one commander at a time before reaching the human', async () => {
  const otherRoom = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Agent work',$3)`, [otherRoom, WS, HUMAN]);
  for (const agent of [RUBY, WORKER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [WS, otherRoom, agent]);
  await daemon.execute('order', { ...authority(order), address: ROOM, agent: WORKER, text: 'Run the project' }, RUBY);
  const managerOrder = (await commands(ROOM, WORKER)).find(c => c.reason === 'order')!;
  await claim(managerOrder);
  await daemon.execute('order', { ...authority(managerOrder), address: otherRoom, agent: RUBY, text: 'Decide the project scope' }, WORKER);
  const childOrder = (await commands(otherRoom, RUBY)).find(c => c.reason === 'order')!;
  await claim(childOrder);
  const text = 'needs-decision: select the final scope';
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(childOrder), text, ask: 'Which product scope should we use?' }, RUBY);
  const managerReport = (await commands(ROOM, WORKER)).find(c => c.reason === 'report')!;
  await claim(managerReport);
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(managerReport), text, ask: 'Which product scope should we use?' }, WORKER);
  const rubyReport = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(rubyReport).toMatchObject({ private: true, source: { authorId: WORKER, body: text } });
  expect((await db.query(`SELECT 1 FROM messages WHERE text=$1`, [text])).rowCount).toBe(0);
  await claim(rubyReport);
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(rubyReport), text, ask: 'Which product scope should we use?' }, RUBY);
  expect((await db.query(`SELECT room_id,author_id FROM messages WHERE text=$1`, [text])).rows)
    .toEqual([{ room_id: DM, author_id: RUBY }]);
});
it('a real GitHub merge webhook wakes Ruby once through the corner lifecycle', async () => {
  const opened = await open();
  const branch = `feature/corner-${opened.cornerId.replaceAll('-', '').slice(0, 12)}`;
  await db.query(`UPDATE rooms SET repository_key='owner/widgets' WHERE id=$1`, [ROOM]);
  await db.query(`UPDATE corner_facts SET feature_branch=$2,lifecycle=$3::jsonb WHERE corner_id=$1`,
    [opened.cornerId, branch, JSON.stringify({ lifecycle: 'in-review', checks: 'passing',
      pr: { number: 42, url: 'https://github.com/owner/widgets/pull/42', headSha: '9'.repeat(40), targetBranch: 'main' } })]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [HUMAN]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`);
  await db.query(`UPDATE rooms SET github_installation_id=77 WHERE id=$1`, [ROOM]);
  const github = new GitHubOperations(db, {} as GitHubOAuthClient,
    { deleteBranch: vi.fn(async () => undefined) } as unknown as GitHubAppClient, 'secret');
  await github.processWebhook('pull_request', {
    installation: { id: 77 },
    action: 'closed', repository: { id: 101, full_name: 'owner/widgets' },
    pull_request: { number: 42, title: 'Widget', html_url: 'https://github.com/owner/widgets/pull/42',
      merged: true, merge_commit_sha: '8'.repeat(40), head: { ref: branch, sha: '9'.repeat(40) },
      base: { ref: 'main' } },
  });
  const mergeWakes = (await commands(DM, RUBY)).filter(c => c.reason === 'watched_corner' && c.source.body.includes('merged'));
  expect(mergeWakes).toHaveLength(1);
  expect(mergeWakes[0]!.private).toBe(true);
});
it('a configured reviewer can record PASS from its DM without changing the reviewer gate', async () => {
  const opened = await open(), headSha = '9'.repeat(40);
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
    JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 42, headSha } })]);
  await advanceCorner(db, opened.cornerId, { kind: 'push', contents: { headSha } });
  await systemLine(db, { roomId: opened.cornerId, authorId: WORKER, subject: GITHUB_SUBJECT,
    verb: 'passed checks', kind: 'check-passed' });
  await expect(daemon.execute('approveCornerMerge', { ...authority(order), cornerId: opened.cornerId, headSha }, RUBY))
    .resolves.toMatchObject({ status: 'approved' });
  await expect(daemon.execute('approveCornerMerge', { cornerId: opened.cornerId, headSha }, WORKER))
    .rejects.toThrow('configured reviewer');
});
it('schedules, check events and chatter in the corner never wake a watcher', async () => {
  const opened = await open();
  const before = (await commands(DM, RUBY)).map(c => c.id);
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":1}', 'Check the widget once',1,now()-interval '1 minute')`,
    [randomUUID(), WS, opened.cornerId, WORKER]);
  expect(await new AgentScheduleLoop(db).runOnce()).toBe(1);
  expect((await commands(opened.cornerId, WORKER)).some(c => c.reason === 'schedule')).toBe(true);
  await systemLine(db, { roomId: opened.cornerId, authorId: WORKER, subject: GITHUB_SUBJECT,
    verb: 'checked', kind: 'check-passed', object: 'the widget' });
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'corner chatter')`,
    [randomBytes(32).toString('hex'), opened.cornerId, WORKER]);
  expect((await commands(DM, RUBY)).map(c => c.id)).toEqual(before);
});
it('an ordered corner turn keeps live work and progress in the corner', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const before = (await db.query(`SELECT id FROM messages`)).rows.length;
  const live = new LiveHub(), seen: unknown[] = [];
  live.subscribeAll((event) => seen.push(event));
  const watched = new DaemonService(db, live);
  await watched.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'live draft' }, WORKER);
  await watched.execute('postAgentActivity', { ...authority(turn), agentId: WORKER, requestId: turn.turnRequestId!,
    cornerActivityKey: '1:tool-0', activity: [{ kind: 'tool', title: 'Read widget.ts', operation: 'read', status: 'completed' }] }, WORKER);
  expect((await db.query(`SELECT room_id,presentation FROM messages WHERE author_id=$1`, [WORKER])).rows)
    .toEqual([{ room_id: opened.cornerId, presentation: 'activity' }]);
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({ roomId: opened.cornerId, reason: 'activity' }),
  ]));
  expect(seen.every((event) => (event as { roomId?: string }).roomId === opened.cornerId)).toBe(true);
  // The corner screen reads this view while the turn runs.
  const corner = await phone.readRoom(opened.cornerId, HUMAN);
  const row = corner?.messages.find((message) => message.author.pubkey === WORKER);
  console.log('[R1] corner view while the ordered turn runs:', JSON.stringify(row?.activity));
  expect(row?.activity).toEqual([expect.objectContaining({ kind: 'tool', title: 'Read widget.ts' })]);
  await watched.execute('postRoomMessage', { ...authority(turn), text: 'private final output' }, WORKER);
  await watched.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete', completionKind: 'no-reply' }, WORKER);
  expect((await db.query(`SELECT 1 FROM messages WHERE text='private final output'`)).rowCount).toBe(1);
  expect((await db.query(`SELECT id FROM messages`)).rows).toHaveLength(before + 2);
  expect((await commands(opened.cornerId, WORKER))).toEqual([]);
});
it('Reproduction quiet-final: private order prose keeps its return route without an invented status', async () => {
  await daemon.execute('order', { ...authority(order), address: ROOM, agent: WORKER, text: 'Check the widget' }, RUBY);
  const turn = (await commands(ROOM, WORKER)).find(c => c.reason === 'order')!;
  await claim(turn);
  const before = (await db.query(`SELECT id FROM messages`)).rows;
  await daemon.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'private draft' }, WORKER);
  await daemon.execute('postAgentActivity', { ...authority(turn), agentId: WORKER, requestId: turn.turnRequestId!,
    activity: [{ kind: 'tool', title: 'Read widget.ts', operation: 'read', status: 'completed' }] }, WORKER);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'private final output' }, WORKER);
  expect((await db.query(`SELECT id FROM messages`)).rows).toEqual(before);
  expect((await commands(DM, RUBY)).find(c => c.reason === 'report')?.source.body).toBe('private final output');
  console.info('Demonstrated quiet-final: ordered Room final text reaches commander unchanged, private, without done prefix');
});

it('Reproduction quiet-unreachable: names the failed corner and agent once per failure span', async () => {
  const opened = await open();
  const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
  await db.query(`UPDATE agent_commands SET created_at=now()-interval '3 minutes' WHERE id=$1`, [pending.id]);
  const before = (await db.query('SELECT id FROM messages ORDER BY id')).rows;
  await noteBlockedCornerChecks(db);
  await noteBlockedCornerChecks(db);
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ private: true });
  expect((await db.query('SELECT id FROM messages ORDER BY id')).rows).toEqual(before);
  expect(reports[0]!.source.body).toContain(opened.cornerId);
  expect(reports[0]!.source.body).toContain('Widget');
  expect(reports[0]!.source.body).toContain('Worker');
  expect(reports[0]!.source.body).toContain(pending.id);
  expect(reports[0]!.source.body).toContain('unclaimed');
  console.info('Demonstrated quiet-unreachable: named corner, agent and failed command, one notice across repeated failures');
});

it.each([false, true])('Reproduction human-steered-unreachable: a person commander receives no notice (person opened=%s)', async (personOpened) => {
  const opened = await open();
  if (personOpened) await db.query('UPDATE rooms SET created_by=$1 WHERE id=$2', [HUMAN, opened.cornerId]);
  const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($1::text)) WHERE id=$2`, [HUMAN, pending.id]);
  const humanOrder = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [pending.id])).rows[0]!;
  const before = (await db.query('SELECT id FROM messages ORDER BY id')).rows;
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, pending.id, humanOrder);
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, pending.id, humanOrder);
  expect((await db.query('SELECT id FROM messages ORDER BY id')).rows).toEqual(before);
  const wakes = (await commands(ROOM, RUBY)).filter(c => c.reason === 'report');
  expect(wakes).toHaveLength(0);
  expect((await db.query('SELECT id FROM messages ORDER BY id')).rows).toEqual(before);
  console.info('Demonstrated Reproduction human-steered-unreachable: person commander: wakes=0; transcript additions=0; repeat=0');
});

it('Reproduction quiet-stale: drops an unreachable notice after a turn has run since the failed wake', async () => {
  const opened = await open();
  const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
  await worker(opened.cornerId);
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, pending.id, pending);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  console.info('Demonstrated quiet-stale: worker ran after failed wake; commander receives no unreachable notice');
});

it('allows one new unreachable notice after a worker turn ends the previous failure span', async () => {
  const opened = await open();
  const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, pending.id, pending);
  const turn = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete', completionKind: 'no-reply' }, WORKER);
  const next = (await db.query<CommandRow>(`INSERT INTO agent_commands
    (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
    SELECT 'next-failed-wake',room_id,agent_id,source_message_id,'next-failed-wake',action,reason,root_command_id,root_source_message_id,agent_depth
    FROM agent_commands WHERE id=$1 RETURNING *`, [pending.id])).rows[0]!;
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, next.id, next);
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, next.id, next);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(2);
});
it('reconnect recovery keeps every private report, even when each was queued offline', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  for (const text of ['blocked: missing input', 'failed: build stopped', 'needs-decision: select scope'])
    await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(turn), text, ask: 'Which product scope should we use?' }, WORKER);
  await db.query(`UPDATE agent_commands SET created_offline=true,created_at=now()-interval '10 minutes' WHERE reason='report'`);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(3);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(3);
});
it('cross-Room reads work from a DM, while nonmembers get no data or order', async () => {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('target-read',$1,$2,'Member history')`, [ROOM, HUMAN]);
  expect((await daemon.execute('read', { roomId: DM, address: ROOM }, RUBY)).items.map(m => m.body)).toContain('Member history');
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`, [RUBY, ROOM]);
  await expect(daemon.execute('read', { roomId: DM, address: ROOM }, RUBY)).rejects.toThrow('membership');
  await expect(daemon.execute('order', { ...authority(order), address: ROOM, text: 'Do this' }, RUBY)).rejects.toThrow('membership');
});
it('revises a reachable corner brief from a DM with the same active-order authority', async () => {
  const opened = await open();
  const revision = await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Build the assigned widget with the clarified endpoint',
      approval: { sourceMessageId: order.sourceMessageId }, change: 'Clarify the endpoint' } }, RUBY);
  expect(revision.revision).toBe(2);
});
describe('a worker records a later waiver in its corner brief', () => {
  const STRANGER = 'd'.repeat(64), OUTSIDER = 'e'.repeat(64);
  const revise = async (turn: AgentCommand, cornerId: string, expectedRevision: number, sourceMessageId: string) => {
    // Self-revision now returns to a Room/DM turn; retain the approval-chain coverage.
    const source = (await db.query<{ parent_id: string | null }>(`SELECT parent_id FROM rooms WHERE id=$1`, [turn.roomId])).rows[0];
    if (source?.parent_id) turn = await dmTurn(await directMessage(HUMAN, HUMAN, 'Revise the assigned widget brief'));
    return daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId, expectedRevision,
      brief: { spec: 'Build the widget; the proof is waived', repositoryWork: false,
        approval: { sourceMessageId }, change: 'Record the waiver' } }, WORKER);
  };
  const approval = async (cornerId: string) => (await db.query<{ approval_basis: Record<string, unknown> }>(
    `SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
    [cornerId])).rows[0]!.approval_basis;
  const rooms = new Map<string, string>();
  /** The worker's claimed turn on a DM message, so the DM is its command Room. */
  async function dmTurn(messageId: string) {
    const command = await createAgentCommand(db, { roomId: rooms.get(messageId)!, agentId: WORKER,
      sourceMessageId: messageId, reason: 'direct_message' });
    const [turn] = (await commands(command!.room_id, WORKER)).filter((item) => item.id === command!.id);
    await claim(turn!);
    return turn!;
  }
  /** A DM between the worker and `person`, holding one message from `author`. */
  async function directMessage(person: string, author: string, text: string) {
    const room = randomUUID(), id = randomBytes(32).toString('hex');
    rooms.set(id, room);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
      VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text),$3)`, [room, WS, person, WORKER]);
    for (const member of [person, WORKER])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WS, room, member]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [id, room, author, text]);
    return id;
  }
  beforeAll(async () => {
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Stranger','stranger'),($2,'agent','Outsider','outsider') ON CONFLICT DO NOTHING`, [STRANGER, OUTSIDER]);
  });
  beforeEach(async () => {
    for (const person of [STRANGER, OUTSIDER])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`, [WS, person]);
  });

  it('reuses the approval stored on the current revision', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const stored = await approval(opened.cornerId);
    const revised = await revise(turn, opened.cornerId, 1, stored.sourceMessageId as string);
    expect(revised.revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ kind: stored.kind, approvedBy: HUMAN,
      sourceMessageId: stored.sourceMessageId, snapshot: 'Build the widget in the target Room' });
  });

  it('accepts the owner\'s waiver from a DM with the worker', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await directMessage(HUMAN, HUMAN, 'Waive the proof for this corner.');
    expect((await revise(turn, opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ kind: 'explicit-human-answer', approvedBy: HUMAN,
      sourceMessageId: waiver, snapshot: 'Waive the proof for this corner.' });
  });

  it('accepts an earlier private order from the corner\'s commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Skip the proof.' }, RUBY);
    const waiver = (await commands(opened.cornerId, WORKER)).find((command) => command.reason === 'order')!;
    expect((await revise(turn, opened.cornerId, 1, waiver.sourceMessageId)).revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ kind: 'commander-order', approvedBy: RUBY,
      sourceMessageId: waiver.sourceMessageId, snapshot: 'Skip the proof.' });
  });

  it('refuses a DM from a person outside the corner\'s authority chain', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await directMessage(STRANGER, STRANGER, 'Waive the proof for this corner.');
    await expect(revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('must name a human message or commander order');
  });

  it('refuses a person outside the authority chain from the worker\'s active DM turn', async () => {
    const opened = await open();
    const waiver = await directMessage(STRANGER, STRANGER, 'Waive the proof for this corner.');
    await expect(revise(await dmTurn(waiver), opened.cornerId, 1, waiver))
      .rejects.toThrow('must name a human message or commander order');
    expect((await db.query(`SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1`, [opened.cornerId])).rowCount).toBe(1);
  });

  it('accepts the owner\'s waiver from the worker\'s active DM turn', async () => {
    const opened = await open();
    const waiver = await directMessage(HUMAN, HUMAN, 'Waive the proof for this corner.');
    expect((await revise(await dmTurn(waiver), opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ approvedBy: HUMAN, sourceMessageId: waiver });
  });

  it('refuses an agent\'s DM message that is not an order', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await directMessage(RUBY, RUBY, 'Waive the proof for this corner.');
    await expect(revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('must name a human message or commander order');
  });

  it('refuses a private order to the corner from an agent that is not its commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WS, opened.cornerId, OUTSIDER]);
    const outside = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip the proof.', authorId: OUTSIDER, fromRoomId: ROOM, kind: 'order' } });
    await expect(revise(turn, opened.cornerId, 1, outside!.id)).rejects.toThrow('must name a human message or commander order');
  });
});

it('prepares the first brief of a human-opened corner from a member DM', async () => {
  const opened = await phone.execute('createHumanCorner', { roomId: ROOM, title: 'Widget' }, HUMAN);
  await expect(daemon.execute('renameCorner', { ...authority(order), cornerId: opened.id,
    name: 'Prepared', objective: 'Build the widget',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } }, RUBY))
    .resolves.toMatchObject({ name: 'Prepared' });
});
it('private order IDs authorize child briefs without storing private text as messages', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const child = await daemon.execute('createCorner', { ...authority(turn), requestId: turn.turnRequestId,
    targetRoomId: ROOM, idempotencyKey: 'child-order', name: 'Child', objective: 'Build a child widget',
    brief: { spec: 'Child widget', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER);
  expect((await db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`, [child.cornerId])).rows[0])
    .toMatchObject({ approval_basis: { kind: 'commander-order', approvedBy: RUBY, snapshot: 'Build the widget' } });
});
it('opening from a report resumes the original order instead of treating the report as approval', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: widget ready for the next step' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  const next = await daemon.execute('createCorner', { ...authority(report), targetRoomId: ROOM,
    name: 'Next', objective: 'Continue the assigned widget',
    brief: { spec: 'Continue the assigned widget', approval: { sourceMessageId: report.sourceMessageId } } }, RUBY);
  expect((await db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`, [next.cornerId])).rows[0])
    .toMatchObject({ approval_basis: { approvedBy: HUMAN, snapshot: 'Build the widget in the target Room' } });
});

it('a green head whose reviewer command cannot be queued reports the reason to its commander', async () => {
  const opened = await open();
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
    JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 42, headSha: '9'.repeat(40) } })]);
  await advanceCorner(db, opened.cornerId, { kind: 'push', contents: { headSha: '9'.repeat(40) } });
  await db.query(`CREATE FUNCTION refuse_review_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.reason IN ('subscribed_event','corner_review_dispatch') THEN RAISE EXCEPTION 'review dispatch unavailable'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER refuse_review_command BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_review_command()`);
  try {
    await systemLine(db, { roomId: opened.cornerId, authorId: WORKER, subject: GITHUB_SUBJECT,
      verb: 'passed checks', kind: 'check-passed' });
    const report = (await commands(DM, RUBY)).find(c => c.reason === 'report');
    expect(report?.source.body).toMatch(/^blocked:.*reviewer/);
    expect(report?.private).toBe(true);
    expect((await db.query(`SELECT 1 FROM messages WHERE text LIKE '%restore review dispatch%'`)).rowCount).toBe(0);
  } finally {
    await db.query(`DROP TRIGGER refuse_review_command ON agent_commands; DROP FUNCTION refuse_review_command()`);
  }
});

// Reproduction corner-subtree-175524: replay the reported recruitment path.
it('Reproduction corner-subtree-175524: the reported corner payload creates zero commands', async () => {
  const cornerId = 'f95aa673-2eb5-491a-930b-51dc1aa2d2ee';
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'truthful-corner-states',$4)`, [cornerId, WS, ROOM, WORKER]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [cornerId, WORKER]);
  for (const member of [WORKER, RUBY]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [WS, cornerId, member]);
  const opening = await createAgentCommand(db, { roomId: cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { text: 'Make corner state truthful', authorId: RUBY, fromRoomId: DM, kind: 'order' } });
  const turn = (await commands(cornerId, WORKER)).find(c => c.id === opening!.id)!;
  await claim(turn);
  const before = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  // Exact production payload retrieved read-only from the 17:55:24 order.
  const text = "Read-only adversarial implementation review for Jellybean's active truthful-corner-states corner f95aa673-2eb5-491a-930b-51dc1aa2d2ee, brief revision 1. Do not edit, commit, push, open a corner, change implementer, or report to Ruby. Read its brief via inspect_corner; report findings to me through this order. Step 0 file map is posted there. Need concrete smallest implementation plan for PR1 durable idle flags (commander only, once per span, worker schedule/subscription exclusions, excluding commander watch), WAITING blockers and persistent 24h reminders with human dismissal using existing approval/tray authority. Identify exact indexed writer/read paths and tests; avoid per-read messages scans. Also assess executing brief's two separate PRs when first merge archives this corner and only feature/corner-f95aa6732eb5 is authorized: propose compliant sequence. Current corner worktree has uncommitted draft state edits only in packages/api-contract/src/corner-state.ts and apps/server/src/chat-corner-counts.ts; do not treat them as finished. Include problems plus specific solutions. Report back once with findings, not progress.";
  for (const agent of [undefined, RUBY]) {
    await expect(daemon.execute('order', { ...authority(turn), address: ROOM, agent, text }, WORKER))
      .rejects.toThrow('Corners can only order corners they opened. Report to your commander instead.');
    expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  }
  console.log('[corner-subtree-175524] f95aa673 corner_objective → bb91a1c7: exact payload rejected; zero commands created');
});

it('corner orders stay in their explicitly opened subtree', async () => {
  const opened = await open();
  const sibling = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    idempotencyKey: 'sibling', name: 'Sibling', objective: 'Build a sibling widget', implementer: 'worker',
    brief: { spec: 'Sibling widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
  }, RUBY);
  const turn = await worker(opened.cornerId);
  const child = await daemon.execute('createCorner', { ...authority(turn), targetRoomId: ROOM,
    idempotencyKey: 'delegated-child', name: 'Child', objective: 'Build a child widget', implementer: 'ruby',
    brief: { spec: 'Child widget', repositoryWork: false, approval: { sourceMessageId: turn.sourceMessageId } },
  }, WORKER);
  const otherRoom = randomUUID(), otherCorner = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Other Room',$3)`, [otherRoom, WS, HUMAN]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Other corner',$4)`,
    [otherCorner, WS, otherRoom, HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, otherRoom, WORKER]);
  expect((await daemon.execute('getCornerRestoreState', { cornerId: child.cornerId }, WORKER)).openedFromCornerId)
    .toBe(opened.cornerId);
  expect((await daemon.execute('getCornerRestoreState', { cornerId: sibling.cornerId }, WORKER)).openedFromCornerId)
    .toBeUndefined();
  const before = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  for (const address of [ROOM, DM, otherRoom, otherCorner, sibling.cornerId, opened.cornerId, RUBY]) {
    await expect(daemon.execute('order', { ...authority(turn), address, text: 'Do the review' }, WORKER))
      .rejects.toThrow('Corners can only order corners they opened. Report to your commander instead.');
    expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  }
  for (const address of [child.cornerId]) {
    await daemon.execute('order', { ...authority(turn), address, text: 'Review this widget' }, WORKER);
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='order'`, [address])).rowCount).toBe(1);
  }
  const childTurn = (await commands(child.cornerId, RUBY)).find(c => c.reason === 'order')!;
  await claim(childTurn);
  const grandchild = await daemon.execute('createCorner', { ...authority(childTurn), targetRoomId: ROOM,
    idempotencyKey: 'grandchild', name: 'Grandchild', objective: 'Build the grandchild widget', implementer: 'worker',
    brief: { spec: 'Grandchild widget', repositoryWork: false, approval: { sourceMessageId: childTurn.sourceMessageId } },
  }, RUBY);
  await daemon.execute('order', { ...authority(turn), address: grandchild.cornerId, text: 'Coordinate this widget' }, WORKER);
  await daemon.execute('order', { ...authority(childTurn), address: grandchild.cornerId, text: 'Work in the grandchild' }, RUBY);
  await expect(daemon.execute('order', { ...authority(childTurn), address: opened.cornerId, text: 'Order parent' }, RUBY))
    .rejects.toThrow('Corners can only order corners they opened.');
  const grandchildBrief = (await daemon.execute('getCornerRestoreState', { cornerId: grandchild.cornerId }, WORKER)).brief!;
  await daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: grandchild.cornerId, expectedRevision: 1,
    brief: { spec: 'Clarified grandchild widget', change: 'Clarify', repositoryWork: false,
      approval: { sourceMessageId: grandchildBrief.approval!.sourceMessageId } } }, WORKER);
  await daemon.execute('archiveCorner', { ...authority(turn), cornerId: grandchild.cornerId }, WORKER);

});
it('issues-triage can order and revise fix corners while opening cannot escape its Room', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query(`UPDATE rooms SET name='issues-triage' WHERE id=$1`, [opened.cornerId]);
  const child = await daemon.execute('createCorner', { ...authority(turn), targetRoomId: ROOM,
    idempotencyKey: 'triage-fix', name: 'Fix', objective: 'Fix the assigned widget', implementer: 'ruby',
    brief: { spec: 'Fix the widget', repositoryWork: false, approval: { sourceMessageId: turn.sourceMessageId } },
  }, WORKER);
  await daemon.execute('order', { ...authority(turn), address: child.cornerId, text: 'Fix the widget' }, WORKER);
  const revised = await daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: child.cornerId,
    expectedRevision: 1, brief: { spec: 'Fix the widget with clarified criteria', repositoryWork: false,
      change: 'Clarify criteria', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER);
  expect(revised.revision).toBe(2);
  await daemon.execute('archiveCorner', { ...authority(turn), cornerId: child.cornerId }, WORKER);
  expect((await db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [child.cornerId])).rows[0]).toEqual({ archived: true });
  await expect(daemon.execute('createCorner', { ...authority(turn), targetRoomId: DM,
    idempotencyKey: 'escape', name: 'Escape', objective: 'Recruit outside the Room',
    brief: { spec: 'Escape', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER))
    .rejects.toThrow('Report to your commander instead.');
});
it('corner mentions still wake an instance in the same corner', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: '@ruby review this here' }, WORKER);
  expect((await commands(opened.cornerId, RUBY)).length).toBeGreaterThan(0);
  expect((await commands(ROOM, RUBY))).toEqual([]);
});

it('corner revisions and closes reject self and unrelated legacy corners', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const sibling = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    idempotencyKey: 'legacy', name: 'Legacy', objective: 'Build a legacy widget', implementer: 'worker',
    brief: { spec: 'Legacy widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
  }, RUBY);
  for (const cornerId of [opened.cornerId, sibling.cornerId]) {
    await expect(daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId, expectedRevision: 1,
      brief: { spec: 'Wake unrelated work', change: 'Wake', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER))
      .rejects.toThrow('Corners can only order corners they opened.');
    await expect(daemon.execute('archiveCorner', { ...authority(turn), cornerId }, WORKER))
      .rejects.toThrow('Corners can only order corners they opened.');
    expect((await db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]).toEqual({ archived_at: null });
  }
});

it('migration leaves legacy opening provenance empty and preserves new provenance', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const child = await daemon.execute('createCorner', { ...authority(turn), targetRoomId: ROOM,
    idempotencyKey: 'migration-child', name: 'Child', objective: 'Build a child widget',
    brief: { spec: 'Child widget', repositoryWork: false, approval: { sourceMessageId: turn.sourceMessageId } },
  }, WORKER);
  await migrate(db);
  expect((await db.query(`SELECT opened_from_corner_id FROM corner_facts WHERE corner_id=$1`, [opened.cornerId])).rows[0])
    .toEqual({ opened_from_corner_id: null });
  expect((await db.query(`SELECT opened_from_corner_id FROM corner_facts WHERE corner_id=$1`, [child.cornerId])).rows[0])
    .toEqual({ opened_from_corner_id: opened.cornerId });
});
