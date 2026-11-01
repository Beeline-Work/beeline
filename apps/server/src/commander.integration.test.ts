import quotedTagPosts from './test-fixtures/quoted-tag-posts.json';
import { flushDueCommanderWakes } from './commander-wakes.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { setCornerHold } from './corner-holds.js';
import { cornerMergeGate } from './corner-lifecycle.js';
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
import { unreadMessageSql } from './read-cursor.js';
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
  Object.assign(daemon, { github: undefined });
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
it('records each corner order and report as one collapsed card in the corner only', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const before = (await db.query(`SELECT count(*)::int n FROM messages WHERE room_id=ANY($1::uuid[])`, [[ROOM, DM]])).rows[0]!.n;
  const unread = async () => (await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM messages message WHERE message.room_id=$1 AND ${unreadMessageSql('message')}`,
    [opened.cornerId, HUMAN])).rows[0]!.n;
  const unreadBefore = await unread();
  const reportText = 'blocked: need an endpoint decision\nv1 or v2?';
  await daemon.execute('report', { status: 'blocked', ...authority(turn), text: reportText }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: WORKER, body: reportText } });
  await claim(report);
  await daemon.execute('order', { ...authority(report), address: opened.cornerId, text: 'Use endpoint v2' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'Use endpoint v2' } });
  const cards = (await db.query<{ id: string; author_id: string; presentation: string; text: string; card: unknown }>(
    `SELECT id,author_id,presentation,text,card FROM messages WHERE room_id=$1 AND card_type='agent-command' ORDER BY created_at,id`,
    [opened.cornerId])).rows;
  expect(cards.map(({ id: _id, ...card }) => card)).toEqual(expect.arrayContaining([
    { author_id: WORKER, presentation: 'card', text: '@worker reported to @ruby · blocked',
      card: { kind: 'report', recipient: { id: RUBY, name: 'Ruby', handle: 'ruby' }, status: 'blocked', text: reportText } },
    { author_id: RUBY, presentation: 'card', text: '@ruby ordered @worker',
      card: { kind: 'order', recipient: { id: WORKER, name: 'Worker', handle: 'worker' }, text: 'Use endpoint v2' } },
  ]));
  expect(cards).toHaveLength(2);
  // The parent Room and the commander's DM gain nothing; the cards wake nobody.
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE room_id=ANY($1::uuid[])`, [[ROOM, DM]])).rows[0]!.n).toBe(before);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE source_message_id=ANY($1::text[])`, [cards.map(card => card.id)])).rowCount).toBe(0);
  expect(await unread()).toBe(unreadBefore);
  const view = (await phone.readRoom(opened.cornerId, HUMAN))!.messages.filter(m => m.agentCommand);
  expect(view.map(m => [m.author.pubkey, m.agentCommand])).toEqual(expect.arrayContaining([
    [WORKER, { kind: 'report', recipient: { id: RUBY, name: 'Ruby', handle: 'ruby' }, status: 'blocked', text: reportText }],
    [RUBY, { kind: 'order', recipient: { id: WORKER, name: 'Worker', handle: 'worker' }, text: 'Use endpoint v2' }],
  ]));
});
it.each(['needs_decision: choose the product scope', 'needs-decision: choose the product scope', 'needs-decision: choose the product scope @captain'])('R1 delivers decision reports with the display prefix in the original DM: %s', async (inputText) => {
  const text = inputText.replace(/^needs_decision:/, 'needs-decision:');
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(turn), text: inputText, ask: 'Which product scope should we use?' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(report), text: inputText, ask: 'Which product scope should we use?' }, RUBY);
  const rows = (await db.query(`SELECT room_id,author_id,text,card FROM messages WHERE text=$1`,
    [text])).rows;
  expect(rows).toEqual([{ room_id: DM, author_id: RUBY, text, card: { ask: 'Which product scope should we use?', reportToId: HUMAN } }]);
  expect((await phone.readRoom(DM, HUMAN))?.messages.some(m => m.text === rows[0]!.text)).toBe(true);
});
it('chain of command: a corner agent cannot tag a person above its commander', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const text = '@captain Approve the reviewer-link fetch here?';
  await expect(daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text }, WORKER))
    .rejects.toThrow('@captain is not your direct commander. Your commander is @ruby in Captain and Ruby.');
  await expect(daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text: '@channel approve?' }, WORKER))
    .rejects.toThrow('not your direct commander');
  await expect(daemon.execute('postRoomMessage', { ...authority(turn), text }, WORKER))
    .rejects.toThrow('not your direct commander');
  expect((await db.query(`SELECT 1 FROM messages WHERE text=$1`, [text])).rowCount).toBe(0);
  // The same ask goes up by report, and Ruby asks the Captain where the Captain gave the order.
  await daemon.execute('report', { status: 'needs_decision', ...authority(turn), text: 'needs-decision: Approve the reviewer-link fetch?' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  await daemon.execute('report', { status: 'needs_decision', ...authority(report), text: 'needs-decision: Approve the reviewer-link fetch?' }, RUBY);
  const tray = await phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN);
  expect(tray.items.map(item => [item.roomId, item.text])).toEqual([[DM, 'Approve the reviewer-link fetch?']]);
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%@captain%'`, [opened.cornerId])).rowCount).toBe(0);
});
it('chain of command: a corner agent may tag the person who directed this turn', async () => {
  const opened = await open();
  await worker(opened.cornerId);
  await phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId: randomBytes(32).toString('hex'), text: '@worker which endpoint did you pick?' }, HUMAN);
  const asked = (await commands(opened.cornerId, WORKER)).find(c => c.reason !== 'order' && c.source.authorId === HUMAN)!;
  await claim(asked);
  const reply = await daemon.execute('postRoomMessage', { ...authority(asked), text: '@captain v2. Keep it?' }, WORKER);
  expect((await db.query(`SELECT room_id FROM messages WHERE id=$1`, [reply.id])).rows[0]?.room_id).toBe(opened.cornerId);
});
it('R1 names both fields when report status and prefix disagree', async () => {
  await expect(daemon.execute('report', { ...authority(order), status: 'done',
    text: 'blocked: choose scope' }, RUBY)).rejects.toThrow('received status "done" and text prefix "blocked:"');
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
  const github = new GitHubOperations(db, {} as GitHubOAuthClient, {} as GitHubAppClient, 'secret');
  vi.spyOn(github, 'assertCornerReviewerNotAuthor').mockResolvedValue(undefined);
  Object.assign(daemon, { github });
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
it.each([['@ruby', false], [RUBY, false], ['@opener', false], ['@captain', false], [undefined, false], ['@ruby', true], [RUBY, true]] as const)('Reproduction R1: a scheduled report uses explicit recipient %s with batched orders=%s and preserves the default', async (to, batched) => {
  const opener = '8'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Opener','opener') ON CONFLICT DO NOTHING`, [opener]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [opener, HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, opener]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, DM, opener]);
  const opened = await open();
  await db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [opened.cornerId, opener]);
  const initial = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  if (batched) await db.query('UPDATE agents SET wake_batch_minutes=1 WHERE agent_id=$1', [WORKER]);
  await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Watch the release and report back' }, RUBY);
  if (batched) {
    await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: '@opener lead another task' }, HUMAN);
    const other = (await daemon.execute('getAgentCommands', { roomId: DM }, opener)).commands.find(c => c.reason !== 'report')!;
    await claim(other);
    await daemon.execute('order', { ...authority(other), address: opened.cornerId, agent: 'worker', text: 'Another task for another orderer' }, opener);
  }
  const assigned = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order')!;
  await claim(assigned);
  if (batched) {
    expect(assigned.coalescedContext).toBeTruthy();
    await db.query('UPDATE agents SET wake_batch_minutes=0 WHERE agent_id=$1', [WORKER]);
  }
  const schedule = await daemon.execute('createAgentSchedule', { ...authority(assigned), title: 'Check release',
    prompt: 'Finish watching the release', cadence: { kind: 'interval', everyMinutes: 1 }, maxRuns: 1 }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(assigned), agentId: WORKER, status: 'complete' }, WORKER);
  await db.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [schedule.scheduleId]);
  expect(await new AgentScheduleLoop(db).runOnce()).toBe(1);
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'schedule')!;
  await claim(wake);
  for (const invalid of ['@missing']) {
    await expect(daemon.execute('report', { ...authority(wake), to: invalid, status: 'done', text: 'done: release finished' }, WORKER))
      .rejects.toThrow('current member handle or id');
  }
  expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report'`)).rows).toEqual([]);
  await expect(daemon.execute('report', { ...authority(wake), to, status: 'done', text: 'done: release finished' }, WORKER))
    .resolves.toMatchObject({ delivered: true });
  if (to === '@captain') {
    expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text=$2`, [opened.cornerId, 'done: release finished'])).rows)
      .toEqual([{ text: 'done: release finished' }]);
  } else {
    const recipient = to === '@opener' || !to ? opener : RUBY;
    const returnRoom = to === '@opener' ? opened.cornerId : DM;
    expect((await commands(returnRoom, recipient)).filter(c => c.reason === 'report'))
      .toEqual([expect.objectContaining({ source: expect.objectContaining({ body: 'done: release finished', authorId: WORKER }) })]);
    expect((await db.query(`SELECT id FROM agent_commands WHERE agent_id=$1 AND reason='report'`, [recipient === RUBY ? opener : RUBY])).rows).toEqual([]);
  }
  if (to === '@ruby' || to === RUBY) await expect(daemon.execute('report', { ...authority(wake), to, status: 'done', text: 'done: release finished' }, WORKER))
    .resolves.toMatchObject({ skipped: true });
  if (batched) expect((await db.query('SELECT report_outcome FROM agent_commands WHERE id=$1', [assigned.id])).rows[0])
    .toMatchObject({ report_outcome: 'done' });

});
it('report to answers the latest human command from a later system wake', async () => {
  const opened = await open(), initial = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  const messageId = randomBytes(32).toString('hex');
  await phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId, text: '@worker finish my check' }, HUMAN);
  const directed = (await commands(opened.cornerId, WORKER)).find(c => c.sourceMessageId === messageId)!;
  await claim(directed);
  await daemon.execute('postAgentTurnReceipt', { ...authority(directed), agentId: WORKER, status: 'complete' }, WORKER);
  await systemLine(db, { roomId: opened.cornerId, authorId: HUMAN, subject: { kind: 'system', name: 'Scheduler' },
    verb: 'ran a schedule', kind: 'schedule-ran', wakes: [WORKER] });
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'schedule')!;
  await claim(wake);
  await expect(daemon.execute('report', { ...authority(wake), to: '@captain', status: 'done', text: 'done: human check finished' }, WORKER))
    .resolves.toMatchObject({ delivered: true });
  expect((await db.query(`SELECT report_outcome FROM agent_commands WHERE id=$1`, [directed.id])).rows[0])
    .toMatchObject({ report_outcome: 'done' });
});
it.each([false, true])('REPORT-RETURN-403: scheduled completion uses opening commander and enforces revocation=%s', async (revoked) => {
  const opened = await open();
  const initial = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":1}', 'Finish assigned work',1,now()-interval '1 minute')`,
    [randomUUID(), WS, opened.cornerId, WORKER]);
  expect(await new AgentScheduleLoop(db).runOnce()).toBe(1);
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'schedule')!;
  expect(wake).toBeDefined();
  await claim(wake);
  if (revoked) await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  const outcome = daemon.execute('report', { ...authority(wake), status: 'done', text: 'done: assigned work completed' }, WORKER);
  if (revoked) {
    await expect(outcome).rejects.toThrow('commander is no longer a member of the return address');
    expect((await db.query(`SELECT id FROM agent_commands WHERE reason='report' AND private_payload->>'text'=$1`,
      ['done: assigned work completed'])).rows).toEqual([]);
  } else {
    await expect(outcome).resolves.toMatchObject({ delivered: true });
    const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ private: true, source: { authorId: WORKER, body: 'done: assigned work completed' } });
    expect((await db.query(`SELECT id FROM messages WHERE text=$1 AND presentation='message'`,
      ['done: assigned work completed'])).rows).toEqual([]);
  }
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

it.each(['working', 'activity', 'other-place', 'optimistic'])(
  'Reproduction delivery-evidence: pending wake with %s evidence', async (evidence) => {
    const opened = await open();
    const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
    await db.query(`UPDATE agent_commands SET created_at=now()-interval '3 minutes' WHERE id=$1`, [pending.id]);
    if (evidence === 'activity' || evidence === 'other-place') {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
        VALUES($1,$2,$3,'Reading source','activity')`,
        [randomBytes(32).toString('hex'), evidence === 'activity' ? opened.cornerId : ROOM, WORKER]);
    } else if (evidence === 'working') {
      await db.query(`UPDATE agent_turns SET generation_id='running-helper' WHERE room_id=$1 AND agent_id=$2`, [opened.cornerId, WORKER]);
    }
    await noteBlockedCornerChecks(db);
    const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
    expect(reports).toHaveLength(evidence === 'working' || evidence === 'activity' ? 0 : 1);
  },
);

it('Reproduction reported-stall: delivered done survives loss of terminal receipt', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: widget complete' }, WORKER);
  const { ConnectionPresence } = await import('./connection-presence.js');
  await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, turn.turnRequestId]);
  const presence = new ConnectionPresence(db, new LiveHub());
  try {
    await presence.start();
    await vi.waitFor(async () => expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
      [opened.cornerId, turn.turnRequestId])).rows[0]?.status).toBe('complete'));
  } finally { await presence.stop(); }
  expect((await db.query(`SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, turn.turnRequestId])).rows).toEqual([{ status: 'complete', failure_reason: null }]);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report').map(c => c.source.body))
    .toEqual(['done: widget complete']);
  expect((await db.query(`SELECT state,hiccup_attempts FROM agent_commands WHERE id=$1`, [turn.id])).rows)
    .toEqual([{ state: 'complete', hiccup_attempts: 0 }]);
  console.info('Demonstrated reported-stall: commander retains done; worker complete; no failure or retry');
});

it('Reproduction R1: pickup deadline keeps work queued behind a claimed turn', async () => {
  const opened = await open();
  const running = (await commands(opened.cornerId, WORKER))[0]!;
  // The second wake arrives just before the first claim (the production race).
  const queued = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'corner_background_tool',
    privatePayload: { kind: 'lifecycle', text: 'Background tool completed', authorId: WORKER, fromRoomId: opened.cornerId } });
  await db.query(`UPDATE agent_commands SET wake_after=NULL WHERE id=$1`, [queued!.id]);
  expect((await db.query(`SELECT generation_id FROM agent_turns WHERE request_id=$1`, [queued!.turn_request_id])).rows)
    .toEqual([{ generation_id: 'pending:' + queued!.id }]);
  await claim(running);
  await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes'
    WHERE room_id=$1 AND request_id=$2`, [opened.cornerId, queued!.turn_request_id]);
  const { ConnectionPresence } = await import('./connection-presence.js');
  const presence = new ConnectionPresence(db, new LiveHub());
  try {
    await presence.start();
    await vi.waitFor(async () => expect((await db.query(`SELECT 1 FROM agent_turns
      WHERE room_id=$1 AND request_id=$2 AND generation_id LIKE 'pending:%'`,
      [opened.cornerId, queued!.turn_request_id])).rows).toEqual([]));
    await new Promise(resolve => setTimeout(resolve, 200));
  } finally { await presence.stop(); }
  expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, queued!.turn_request_id])).rows).toEqual([]);
  expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%did not claim%'`,
    [opened.cornerId])).rows).toEqual([]);
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])).rows)
    .toEqual([{ state: 'pending' }]);
  await daemon.execute('postAgentTurnReceipt', { ...authority(running), agentId: WORKER, status: 'complete' }, WORKER);
  const next = (await commands(opened.cornerId, WORKER)).find(command => command.id === queued!.id)!;
  expect(next).toBeDefined();
  await claim(next);
  expect((await db.query(`SELECT status,generation_id FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, next.turnRequestId])).rows).toEqual([{ status: 'working', generation_id: 'proof-generation' }]);
});

it.each(['unclaimed', 'disconnected', 'connected'])('Reproduction explained-stall: %s reaches the corner or commander with its cause', async kind => {
  const opened = await open();
  const turn = (await commands(opened.cornerId, WORKER))[0]!;
  if (kind !== 'unclaimed') {
    await claim(turn);
    await db.query(`UPDATE agent_commands SET hiccup_attempts=3 WHERE id=$1`, [turn.id]);
  }
  if (kind === 'connected') {
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('proof') ON CONFLICT(instance_id) DO UPDATE SET renewed_at=now()`);
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
      VALUES($1,1,'proof','proof')`, [WORKER]);
  }
  await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1`, [opened.cornerId]);
  const { ConnectionPresence } = await import('./connection-presence.js');
  const presence = new ConnectionPresence(db, new LiveHub());
  try {
    await presence.start();
    await vi.waitFor(async () => expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1`, [opened.cornerId])).rows[0]?.status).toBe('failed'));
  } finally {
    await presence.stop();
    if (kind === 'connected') {
      await db.query(`DELETE FROM agent_connections WHERE connection_id='proof' AND agent_id=$1`, [WORKER]);
      await db.query(`DELETE FROM live_server_instances WHERE instance_id='proof'`);
    }
  }
  const failure = (await db.query<{ failure_reason: string }>(`SELECT failure_reason FROM agent_turns WHERE room_id=$1`, [opened.cornerId])).rows[0]!.failure_reason;
  expect(failure).toContain(kind === 'unclaimed' ? 'did not claim the queued turn within 90 seconds' :
    kind === 'connected' ? 'connected but stopped reporting' : 'helper disconnected');
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports.some(c => c.source.body.includes(failure))).toBe(true);
  if (kind === 'unclaimed') expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0]?.state).toBe('pending');
  console.info(`Demonstrated explained-stall (${kind}): ${failure}`);
});

it('Reproduction named-stall: exhausted corner stall names its source in the commander inbox', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query('UPDATE agent_commands SET hiccup_attempts=3 WHERE id=$1', [turn.id]);
  const { noteFirstSilence } = await import('./turn-silence-notice.js');
  await noteFirstSilence(db, new LiveHub(), {
    roomId: opened.cornerId, requestId: turn.turnRequestId!, agentId: WORKER,
    generationId: 'proof-generation', reason: 'the turn stalled', reasonKind: 'hiccup', stalled: true,
  });
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(1);
  expect(reports[0]!.source.body).toContain('Widget');
  expect(reports[0]!.source.body).toContain(opened.cornerId);
  expect(reports[0]!.source.body).toContain('the turn stalled');
});

it('Reproduction quiet-unreachable: names the failed corner and agent once per failure span', async () => {
  const opened = await open();
  const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
  await db.query(`UPDATE agent_commands SET created_at=now()-interval '3 minutes' WHERE id=$1`, [pending.id]);
  // No helper connection or real turn: a genuinely unreachable worker still reports.
  expect((await db.query('SELECT 1 FROM agent_connections WHERE agent_id=$1 AND released_at IS NULL', [WORKER])).rowCount).toBe(0);
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

it('allows one new unreachable notice after worker recovery and the automatic report cooldown', async () => {
  const opened = await open();
  const pending = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2', [opened.cornerId, WORKER])).rows[0]!;
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, pending.id, pending);
  const turn = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete', completionKind: 'no-reply' }, WORKER);
  const next = (await db.query<CommandRow>(`INSERT INTO agent_commands
    (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
    SELECT 'next-failed-wake',room_id,agent_id,source_message_id,'next-failed-wake',action,reason,root_command_id,root_source_message_id,agent_depth
    FROM agent_commands WHERE id=$1 RETURNING *`, [pending.id])).rows[0]!;
  await db.query(`UPDATE automatic_report_wakes SET next_at=now()-interval '1 second' WHERE corner_id=$1`,[opened.cornerId]);
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, next.id, next);
  await noteCornerAgentUnreachable(db, opened.cornerId, WORKER, next.id, next);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(2);
});
it('reconnect recovery keeps every private report, even when each was queued offline', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  for (const text of ['blocked: missing input', 'failed: build stopped', 'needs-decision: select scope'])
    await daemon.execute('report', { status: text.split(':')[0]!.replace('-', '_') as import('@beeline/api-contract/daemon').AgentReportStatus, ...authority(turn), text, ask: 'Which product scope should we use?' }, WORKER);
  await db.query(`UPDATE agent_commands SET created_offline=true,created_at=now()-interval '10 minutes' WHERE reason='report'`);
  // Preserve causal order: the assignment preceded these offline reports.
  await db.query(`UPDATE agent_commands SET created_at=now()-interval '11 minutes' WHERE id=$1`, [turn.id]);
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
it('R-REVISE revises and restores the cited approval without a false reproduction warning', async () => {
  const opened = await open();
  await db.query(`UPDATE rooms SET repository_resolution='repository',repository_key='owner/repo' WHERE id=$1`, [ROOM]);
  const revision = await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: '## Intent\nFix the reported endpoint bug.\n## Reproduction R-REVISE\nRevise the brief and restore it; the approval link disappears.', repositoryWork: true,
      approval: { sourceMessageId: order.sourceMessageId }, change: 'Clarify the endpoint' } }, RUBY);
  expect(revision.revision).toBe(2);
  const restored = await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY);
  expect(restored.brief?.approval?.sourceMessageId).toBe(order.sourceMessageId);
  expect(revision.warnings ?? []).toEqual([]);
});
it('Reproduction commander-direct: commander revises without a cited approval', async () => {
  const opened = await open();
  const revised = await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Build the clarified widget', change: 'Clarify scope' },
  }, RUBY);
  expect(revised.revision).toBe(2);
  const restored = await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY);
  expect(restored.brief?.approval).toMatchObject({ approvedBy: RUBY, approverName: 'Ruby' });
  const turn = await worker(opened.cornerId);
  await expect(daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: opened.cornerId,
    expectedRevision: 2, brief: { spec: 'Worker changes scope', change: 'No cited approval' },
  }, WORKER)).rejects.toMatchObject({ status: 403 });
  expect((await db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2`,
    [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: { kind: 'commander-direct', approvedBy: RUBY } });
});

describe('a worker records a later waiver in its corner brief', () => {
  const STRANGER = 'd'.repeat(64), OUTSIDER = 'e'.repeat(64);
  const revise = async (turn: AgentCommand, cornerId: string, expectedRevision: number, sourceMessageId: string) => {
    // Self-revision now returns to a Room/DM turn; exercise approval membership from a reachable turn.
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

  it('HUMAN-01: a worker accepts any shared-Room human approval and announces the change', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WS, ROOM, STRANGER]);
    const outside = randomBytes(32).toString('hex');
    await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: outside, text: 'Approved: waive the proof.' }, STRANGER);
    const revision = (sourceMessageId: string) => daemon.execute('reviseCornerBrief', {
      ...authority(turn), cornerId: opened.cornerId, expectedRevision: 1,
      brief: { spec: 'Build the widget; proof waived', repositoryWork: false, change: 'Record approval', approval: { sourceMessageId } },
    }, WORKER);
    expect(await revision(outside)).toMatchObject({ revision: 2 });
    expect(await approval(opened.cornerId)).toMatchObject({ approvedBy: STRANGER, sourceMessageId: outside });
    await daemon.execute('postRoomMessage', { ...authority(turn), text: '@ruby Recorded the proof waiver approved by Stranger.' }, WORKER);
    expect((await phone.readRoom(opened.cornerId, HUMAN))?.messages.some(m => m.text === '@ruby Recorded the proof waiver approved by Stranger.')).toBe(true);
    console.log('HUMAN-01: shared-Room member approval saved as revision 2 and announced in the corner');
  });

  it('refuses a stored approval when its human author is not a Room member', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const outside = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Approved')`, [outside, ROOM, STRANGER]);
    // A stored snapshot does not substitute for current membership.
    await db.query(`UPDATE corner_brief_revisions SET approval_basis=approval_basis || $2::jsonb WHERE corner_id=$1`,
      [opened.cornerId, JSON.stringify({ kind: 'explicit-human-answer', sourceMessageId: outside, approvedBy: STRANGER, snapshot: 'Approved' })]);
    await expect(revise(turn, opened.cornerId, 1, outside)).rejects.toThrow('must name a human message or commander order');
    expect((await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, WORKER)).brief?.revision).toBe(1);
  });

  it('refuses a DM approval after the human membership is removed', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await directMessage(STRANGER, STRANGER, 'Waive the proof.');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [rooms.get(waiver), STRANGER]);
    await expect(revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('current Room member');
  });

  it('refuses approval from an unrelated Room even when the human belongs to it', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await directMessage(STRANGER, STRANGER, 'Waive the proof.');
    await db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [rooms.get(waiver)]);
    await expect(revise(turn, opened.cornerId, 1, waiver)).rejects.toThrow('must name a human message or commander order');
  });

  it('accepts an earlier private order from the corner\'s commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Skip the proof.' }, RUBY);
    const waiver = (await commands(opened.cornerId, WORKER)).find((command) => command.reason === 'order')!;
    expect((await revise(turn, opened.cornerId, 1, waiver.sourceMessageId)).revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ kind: 'commander-order', approvedBy: RUBY,
      sourceMessageId: waiver.sourceMessageId, snapshot: 'Skip the proof.' });
  });

  it('APPROVAL-CITATIONS: accepts the commander order card seen in the transcript', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Use the revised endpoint.' }, RUBY);
    const card = (await db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type='agent-command' AND card->>'text'=$2`,
      [opened.cornerId, 'Use the revised endpoint.'])).rows[0]!;
    expect((await revise(turn, opened.cornerId, 1, card.id)).revision).toBe(2);
    const restored = await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, WORKER);
    expect(restored.brief?.approval).toMatchObject({ sourceMessageId: card.id, text: 'Use the revised endpoint.',
      approvedBy: RUBY, approverName: 'Ruby' });
  });

  it('APPROVAL-CITATIONS: accepts a parent Room human message from a worker DM turn', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const id = randomBytes(32).toString('hex');
    await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id, text: 'Use the revised endpoint.' }, HUMAN);
    expect((await revise(turn, opened.cornerId, 1, id)).revision).toBe(2);
    const restored = await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, WORKER);
    expect(restored.brief?.approval).toMatchObject({ sourceMessageId: id, text: 'Use the revised endpoint.',
      approvedBy: HUMAN, approverName: 'Captain' });
  });

  it.each(['complete', 'cancelled'])('APPROVAL-CITATIONS: refuses a %s commander order', async (state) => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const command = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip proof.', authorId: RUBY, fromRoomId: ROOM, kind: 'order' } });
    await db.query(`UPDATE agent_commands SET state=$2 WHERE id=$1`, [command!.id, state]);
    await expect(revise(turn, opened.cornerId, 1, command!.id)).rejects.toThrow('must name a human message or commander order');
  });

  it('APPROVAL-CITATIONS: rejects reuse of a stored order after cancellation', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const command = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip proof.', authorId: RUBY, fromRoomId: ROOM, kind: 'order' } });
    expect((await revise(turn, opened.cornerId, 1, command!.id)).revision).toBe(2);
    await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [command!.id]);
    await expect(revise(turn, opened.cornerId, 2, command!.id)).rejects.toThrow('must name a human message or commander order');
  });

  it('APPROVAL-CITATIONS: stored approval does not authorize another agent as commander', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const command = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Skip proof.', authorId: OUTSIDER, fromRoomId: ROOM, kind: 'order' } });
    await db.query(`UPDATE corner_brief_revisions SET approval_basis=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
      JSON.stringify({ kind: 'commander-order', sourceMessageId: command!.id, approvedBy: OUTSIDER, snapshot: 'Skip proof.' })]);
    await expect(revise(turn, opened.cornerId, 1, command!.id)).rejects.toThrow('must name a human message or commander order');
  });

  it('APPROVAL-CITATIONS: refuses an agent-authored parent Room message', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const id = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Approved')`, [id, ROOM, RUBY]);
    await expect(revise(turn, opened.cornerId, 1, id)).rejects.toThrow('must name a human message or commander order');
  });

  it('HUMAN-01: accepts any human member approval in a DM shared with the worker', async () => {
    const opened = await open(), turn = await worker(opened.cornerId);
    const waiver = await directMessage(STRANGER, STRANGER, 'Waive the proof for this corner.');
    expect((await revise(turn, opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ approvedBy: STRANGER, sourceMessageId: waiver });
  });

  it('HUMAN-01: accepts any human member approval from the worker\'s active DM turn', async () => {
    const opened = await open();
    const waiver = await directMessage(STRANGER, STRANGER, 'Waive the proof for this corner.');
    expect((await revise(await dmTurn(waiver), opened.cornerId, 1, waiver)).revision).toBe(2);
    expect(await approval(opened.cornerId)).toMatchObject({ approvedBy: STRANGER, sourceMessageId: waiver });
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
      [WS, ROOM, OUTSIDER]);
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
it('Reproduction corner-subtree-175524: the reported named parent order succeeds', async () => {
  const cornerId = 'f95aa673-2eb5-491a-930b-51dc1aa2d2ee';
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'truthful-corner-states',$4)`, [cornerId, WS, ROOM, WORKER]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [cornerId, WORKER]);
  const opening = await createAgentCommand(db, { roomId: cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { text: 'Make corner state truthful', authorId: RUBY, fromRoomId: DM, kind: 'order' } });
  const turn = (await commands(cornerId, WORKER)).find(c => c.id === opening!.id)!;
  await claim(turn);
  const before = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  // Exact production payload retrieved read-only from the 17:55:24 order.
  const text = "Read-only adversarial implementation review for Jellybean's active truthful-corner-states corner f95aa673-2eb5-491a-930b-51dc1aa2d2ee, brief revision 1. Do not edit, commit, push, open a corner, change implementer, or report to Ruby. Read its brief via inspect_corner; report findings to me through this order. Step 0 file map is posted there. Need concrete smallest implementation plan for PR1 durable idle flags (commander only, once per span, worker schedule/subscription exclusions, excluding commander watch), WAITING blockers and persistent 24h reminders with human dismissal using existing approval/tray authority. Identify exact indexed writer/read paths and tests; avoid per-read messages scans. Also assess executing brief's two separate PRs when first merge archives this corner and only feature/corner-f95aa6732eb5 is authorized: propose compliant sequence. Current corner worktree has uncommitted draft state edits only in packages/api-contract/src/corner-state.ts and apps/server/src/chat-corner-counts.ts; do not treat them as finished. Include problems plus specific solutions. Report back once with findings, not progress.";
  await expect(daemon.execute('order', { ...authority(turn), address: ROOM, text }, WORKER))
    .rejects.toThrow('a Room order must name exactly one agent');
  expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  await daemon.execute('order', { ...authority(turn), address: ROOM, agent: RUBY, text }, WORKER);
  expect((await commands(ROOM, RUBY)).find(c => c.reason === 'order')?.source.body).toBe(text);
  console.log('[corner-subtree-175524] named parent Room order delivered privately; unnamed broadcast refused');
});

it('Reproduction corner-ancestor-rule: corner orders reach self, siblings and children while rejecting ancestors', async () => {
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
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$4,'member'),($1,$3,$5,'member')`, [WS, otherRoom, DM, RUBY, WORKER]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [otherCorner, RUBY]);
  await daemon.execute('order', { ...authority(turn), address: sibling.cornerId, agent: 'ruby', text: 'Review sibling' }, WORKER);
  await daemon.execute('order', { ...authority(turn), address: otherCorner, text: 'Review other corner' }, WORKER);
  await expect(daemon.execute('order', { ...authority(turn), address: otherRoom, agent: 'ruby', text: 'Review in other Room' }, WORKER))
    .rejects.toThrow('Corners can only order their own parent Room');
  const beforeDm = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  for (const address of [DM, RUBY, 'ruby', '@ruby']) {
    await expect(daemon.execute('order', { ...authority(turn), address, text: 'Review through DM' }, WORKER))
      .rejects.toThrow("Corners can't order DMs. Report to your commander instead.");
    expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(beforeDm);
  }
  await expect(daemon.execute('order', { ...authority(turn), address: otherRoom, text: 'Broadcast' }, WORKER))
    .rejects.toThrow('Corners can only order their own parent Room');
  await expect(daemon.execute('order', { ...authority(turn), address: randomUUID(), text: 'No membership' }, WORKER))
    .rejects.toThrow('address requires current membership');
  expect((await daemon.execute('getCornerRestoreState', { cornerId: child.cornerId }, WORKER)).openedFromCornerId)
    .toBe(opened.cornerId);
  expect((await daemon.execute('getCornerRestoreState', { cornerId: sibling.cornerId }, WORKER)).openedFromCornerId)
    .toBeUndefined();
  const before = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  for (const address of [ROOM, ROOM.toUpperCase()]) {
    await expect(daemon.execute('order', { ...authority(turn), address, text: 'Do the review' }, WORKER))
      .rejects.toThrow('a Room order must name exactly one agent');
    expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  }
  for (const address of [child.cornerId, opened.cornerId]) {
    await daemon.execute('order', { ...authority(turn), address, agent: 'ruby', text: 'Review this widget' }, WORKER);
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='order'`, [address])).rowCount).toBe(1);
  }
  const childTurn = (await commands(child.cornerId, RUBY)).find(c => c.reason === 'order')!;
  await claim(childTurn);
  const grandchild = await daemon.execute('createCorner', { ...authority(childTurn), targetRoomId: ROOM,
    idempotencyKey: 'grandchild', name: 'Grandchild', objective: 'Build the grandchild widget', implementer: 'worker',
    brief: { spec: 'Grandchild widget', repositoryWork: false, approval: { sourceMessageId: childTurn.sourceMessageId } },
  }, RUBY);
  await daemon.execute('order', { ...authority(turn), address: grandchild.cornerId, agent: 'ruby', text: 'Coordinate this widget' }, WORKER);
  await daemon.execute('order', { ...authority(childTurn), address: grandchild.cornerId, text: 'Work in the grandchild' }, RUBY);
  for (const address of [opened.cornerId]) {
    await expect(daemon.execute('order', { ...authority(childTurn), address, text: 'Order ancestor' }, RUBY))
      .rejects.toThrow("Corners can't order their parent Room. Report to your commander instead.");
  }
  const grandchildTurn = (await commands(grandchild.cornerId, WORKER)).find(c => c.reason === 'order')!;
  await claim(grandchildTurn);
  for (const address of [child.cornerId, opened.cornerId]) {
    await expect(daemon.execute('order', { ...authority(grandchildTurn), address, text: 'Order ancestor' }, WORKER))
      .rejects.toThrow("Corners can't order their parent Room. Report to your commander instead.");
  }
  for (const cornerId of [child.cornerId, opened.cornerId]) {
    await expect(daemon.execute('reviseCornerBrief', { ...authority(grandchildTurn), cornerId, expectedRevision: 1,
      brief: { spec: 'Ancestor work', change: 'Attempt', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER))
      .rejects.toThrow("Corners can't order their parent Room. Report to your commander instead.");
    await expect(daemon.execute('archiveCorner', { ...authority(grandchildTurn), cornerId }, WORKER))
      .rejects.toThrow("Corners can't order their parent Room. Report to your commander instead.");
  }
  console.log('[corner-ancestor-rule] sibling/self/child/parent Room orders delivered; ancestors and DM/agent addresses rejected; broadcasts and nonmembers refused');
  await daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: grandchild.cornerId, expectedRevision: 1,
    brief: { spec: 'Clarified grandchild widget', change: 'Clarify', repositoryWork: false,
      approval: { sourceMessageId: grandchildTurn.sourceMessageId } } }, WORKER);
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
      change: 'Clarify criteria' } }, WORKER);
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

it('corner revisions and closes accept self and sibling corners', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const sibling = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    idempotencyKey: 'legacy', name: 'Legacy', objective: 'Build a legacy widget', implementer: 'worker',
    brief: { spec: 'Legacy widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
  }, RUBY);
  for (const cornerId of [opened.cornerId, sibling.cornerId]) {
    const brief = (await daemon.execute('getCornerRestoreState', { cornerId }, WORKER)).brief!;
    await daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId, expectedRevision: 1,
      brief: { spec: 'Clarified work', change: 'Clarify', repositoryWork: false, approval: { sourceMessageId: brief.approval!.sourceMessageId } } }, WORKER);
  }
  for (const cornerId of [sibling.cornerId, opened.cornerId]) {
    await daemon.execute('archiveCorner', { ...authority(turn), cornerId }, WORKER);
    expect((await db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [cornerId])).rows[0]).toEqual({ archived: true });
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

it.each(['primary reviewer', 'fallback reviewer', 'commander'])('Reproduction reviewer-handback-2471: %s orders its corner worker', async (role) => {
  const opened = await open();
  if (role !== 'commander') {
    await db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [opened.cornerId, WORKER]);
    await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($2::text)) WHERE room_id=$1`, [opened.cornerId, WORKER]);
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2,reviewer_fallback_ids=$3 WHERE id=$1`,
      [ROOM, role === 'primary reviewer' ? RUBY : WORKER, role === 'fallback reviewer' ? [RUBY] : []]);
  }
  const queued = await createAgentCommand(db, { roomId: opened.cornerId, agentId: RUBY,
    sourceMessageId: null, reason: 'corner_review_dispatch',
    privatePayload: { text: 'Review the widget', authorId: HUMAN, fromRoomId: ROOM, kind: 'order' } });
  const turn = (await commands(opened.cornerId, RUBY)).find(c => c.id === queued!.id)!;
  await claim(turn);
  await daemon.execute('order', { ...authority(turn), address: opened.cornerId, text: 'FAIL: repair the widget' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'FAIL: repair the widget' } });
  console.log(`[reviewer-handback-2471] ${role} → own corner worker: repair order delivered privately`);
});

it('keeps Room opening facts historical while current worker and commander goals update', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query(`UPDATE rooms SET about='Legacy version 1.1.17 goal' WHERE id=$1`, [opened.cornerId]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
    VALUES('goal-card',$1,$2,'Opened','daemon-fact',$3::jsonb)`,
    [ROOM, RUBY, JSON.stringify({ type: 'corner-open', cornerId: opened.cornerId, name: 'Widget', objective: 'Build the widget', sourceMessageId: 'source' })]);
  // Model a historical parent record explicitly; new DM opens no longer write it.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card,created_at)
    VALUES('legacy-opening',$1,$2,'Opened','daemon-fact',$3::jsonb,now()-interval '1 minute')`,
    [ROOM,RUBY,JSON.stringify({type:'corner-open',cornerId:opened.cornerId,name:'Widget',objective:'Widget'})]);
  const stored = (await db.query(`SELECT * FROM messages ORDER BY id`)).rows;
  const openingId = (await db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1
    AND card->>'cornerId'=$2 AND id<>'goal-card' AND card->>'type'='corner-open' LIMIT 1`,
    [ROOM, opened.cornerId])).rows[0]!.id;
  for (const [actor, command, objective] of [
    [WORKER, turn, 'Ship version 1.1.18'], [RUBY, order, 'Ship version 1.1.19'],
  ] as const) {
    const name = actor === WORKER ? 'Current-widget' : 'Next-widget';
    await daemon.execute('renameCorner', { ...authority(command), cornerId: opened.cornerId,
      name, objective }, actor);
    expect((await db.query(`SELECT objective FROM corner_facts WHERE corner_id=$1`, [opened.cornerId])).rows[0])
      .toMatchObject({ objective });
    expect((await db.query(`SELECT * FROM messages ORDER BY id`)).rows).toEqual(stored);
    const currentCard = { type: 'corner-open', cornerId: opened.cornerId, name: 'Widget', objective: 'Widget' };
    for (const page of [
      await phone.readRoom(ROOM, HUMAN),
      await phone.readHistory(ROOM, HUMAN),
      await phone.readHistoryAround(ROOM, HUMAN, 'goal-card'),
      await phone.readHistoryAfter(ROOM, HUMAN, openingId),
    ]) expect(page?.messages.find(message => message.id === 'goal-card')?.daemonFact).toMatchObject(currentCard);
    const live = await phone.readLiveDelta(ROOM, HUMAN, { type: 'message', messageId: 'goal-card' });
    expect(live?.type === 'message-delta' ? live.message.daemonFact : undefined).toMatchObject(currentCard);
    expect((await phone.readRoom(opened.cornerId, HUMAN))?.room.about).toBe(objective);
    expect((await phone.readCorners(ROOM, HUMAN))?.corners)
      .toContainEqual(expect.objectContaining({ corner: expect.objectContaining({ id: opened.cornerId, about: objective }) }));
    expect((await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, actor)).objective)
      .toBe(objective);
    expect((await daemon.execute('listRoomCorners', { roomId: ROOM }, actor)).corners)
      .toContainEqual(expect.objectContaining({ cornerId: opened.cornerId, objective }));
    expect((await db.query(`SELECT * FROM messages ORDER BY id`)).rows).toEqual(stored);
  }
});

it('pushes one background completion continuation with original order provenance after the turn ends', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [turn.id]);
  const completion = { ...authority(turn), toolCallId: 'build-1', title: 'npm test', status: 'completed' as const };
  await daemon.execute('postBackgroundToolCompletion', completion, WORKER);
  await daemon.execute('postBackgroundToolCompletion', completion, WORKER);
  const wakes = (await commands(opened.cornerId, WORKER)).filter(c => c.reason === 'corner_background_tool');
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ parentCommandId: turn.id,
    source: { body: expect.stringContaining('npm test (build-1) completed') } });
  await claim(wakes[0]!);
  await daemon.execute('report', { ...authority(wakes[0]!), status: 'blocked', text: 'blocked: test failed' }, WORKER);
  expect((await commands(DM, RUBY)).some(c => c.reason === 'report')).toBe(true);
  await expect(daemon.execute('postBackgroundToolCompletion', { ...completion, generationId: 'stale' }, WORKER))
    .rejects.toThrow('authority rejected');
  await expect(daemon.execute('postBackgroundToolCompletion', completion, RUBY)).rejects.toThrow();
  await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [turn.id]);
  await expect(daemon.execute('postBackgroundToolCompletion', { ...completion, toolCallId: 'other' }, WORKER))
    .rejects.toThrow('authority rejected');
});

it('makes an owner-approved systemctl user-bus command available in a subsequent corner turn', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const target = 'env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user';
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status,decided_by)
    VALUES('10000000-0000-4000-8000-000000000099',$1,$2,$3,'command',$4,'Manage user service',$5,'approved',$6)`,
    [WORKER, WS, ROOM, target, RUBY, HUMAN]);
  expect((await daemon.execute('listTurnAgentGrants', authority(turn), WORKER)).grants)
    .toContainEqual(expect.objectContaining({ target }));
});

it('does not resolve an opening card against a corner belonging to another parent Room', async () => {
  const opened = await open();
  // A resident call-site marker must not resolve another Room's private goal.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
    VALUES('resident-opening',$1,$2,'Opened','daemon-fact',$3::jsonb)`,
    [ROOM,RUBY,JSON.stringify({type:'corner-open',cornerId:opened.cornerId,name:'Widget',objective:'Widget',sourceMessageId:'source'})]);
  await db.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [opened.cornerId, DM]);
  await db.query(`UPDATE corner_facts SET objective='Private goal in another Room' WHERE corner_id=$1`, [opened.cornerId]);
  const view = await phone.readRoom(ROOM, HUMAN);
  expect(view?.messages.find(message => message.daemonFact?.cornerId === opened.cornerId)?.daemonFact)
    .toMatchObject({ name: 'Widget', objective: 'Widget' });
});

it('the same corner can order and report privately to its parent Room commander', async () => {
  const parentCommand = await createAgentCommand(db, { roomId: ROOM, agentId: RUBY,
    sourceMessageId: null, reason: 'order', privatePayload: { text: 'Coordinate this task', authorId: WORKER, fromRoomId: DM, kind: 'order' } });
  const parent = (await commands(ROOM, RUBY)).find(command => command.id === parentCommand!.id)!;
  await claim(parent);
  const opened = await daemon.execute('createCorner', { ...authority(parent), targetRoomId: ROOM,
    name: 'Proof', objective: 'Prove report routing', implementer: 'worker',
    brief: { spec: 'Deliver proof', repositoryWork: false, approval: { sourceMessageId: parent.id } } }, RUBY);
  const child = await worker(opened.cornerId);
  await daemon.execute('order', { ...authority(child), address: ROOM, agent: RUBY, text: 'Recruit parent' }, WORKER);
  await daemon.execute('report', { ...authority(child), status: 'blocked', text: 'blocked: need the commander decision' }, WORKER);
  expect((await commands(ROOM, RUBY)).find(command => command.reason === 'report'))
    .toMatchObject({ private: true, source: { authorId: WORKER, body: 'blocked: need the commander decision' } });
  expect((await db.query(`SELECT 1 FROM messages WHERE text=$1`, ['blocked: need the commander decision'])).rowCount).toBe(0);
});

it('public corner notes stay durable without waking a worker or commander', async () => {
  const opened = await open();
  const before = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  await daemon.execute('postCornerMessage', { ...authority(order), cornerId: opened.cornerId, text: 'A public note without work authority' }, RUBY);
  expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text=$2`, [opened.cornerId, 'A public note without work authority'])).rowCount).toBe(1);
  expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
});

it('lists only the caller’s own lifecycle watches at the current address', async () => {
  const opened = await open();
  await db.query(`INSERT INTO corner_watches(watcher_room_id,agent_id,corner_id,kinds) VALUES($1,$2,$3,'["merged"]'::jsonb)`, [DM, WORKER, opened.cornerId]);
  expect(await daemon.execute('listAgentWatches', { roomId: DM }, RUBY)).toEqual({ watches: [{ address: opened.cornerId, kinds: ['opened', 'merged'] }] });
});

it('compact schedule operations manage only self-owned sources', async () => {
  const mine = await daemon.execute('createAgentSchedule', { title: 'Scheduled check', ...authority(order), agentId: RUBY,
    prompt: 'Inspect my pending work', cadence: { kind: 'interval', everyMinutes: 5 } }, RUBY) as { scheduleId: string };
  const otherId = randomUUID();
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":5}'::jsonb,'Other agent work',now())`, [otherId, WS, DM, WORKER]);
  for (const action of ['update', 'delete'] as const) {
    await expect(daemon.execute(action === 'update' ? 'updateAgentSchedule' : 'deleteAgentSchedule', { ...authority(order), agentId: RUBY, selfOnly: true, scheduleId: otherId, prompt: 'Forged' }, RUBY))
      .rejects.toThrow('schedule not found');
  }
  const listed = await daemon.execute('listAgentSchedules', { ...authority(order), agentId: RUBY, selfOnly: true }, RUBY) as { schedules: { scheduleId: string }[] };
  expect(listed.schedules.map(schedule => schedule.scheduleId)).toEqual([mine.scheduleId]);
  const before = (await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  await daemon.execute('updateAgentSchedule', { ...authority(order), agentId: RUBY, selfOnly: true, scheduleId: mine.scheduleId, prompt: 'Updated self work' }, RUBY);
  await daemon.execute('deleteAgentSchedule', { ...authority(order), agentId: RUBY, selfOnly: true, scheduleId: mine.scheduleId }, RUBY);
  expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  expect((await db.query(`SELECT message FROM agent_schedules WHERE id=$1`, [otherId])).rows[0]).toEqual({ message: 'Other agent work' });
});

it.each(['primary', 'fallback'])('vocabulary: commander orders the child %s reviewer and its report returns privately', async kind => {
  const reviewer = '6'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Speedy','speedy') ON CONFLICT DO NOTHING`, [reviewer]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [reviewer,HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WS,reviewer,ROOM]);
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2,reviewer_fallback_ids=$3 WHERE id=$1`, [ROOM,kind === 'primary' ? reviewer : null,kind === 'fallback' ? [reviewer] : []]);
  const opened = await open();
  await daemon.execute('order', { ...authority(order), address:opened.cornerId, agent:'speedy', text:'Review the exact head' }, RUBY);
  const review = (await commands(opened.cornerId,reviewer)).find(command => command.reason === 'order')!;
  expect(review).toMatchObject({private:true,source:{body:'Review the exact head'}});
  await claim(review);
  await daemon.execute('report', { ...authority(review), status:'blocked', text:'blocked: waiting for green checks' }, reviewer);
  expect((await commands(DM,RUBY)).find(command => command.reason === 'report')?.source.body).toBe('blocked: waiting for green checks');
  expect((await db.query(`SELECT worker_agent_id FROM corner_facts WHERE corner_id=$1`,[opened.cornerId])).rows[0]?.worker_agent_id).not.toBe(reviewer);
});

it('vocabulary: corner post tags wake conversation in the posted place without an assignment', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const posted = await daemon.execute('postCornerMessage', { ...authority(turn), cornerId:opened.cornerId, text:'@ruby discuss the wording; @absent can you join?' }, WORKER);
  expect(posted.woken).toEqual(['ruby']);
  expect(posted.notWoken).toContainEqual({handle:'absent',reason:expect.stringContaining('member')});
  const reply = (await commands(opened.cornerId,RUBY)).find(command => command.reason === 'agent_tag')!;
  expect(reply.private).toBeFalsy();
  await claim(reply);
  await daemon.execute('postRoomMessage', {...authority(reply),text:'Here is my wording suggestion.'},RUBY);
  expect((await db.query(`SELECT room_id FROM messages WHERE text='Here is my wording suggestion.'`)).rows[0]?.room_id).toBe(opened.cornerId);
  expect((await commands(DM,RUBY)).some(command => command.reason === 'report')).toBe(false);
});

it('vocabulary: forbidden corner orders give a usable report step', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await expect(daemon.execute('order', {...authority(turn),address:DM,agent:'ruby',text:'Do parent work'},WORKER)).rejects.toThrow('Report to your commander');
  await daemon.execute('report', {...authority(turn),status:'blocked',text:'blocked: parent work needs the commander'},WORKER);
  expect((await commands(DM,RUBY)).find(command => command.reason === 'report')?.source.body).toContain('parent work');
});

it('vocabulary: public-note tags preserve the depth-three chain bound', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query(`UPDATE agent_commands SET agent_depth=3 WHERE id=$1`,[turn.id]);
  const posted = await daemon.execute('postCornerMessage', {...authority(turn),cornerId:opened.cornerId,text:'@ruby discuss this at the depth bound'},WORKER);
  expect(posted.woken).toEqual([]);
  expect(posted.notWoken).toContainEqual({handle:'ruby',reason:'agent tag chain depth limit reached'});
  expect((await db.query(`SELECT text FROM messages WHERE id=$1`,[posted.id])).rows[0]?.text).toContain('@ruby');
});

it('vocabulary: a configured reviewer outside the parent Room cannot be ordered', async () => {
  const reviewer = '6'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Speedy','speedy') ON CONFLICT DO NOTHING`,[reviewer]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[reviewer,HUMAN]);
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`,[ROOM,reviewer]);
  const opened = await open(), turn = await worker(opened.cornerId);
  await expect(daemon.execute('order', {...authority(turn),address:opened.cornerId,agent:'speedy',text:'Review this'},WORKER)).rejects.toThrow('order agent must be an agent member of this corner or its parent Room');
});

// Failure visibility uses the real receipt, silence owner and private transport.
async function privateAssignment() {
  const receipt = await daemon.execute('order', { ...authority(order), address: ROOM, agent: WORKER, text: 'Sign into the saved Amazon login' }, RUBY);
  const turn = (await commands(ROOM, WORKER)).find(c => c.id === receipt.id)!;
  await claim(turn);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'working' }, WORKER);
  return { turn, receipt };
}
it.each(['empty', 'no-reply'])('an unreported Room order completion stays complete and sends no failure on replay (%s)', async kind => {
  const { turn } = await privateAssignment();
  const input = { ...authority(turn), agentId: WORKER, status: 'complete' as const,
    ...(kind === 'no-reply' ? { completionKind: 'no-reply' as const } : {}), toolCalls: kind === 'empty' ? 0 : 1 };
  const before = (await db.query('SELECT id FROM messages ORDER BY id')).rows;
  await daemon.execute('postAgentTurnReceipt', { ...input }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...input }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  expect((await db.query('SELECT id FROM messages ORDER BY id')).rows).toEqual(before);
  expect((await db.query('SELECT status,failure_reason FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [turn.turnRequestId, WORKER])).rows[0])
    .toMatchObject({ status: 'complete', failure_reason: null });
});
it.each(['repeated-tool-call', 'free-agent-time-limit', 'login-required'])('failure visibility: %s reports the unresolved order once and reaches the original human Room', async reason => {
  const { turn } = await privateAssignment();
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'failed',
    reason: `unreported_order: ${reason}; requested work is unconfirmed`, toolCalls: 6 }, WORKER);
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(1);
  expect(reports[0]!.source.body).toContain(ROOM);
  expect(reports[0]!.source.body).toContain('Target Room');
  await claim(reports[0]!);
  await daemon.execute('report', { ...authority(reports[0]!), status: 'failed', text: reports[0]!.source.body }, RUBY);
  expect((await phone.readRoom(DM, HUMAN))?.messages.filter(m => m.text.startsWith('failed:'))).toHaveLength(1);
});
it.each(['explicit', 'implicit'])('failure visibility: %s delivered report suppresses missing-outcome fallback', async kind => {
  const { turn } = await privateAssignment();
  if (kind === 'explicit') {
    await daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'blocked: need a login decision' }, WORKER);
    await daemon.execute('postRoomMessage', { ...authority(turn), text: 'A decision is still needed.' }, WORKER);
  }
  else await daemon.execute('postRoomMessage', { ...authority(turn), text: 'The saved login needs a decision.' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1', [turn.turnRequestId])).rows[0]?.status).toBe('complete');
});
it.each(['complete', 'failed'] as const)('failure visibility: a recorded child order permits quiet waiting after %s stop', async status => {
  const { turn } = await privateAssignment();
  await daemon.execute('order', { ...authority(turn), address: ROOM, agent: RUBY, text: 'Check the saved login prerequisites' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status,
    ...(status === 'failed' ? { reason: 'unreported_order: repeated-tool-call; requested work is unconfirmed' } : {}) }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});
it('failure visibility: a recorded pending grant permits quiet waiting', async () => {
  const { turn } = await privateAssignment();
  const grant = randomUUID();
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,command_id)
    VALUES($1,$2,$3,'host','example.com','Needed for assigned work',$2,$4,'pending',$5)`, [grant, WORKER, WS, ROOM, turn.id]);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});
it('failure visibility: stale and cancelled generations cannot create failure reports', async () => {
  const { turn } = await privateAssignment();
  await expect(daemon.execute('postAgentTurnReceipt', { ...authority(turn), generationId: 'stale', agentId: WORKER, status: 'complete' }, WORKER)).rejects.toThrow();
  await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [turn.id]);
  await expect(daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER)).rejects.toThrow();
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});
it('closed-corner reports do not fall back through a recorded opening ancestor', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text)) WHERE id=$1`, [turn.id, opened.cornerId]);
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [opened.cornerId]);
  // Exercise routing itself: archived execution has no permission to write tools.
  const { reportToCommander } = await import('./commander.js');
  const command = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [turn.id])).rows[0]!;
  await reportToCommander(db, opened.cornerId, WORKER, 'failed: saved login is unconfirmed', command, 'archived-report');
  expect((await commands(ROOM, RUBY)).find(c => c.id === 'archived-report')).toBeUndefined();
  expect((await commands(opened.cornerId, RUBY)).some(c => c.id === 'archived-report')).toBe(false);
});
it('failure visibility: unavailable commander membership refuses automatic publication without committing success', async () => {
  const { turn } = await privateAssignment();
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  await expect(daemon.execute('postRoomMessage', { ...authority(turn), text: 'The login needs attention' }, WORKER)).rejects.toThrow('not delivered');
  expect((await db.query('SELECT state,private_payload FROM agent_commands WHERE id=$1', [turn.id])).rows[0])
    .toMatchObject({ state: 'claimed', private_payload: expect.not.objectContaining({ reportedGenerationId: expect.anything() }) });
});
it('failure visibility: dispatch receipt confirms only private queue acceptance', async () => {
  const { receipt } = await privateAssignment();
  expect(receipt).toMatchObject({ accepted: true, executionConfirmed: false, receipt: expect.stringContaining('queued privately') });
});
it('failure visibility: terminal completion read distinguishes failed work from successful execution', async () => {
  const { turn } = await privateAssignment();
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'failed',
    reason: 'unreported_order: repeated-tool-call; requested work is unconfirmed' }, WORKER);
  expect(await daemon.execute('getRequestCompletion', { roomId: ROOM, requestId: turn.turnRequestId }, WORKER))
    .toMatchObject({ completed: true, outcome: 'failed', failureReason: expect.stringContaining('unconfirmed') });
});
it('failure visibility: restored commander membership permits one automatic report after a refused publication', async () => {
  const { turn } = await privateAssignment();
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  await expect(daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: login needs attention' }, WORKER)).rejects.toThrow('not delivered');
  await db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: login needs attention' }, WORKER);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: login needs attention' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);
});
it('failure visibility: an old report marker or approval cannot discharge a new generation', async () => {
  const { turn } = await privateAssignment();
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{reportedGenerationId}','"old-generation"'::jsonb) WHERE id=$1`, [turn.id]);
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,command_id,created_at)
    VALUES($1,$2,$3,'host','example.com','Old approval',$2,$4,'pending',$5,now()-interval '1 hour')`, [randomUUID(), WORKER, WS, ROOM, turn.id]);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'failed',
    reason: 'unreported_order: repeated-tool-call; requested work is unconfirmed' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.source.body.startsWith('failed:'))).toHaveLength(1);
});
it('an expired order execution lease is reclaimed without an unreported-order report', async () => {
  const { turn } = await privateAssignment();
  await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '10 minutes' WHERE id=$1`, [turn.id]);
  const { reclaimExpiredCommandLeases } = await import('./turn-silence-notice.js');
  expect(await reclaimExpiredCommandLeases(db, new LiveHub())).toBe(1);
  await reclaimExpiredCommandLeases(db, new LiveHub());
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [turn.id])).rows[0]?.state).toBe('complete');
});
it('closed-corner reports do not wake even the nearest live opening ancestor', async () => {
  const opened = await open(), turn = await worker(opened.cornerId), ancestor = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Live parent corner',$4)`, [ancestor, WS, ROOM, RUBY]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle) VALUES($1,$2,'{"lifecycle":"implement"}')`, [ancestor, RUBY]);
  await db.query(`UPDATE corner_facts SET opened_from_corner_id=$2 WHERE corner_id=$1`, [opened.cornerId, ancestor]);
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text)) WHERE id=$1`, [turn.id, opened.cornerId]);
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [opened.cornerId]);
  const { reportToCommander } = await import('./commander.js');
  const command = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [turn.id])).rows[0]!;
  await reportToCommander(db, opened.cornerId, WORKER, 'failed: login is unconfirmed', command, 'nearest-live-report');
  expect((await commands(ancestor, RUBY)).find(c => c.id === 'nearest-live-report')).toBeUndefined();
  expect((await commands(ROOM, RUBY)).find(c => c.id === 'nearest-live-report')).toBeUndefined();
});
it('failure visibility: Squire approval proves a current durable wait, not a completed outcome', async () => {
  const { turn } = await privateAssignment();
  await daemon.execute('postSquireApproval', { ...authority(turn), tool: 'operate_login', title: 'Saved login approval',
    detail: 'Approve the saved login', approvalUrl: 'https://example.com/approval', approvalId: 'login-approval', linkKind: 'approval' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});
it('failure visibility: post acknowledges stored visible text and cannot discharge an order', async () => {
  const opened = await open();
  const result = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: opened.cornerId, text: 'Work remains to be done' }, RUBY);
  expect(result).toMatchObject({ stored: true, visible: true, receipt: 'Message stored and visible.' });
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});
it('failure visibility: public corner prose cannot consume private assignment authority before its report', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'I checked the login page.' }, WORKER);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [turn.id])).rows[0]?.state).toBe('claimed');
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
});

it('failure visibility: lease expiry does not report a failure after a delivered outcome', async () => {
  const { turn } = await privateAssignment();
  await daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'blocked: need a login decision' }, WORKER);
  await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '10 minutes' WHERE id=$1`, [turn.id]);
  const { reclaimExpiredCommandLeases } = await import('./turn-silence-notice.js');
  await reclaimExpiredCommandLeases(db, new LiveHub());
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);

});

// These drive the public daemon receipt and report operations with durable provenance.
it.each([true, false])('Reproduction R1/R2: lifecycle receipt preserves delivered outcome=%s', async delivered => {
  const opened = await open();
  const initial = await worker(opened.cornerId);
  const parent = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [initial.id])).rows[0]!;
  await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'watched_corner', parent,
    privatePayload: { kind: 'lifecycle', text: 'Watched corner merged',
      authorId: RUBY, fromRoomId: opened.cornerId } });
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'watched_corner')!;
  await claim(wake);
  await daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: WORKER, status: 'working' }, WORKER);
  if (delivered) {
    const receipt = await daemon.execute('report', { ...authority(wake), status: 'needs_decision',
      text: 'needs-decision: choose the next step' }, WORKER);
    expect(receipt).toMatchObject({ delivered: true });
  }
  await daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: WORKER,
    status: 'failed', reason: 'unreported_order: requested work is unconfirmed' }, WORKER);
  const reports = (await commands(DM, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(delivered ? 1 : 0);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1', [wake.turnRequestId])).rows[0]?.status).toBe('complete');
});

it.each(['no-reply', 'legacy-failure'])('Reproduction R2: real merge watch completes quietly (%s)', async mode => {
  const opened = await open();
  await systemLine(db, { roomId: opened.cornerId, authorId: HUMAN,
    subject: { kind: 'system', name: 'GitHub' }, verb: 'merged', kind: 'merged' });
  const wake = (await commands(DM, RUBY)).find(c => c.reason === 'watched_corner')!;
  expect(wake).toBeDefined();
  await claim(wake);
  await daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: RUBY, status: 'working' }, RUBY);
  await daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: RUBY,
    ...(mode === 'no-reply' ? { status: 'complete' as const, completionKind: 'no-reply' as const }
      : { status: 'failed' as const, reason: 'unreported_order: requested work is unconfirmed' }) }, RUBY);
  expect((await phone.readRoom(DM, HUMAN))?.messages.filter(m => m.text.startsWith('failed:'))).toHaveLength(0);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1', [wake.turnRequestId])).rows[0]?.status).toBe('complete');
});

it.each(['complete', 'failed'] as const)('Reproduction R1: delivered needs-decision on an order survives %s receipt', async status => {
  const { turn } = await privateAssignment();
  expect(await daemon.execute('report', { ...authority(turn), status: 'needs_decision',
    text: 'needs-decision: choose the next step' }, WORKER)).toMatchObject({ delivered: true });
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status,
    ...(status === 'failed' ? { reason: 'unreported_order: requested work is unconfirmed' } : {}) }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1', [turn.turnRequestId])).rows[0]?.status).toBe('complete');
});

// Orders stay open until the worker reports; the server checks corner state, not every turn.
async function cornerTurnWithPendingChecks() {
  const opened = await open();
  const lifecycle = { lifecycle: 'in-review', checks: 'pending', pr: { number: 2545, headSha: 'd'.repeat(40) } };
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId, JSON.stringify(lifecycle)]);
  const turn = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'working' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  return { opened, turn, lifecycle };
}
it('Reproduction unreported-order-false: an unreported corner turn with pending checks sends nothing', async () => {
  const { opened, turn, lifecycle } = await cornerTurnWithPendingChecks();
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [turn.turnRequestId, WORKER])).rows[0]?.status).toBe('complete');
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='turn-failed'`, [opened.cornerId])).rowCount).toBe(0);
  expect((await db.query('SELECT private_payload FROM agent_commands WHERE id=$1', [turn.id])).rows[0]?.private_payload)
    .not.toHaveProperty('reportedGenerationId');
  expect((await db.query('SELECT lifecycle FROM corner_facts WHERE corner_id=$1', [opened.cornerId])).rows[0]?.lifecycle)
    .toMatchObject(lifecycle);
  console.info('Demonstrated Reproduction unreported-order-false: pending-checks corner turn ended unreported; commander reports=0; order open; corner in-review');
});
it('Reproduction unreported-order-false: a later report(done) closes the open order as before', async () => {
  const { opened } = await cornerTurnWithPendingChecks();
  await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null, reason: 'corner_check' });
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'corner_check')!;
  await claim(wake);
  await expect(daemon.execute('report', { ...authority(wake), status: 'done', text: 'done: checks passed' }, WORKER))
    .resolves.toMatchObject({ delivered: true });
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report').map(c => c.source.body)).toEqual(['done: checks passed']);
  console.info('Demonstrated Reproduction unreported-order-false: later report(done) delivered once to the commander');
});


it('R1: a member posts a public message to a top-level Room', async () => {
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: ROOM, text: 'Room posting proof' }, RUBY);
  expect(posted).toMatchObject({ address: ROOM, stored: true, visible: true, receipt: 'Message stored and visible.' });
  expect((await phone.readRoom(ROOM, HUMAN))?.messages.some(message => message.id === posted.id && message.text === 'Room posting proof')).toBe(true);
});

it('R1: post refuses removed membership, archived and unknown addresses clearly', async () => {
  const unknown = randomUUID();
  await expect(daemon.execute('postCornerMessage', { ...authority(order), cornerId: unknown, text: 'Refused' }, RUBY)).rejects.toThrow('unknown address');
  await expect(daemon.execute('postCornerMessage', { ...authority(order), cornerId: 'bad-address', text: 'Refused' }, RUBY)).rejects.toThrow('unknown address');
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [ROOM]);
  await expect(daemon.execute('postCornerMessage', { ...authority(order), cornerId: ROOM, text: 'Refused' }, RUBY)).rejects.toThrow('address is archived');
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [ROOM]);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, RUBY]);
  await expect(daemon.execute('postCornerMessage', { ...authority(order), cornerId: ROOM, text: 'Refused' }, RUBY)).rejects.toThrow('not a current member');
  expect((await db.query(`SELECT id FROM messages WHERE text='Refused'`)).rowCount).toBe(0);
});


it('Reproduction R1: each post receipt lists only that post tags', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const post = (text: string) => daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text }, WORKER);
  const first = await post('@ruby discuss this');
  expect(first.woken).toEqual(['ruby']);
  const other = '7'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other') ON CONFLICT DO NOTHING`, [other]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [other,HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WS,other,ROOM]);
  expect((await post('@other this post is for you')).woken).toEqual(['other']);
  const second = await post('No tag in this next post.');
  expect(second.woken).toEqual([]);
  await expect(post('@captain see this')).rejects.toThrow('Your commander is @ruby in Captain and Ruby');
  const quoted = await post('"@ruby, or any squire agent except Speedy."');
  expect(quoted.woken).toEqual([]);
  expect((await post('Correction: my quote of "@ruby" in that reply woke Ruby. That was my error. Ruby has no task here.')).woken).toEqual([]);
  expect((await post('The next post has no tag.')).woken).toEqual([]);
  expect((await post('@ruby fresh tag')).woken).toEqual(['ruby']);
  expect((await post('"start ```\ncode\n``` @ruby"')).woken).toEqual(['ruby']);
});


it('Reproduction R1: exact original posts do not wake the quoted member', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await db.query(`UPDATE identities SET handle='nerd' WHERE id=$1`, [RUBY]);
  try {
    const receipts = [];
    for (const text of quotedTagPosts) {
      const receipt = await daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text }, WORKER);
      receipts.push(receipt);
      expect((await db.query('SELECT text FROM messages WHERE id=$1', [receipt.id])).rows[0]?.text).toBe(text);
    }
    console.info('Reproduction R1 post receipts:', JSON.stringify(receipts.map(receipt => receipt.woken)));
    for (const receipt of receipts) {
      expect(receipt.woken).toEqual([]);
      expect((await db.query(`SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [receipt.id, RUBY])).rowCount).toBe(0);
    }
  } finally { await db.query(`UPDATE identities SET handle='ruby' WHERE id=$1`, [RUBY]); }
});

// Reproduction OPEN-1: use the same public daemon operation as open_corner.
it.each([undefined, 'agent-context'])('OPEN-1: opens without human approval (%s)', async (sourceMessageId) => {
  if (sourceMessageId) await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Investigate the widget')`,
    [sourceMessageId, ROOM, WORKER]);
  const opened = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    name: 'Agent-widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false,
      ...(sourceMessageId ? { approval: { sourceMessageId } } : {}) },
  }, RUBY);
  expect((await db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`,
    [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: {
      kind: 'agent-initiated', approvedBy: RUBY, snapshot: 'Agent-initiated corner',
  } });
  expect((await commands(opened.cornerId, WORKER))[0]).toBeDefined();
});
it('OPEN-1: preserves human approval text and attribution', async () => {
  const opened = await open();
  expect((await db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`,
    [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: {
      approvedBy: HUMAN, snapshot: 'Build the widget in the target Room',
  } });
});
it('OPEN-1: refuses a non-member opening without approval', async () => {
  await db.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`, [ROOM, RUBY]);
  await expect(daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    name: 'Agent-widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false },
  }, RUBY)).rejects.toThrow('daemon room access denied');
});

it('OPEN-1: an agent-initiated opening does not authorize a worker revision', async () => {
  const opened = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    name: 'Agent-widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false },
  }, RUBY);
  const turn = await worker(opened.cornerId);
  await expect(daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Change the widget', change: 'Adjust scope' },
  }, WORKER)).rejects.toThrow('corner brief approval must name a human message or commander order');
});

const duplicateReproduction = '572a0de1c06be02cb120b38294e3d9b80b9bdfa8cdf6e53dcb708819b41393c3';
it.each([false, true])('Reproduction 572a0de1: same-address post then matching final is visible once (tagged=%s)', async tagged => {
  const text = `${tagged ? '@captain ' : ''}Google sign-in (#2676) is merged. The checks passed.`;
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text }, RUBY);
  await daemon.execute('postRoomMessage', { ...authority(order), text }, RUBY);
  const messages = (await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message');
  expect(messages.map(m => m.id)).toEqual([posted.id]);
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [order.id])).rows[0]?.state).toBe('complete');
  console.info(`Demonstrated Reproduction ${duplicateReproduction}: post + final -> one visible message`);
});

it('Reproduction R1: a same-place closing summary stays in activity even with an additional sentence', async () => {
  const text = 'Google sign-in (#2676) is merged. The checks passed.';
  await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text }, RUBY);
  const final = `${text} You still need to approve the release.`;
  await daemon.execute('postRoomMessage', { ...authority(order), text: final }, RUBY);
  expect((await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.text))
    .toEqual([text]);
});

it('R-onb-15: a free agent post stays visible and the paraphrased final becomes activity', async () => {
  await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'fixture')`,
    [RUBY,WS,HUMAN]);
  const earlier = 'The card is up. Sign in to Link, then name the repository and I will start.';
  const final = 'The Link sign-in card is in the Room now. Sign in, then name the repo and I start.';
  await daemon.execute('postCornerMessage', {...authority(order),cornerId:DM,text:earlier}, RUBY);
  await daemon.execute('postRoomMessage', {...authority(order),text:final}, RUBY);
  const messages = (await phone.readRoom(DM,HUMAN))!.messages.filter(message=>message.author.pubkey===RUBY);
  expect(messages.filter(message=>message.presentation==='message').map(message=>message.text)).toEqual([earlier]);
  expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='activity'`,[DM,RUBY])).rows)
    .toContainEqual({text:final});
});

it('Reproduction ff0ec4df: a mid-turn post keeps its row while the closing narration folds', async () => {
  const list = 'Groceries: rice, lentils, cardamom. Deliver to Mohammed before six.';
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text: list }, RUBY);
  const narration = 'Posted the list above and told Mohammed it is coming before six.';
  const reply = await daemon.execute('postRoomMessage', { ...authority(order), text: narration }, RUBY);
  const rows = (await db.query<{ id: string; text: string; presentation: string; version: number }>(
    `SELECT id,text,presentation,version FROM messages WHERE id IN ($1,$2)`, [posted.id, reply.id])).rows;
  expect(rows.find(row => row.id === posted.id)).toMatchObject({ text: list, presentation: 'message', version: 0 });
  expect(rows.find(row => row.id === reply.id)).toMatchObject({ text: narration, presentation: 'activity', version: 1 });
  expect((await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.text))
    .toEqual([list]);
  console.info('Demonstrated Reproduction ff0ec4df: the demoted row is the closing reply (version 1); the posted list is untouched (version 0)');
});

it.each(['other-address', 'other-generation', 'other-request', 'deleted'] as const)('dedupe does not suppress a final after a post in %s', async scope => {
  const text = 'Google sign-in is merged.';
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: scope === 'other-address' ? ROOM : DM, text }, RUBY);
  if (scope === 'other-generation') await db.query(`UPDATE messages SET legacy_event='{"turnGenerationId":"old"}' WHERE id=$1`, [posted.id]);
  if (scope === 'other-request') await db.query(`UPDATE messages SET request_id='old' WHERE id=$1`, [posted.id]);
  if (scope === 'deleted') await db.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [posted.id]);
  const final = await daemon.execute('postRoomMessage', { ...authority(order), text }, RUBY);
  expect((await phone.readRoom(DM, HUMAN))!.messages.find(m => m.id === final.id)?.presentation).toBe('message');
});

it('dedupe retains activity and accepts an identical final retry', async () => {
  const text = 'Google sign-in is merged.';
  await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text }, RUBY);
  const steps = [{ kind: 'tool' as const, title: 'post', status: 'completed' as const }];
  const final = await daemon.execute('postRoomMessage', { ...authority(order), text, steps }, RUBY);
  const replay = await daemon.execute('postRoomMessage', { ...authority(order), text, steps }, RUBY);
  expect(replay.id).toBe(final.id);
  expect((await db.query(`SELECT presentation,activity FROM messages WHERE id=$1`, [final.id])).rows[0])
    .toMatchObject({ presentation: 'activity', activity: [...steps, { kind: 'note', title: 'Turn summary', text }] });
});

it('dedupe does not wake a tagged agent again for the collapsed final', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, DM, WORKER]);
  const text = '@worker Google sign-in is merged.';
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text }, RUBY);
  await daemon.execute('postRoomMessage', { ...authority(order), text }, RUBY);
  expect((await db.query(`SELECT source_message_id FROM agent_commands WHERE agent_id=$1 AND reason='agent_tag'`, [WORKER])).rows)
    .toEqual([{ source_message_id: posted.id }]);
});

it('dedupe keeps a lightly reworded summary in collapsed activity', async () => {
  const text = 'Google sign-in (#2676) is merged. The checks passed and the account linking flow is ready for review.';
  await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text }, RUBY);
  const final = text.replace('and the account', 'and account');
  const result = await daemon.execute('postRoomMessage', { ...authority(order), text: final }, RUBY);
  expect((await db.query(`SELECT presentation,activity FROM messages WHERE id=$1`, [result.id])).rows[0])
    .toMatchObject({ presentation: 'activity', activity: [{ kind: 'note', title: 'Turn summary', text: final }] });
});

it.each(['final', 'post-final', 'silent', 'post-silent'] as const)('Reproduction R1 missing attachments: report wake delivers files once (%s)', async mode => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('postRoomMessage', { ...authority(order), text: 'Work started.' }, RUBY);
  await daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: files ready' }, WORKER);
  const wake = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(wake);
  const objectId = randomUUID();
  await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'image/png','proof.png',10,$4,'ready',now()+interval '24 hours')`,
    [objectId, RUBY, `artifact/${objectId}`, randomBytes(32).toString('hex')]);
  await daemon.execute('postAgentAttachment', { ...authority(wake), attachment: {
    url: `http://test/v1/media/${objectId}`, name: 'proof.png', mimeType: 'image/png', size: 10,
  } }, RUBY);
  if (mode.startsWith('post-')) {
    const receipt = await daemon.execute('postCornerMessage', { ...authority(wake), cornerId: DM, text: 'Here is the image.' }, RUBY);
    expect(receipt.receipt).not.toContain('closing text here also publishes');
  }
  if (mode.endsWith('silent')) {
    await daemon.execute('markAgentTurnSilent', authority(wake), RUBY);
    await daemon.execute('postRoomMessage', { ...authority(wake), text: 'This must remain silent.' }, RUBY);
  } else {
    await daemon.execute('postRoomMessage', { ...authority(wake), text: 'Here is the image.' }, RUBY);
  }
  const visible = (await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message' && m.text !== 'Work started.');
  expect(visible).toHaveLength(1);
  expect(visible[0]!.attachments.map(a => a.name)).toEqual(['proof.png']);
  expect(visible[0]!.text).not.toContain('must remain silent');
  expect((await db.query('SELECT 1 FROM agent_pending_attachments WHERE request_id=$1', [wake.turnRequestId])).rowCount).toBe(0);
});

it.each([false, true])('same-place closing keeps a new attachment on the visible post (tagged=%s)', async tagged => {
  const text = `${tagged ? '@captain ' : ''}Google sign-in is merged.`;
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text }, RUBY);
  const objectId = randomUUID();
  await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','proof',10,$4,'ready',now()+interval '24 hours')`,
    [objectId, RUBY, `artifact/${objectId}`, randomBytes(32).toString('hex')]);
  await daemon.execute('postAgentAttachment', { ...authority(order), attachment: {
    url: `http://test/v1/media/${objectId}`, name: 'proof.txt', mimeType: 'text/plain', size: 10,
  } }, RUBY);
  const final = await daemon.execute('postRoomMessage', { ...authority(order), text }, RUBY);
  const messages = (await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message');
  expect(messages.map(m => m.id)).toEqual([posted.id]);
  const message = messages[0]!;
  expect((await db.query(`SELECT presentation FROM messages WHERE id=$1`, [final.id])).rows[0]?.presentation).toBe('activity');
  expect(message.presentation).toBe('message');
  expect(message.attachments).toHaveLength(1);
});

it.each([
  ['The balance is -5. The checks passed.', 'The balance is 5.', true],
  ['Open https://example.com/a-b. The checks passed.', 'Open https://example.com/a/b.', true],
  ['The balance is -5. The checks passed.', 'The balance is -5.', false],
  ['Open https://example.com/a-b. The checks passed.', 'Open https://example.com/a-b.', false],
])('same-place summaries retain literal corrections in activity: %s -> %s', async (post, final) => {
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text: post }, RUBY);
  const result = await daemon.execute('postRoomMessage', { ...authority(order), text: final }, RUBY);
  const messages = (await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message');
  expect(messages.map(m => m.id)).toEqual([posted.id]);
  expect((await db.query(`SELECT activity FROM messages WHERE id=$1`, [result.id])).rows[0]?.activity).toContainEqual({ kind: 'note', title: 'Turn summary', text: final });
});

it.each([
  ['Read /tmp/a-b. The checks passed.', 'Read /tmp/a/b.'],
  ['The identifier is account_ready. The checks passed.', 'The identifier is account-ready.'],
  ['Run `send(a-b)`. The checks passed.', 'Run `send(a/b)`.'],
  ['Run `send(a-b)`.', 'Run `send(a/b)`.'],
  ['Run `READY`.', 'Run `ready`.'],
  ['Run `a  b`.', 'Run `a b`.'],
])('same-place summaries retain corrected paths, identifiers and code in activity: %s -> %s', async (post, final) => {
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text: post }, RUBY);
  const result = await daemon.execute('postRoomMessage', { ...authority(order), text: final }, RUBY);
  expect((await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.id))
    .toEqual([posted.id]);
});

it.each([
  ['Do not deploy the release.', 'deploy the release.', true],
  ['If checks pass, deploy the release.', 'deploy the release.', true],
  ['Deploy the release only after checks pass.', 'Deploy the release', true],
  ['Deploy the release. Only after checks pass.', 'Deploy the release.', true],
  ['Do not deploy the release. The checks passed.', 'Do not deploy the release.', false],
])('same-place summaries retain polarity and qualifying context in activity: %s -> %s', async (post, final) => {
  const posted = await daemon.execute('postCornerMessage', { ...authority(order), cornerId: DM, text: post }, RUBY);
  const result = await daemon.execute('postRoomMessage', { ...authority(order), text: final }, RUBY);
  expect((await phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.id))
    .toEqual([posted.id]);
});


it.each(['human', 'order'])('Reproduction R1: silent completion preserves fresh %s input without a pause', async input => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  // The old tool completed the command while the helper still had draft writes.
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), status: 'complete', completionKind: 'no-reply' }, WORKER);
  await expect(daemon.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'late' }, WORKER))
    .rejects.toThrow('command output authority rejected');
  if (input === 'human') {
    await phone.execute('sendRoomMessage', { roomId: opened.cornerId, text: '@worker Continue the widget' }, HUMAN);
  } else {
    await daemon.execute('order', { ...authority(order), address: opened.cornerId, agent: 'worker', text: 'Continue the widget' }, RUBY);
  }
  const next = await worker(opened.cornerId);
  // The helper now owns completion: queued presentation writes finish first.
  await daemon.execute('postAgentDraft', { ...authority(next), agentId: WORKER, turnId: next.turnRequestId, text: 'Checking the widget' }, WORKER);
  await daemon.execute('retractAgentLiveOutput', { ...authority(next), agentId: WORKER, turnId: next.turnRequestId, kind: 'draft' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(next), status: 'complete', completionKind: 'no-reply' }, WORKER);
  expect((await db.query(`SELECT state,generation_id FROM agent_commands WHERE id=$1`, [next.id])).rows[0])
    .toMatchObject({ state: 'complete', generation_id: authority(next).generationId });
  expect(await commands(opened.cornerId, WORKER)).toEqual([]);
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
});

const currentPlaceReminder = 'Posted to your current place. Queued files are attached to this post. Closing text is kept in turn activity.';
it.each(['dm', 'room', 'corner', 'parent-room'] as const)('post receipt identifies the actual current place: %s', async (place) => {
  let command = order;
  let agent = RUBY;
  let target = DM;
  if (place === 'room') {
    await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@ruby Post here' }, HUMAN);
    command = (await commands(ROOM, RUBY))[0]!;
    await claim(command);
    target = ROOM;
  } else if (place === 'corner' || place === 'parent-room') {
    const opened = await open();
    command = await worker(opened.cornerId);
    agent = WORKER;
    target = place === 'corner' ? opened.cornerId : ROOM;
  }
  const posted = await daemon.execute('postCornerMessage', { ...authority(command), cornerId: target, text: 'Receipt path proof' }, agent);
  expect(posted.receipt).toBe('Message stored and visible.' + (place === 'parent-room' ? '' : '\n' + currentPlaceReminder));
  expect((await phone.readRoom(target, HUMAN))?.messages.some(message => message.id === posted.id && message.text === 'Receipt path proof')).toBe(true);
});


it('opens with an independent reviewer and lets another member change it through metadata', async () => {
  const input = { ...authority(order), requestId: order.turnRequestId, targetRoomId: ROOM,
    name: 'Reviewer', objective: 'Prove corner reviewer assignment', implementer: 'worker', reviewer: 'ruby',
    brief: { spec: 'Prove reviewer assignment', repositoryWork: false } };
  const opened = await daemon.execute('createCorner', input, RUBY);
  expect((await db.query(`SELECT reviewer_agent_id FROM corner_facts WHERE corner_id=$1`, [opened.cornerId])).rows[0])
    .toEqual({ reviewer_agent_id: RUBY });
  // Tool retries retain the original corner rather than opening duplicate work.
  expect((await daemon.execute('createCorner', input, RUBY)).cornerId).toBe(opened.cornerId);
  const turn = await worker(opened.cornerId);
  await expect(daemon.execute('renameCorner', { ...authority(turn), cornerId: opened.cornerId, reviewer: 'worker' }, WORKER))
    .rejects.toThrow('implementer cannot review');
  await daemon.execute('renameCorner', { ...authority(turn), cornerId: opened.cornerId, reviewer: 'ruby' }, WORKER);
  const lines = await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%set the corner reviewer%'`, [opened.cornerId]);
  expect(lines.rowCount).toBe(1);
  console.info('Demonstrated corner-reviewer: open assigns an independent reviewer; another member can set it without editing the brief; self review is refused.');
});

it('refuses opening with the implementer as reviewer atomically', async () => {
  await expect(daemon.execute('createCorner', { ...authority(order), requestId: order.turnRequestId,
    targetRoomId: ROOM, name: 'Reviewer', objective: 'Prove reviewer independence',
    implementer: 'worker', reviewer: 'worker', brief: { spec: 'Prove reviewer independence', repositoryWork: false } }, RUBY))
    .rejects.toThrow('implementer cannot review');
  expect((await db.query(`SELECT 1 FROM rooms WHERE parent_id=$1`, [ROOM])).rowCount).toBe(0);
});

it.each(['room', 'corner'] as const)('Reproduction R1: silent %s rejects late final text before the terminal receipt', async scope => {
  const turn = scope === 'corner' ? await worker((await open()).cornerId) : order;
  if (scope === 'room') await db.query(`UPDATE agent_commands SET reason='report' WHERE id=$1`, [turn.id]);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), status: 'working' }, turn.agentId);
  await daemon.execute('markAgentTurnSilent', authority(turn), turn.agentId);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'This must never be a message.' }, turn.agentId);
  expect((await db.query(`SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 AND request_id=$3`,
    [turn.roomId, turn.agentId, turn.turnRequestId])).rows).toEqual([]);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), status: 'complete' }, turn.agentId);
  expect((await db.query(`SELECT completion_kind FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
    [turn.roomId, turn.agentId, turn.turnRequestId])).rows[0]?.completion_kind).toBe('no-reply');
});

it('Reproduction R1: the server refuses silence on human input', async () => {
  await expect(daemon.execute('markAgentTurnSilent', authority(order), RUBY)).rejects.toThrow('requires a nonhuman wake');
});


it.each(['room', 'corner'] as const)('Reproduction R1: post then a differently worded summary leaves one visible %s message', async scope => {
  let turn: AgentCommand;
  if (scope === 'corner') turn = await worker((await open()).cornerId);
  else {
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@ruby Check the widget' }, HUMAN);
    turn = (await daemon.execute('getAgentCommands', { roomId: ROOM }, RUBY)).commands[0]!;
    await claim(turn);
  }
  const posted = await daemon.execute('postCornerMessage', { ...authority(turn), cornerId: turn.roomId, text: 'The widget is ready.' }, turn.agentId);
  const summary = 'Finished checking it; the widget can be used now.';
  const final = await daemon.execute('postRoomMessage', { ...authority(turn), text: summary }, turn.agentId);
  const messages = (await phone.readRoom(turn.roomId, HUMAN))!.messages.filter(message => message.author.pubkey === turn.agentId && message.presentation === 'message');
  expect(messages.map(message => message.id)).toEqual([posted.id]);
  expect((await db.query(`SELECT presentation,activity FROM messages WHERE id=$1`, [final.id])).rows[0])
    .toMatchObject({ presentation: 'activity', activity: [{ kind: 'note', title: 'Turn summary', text: summary }] });
});

it.each(['done','no-reply'])('WAKE-STORM: auth-failed reviewer reports once and never echoes up a discharged order (%s)', async outcome => {
  const NIGLET = '6'.repeat(64), SOL = '7'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Niglet','niglet'),($2,'agent','Sol','sol') ON CONFLICT DO NOTHING`, [NIGLET,SOL]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3) ON CONFLICT DO NOTHING', [NIGLET,SOL,HUMAN]);
  for (const agent of [NIGLET,SOL]) for (const address of [null,ROOM,DM])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS,address,agent]);
  await daemon.execute('postAgentTurnReceipt', {...authority(order),status:'complete'}, RUBY);
  const queuedRoot = await createAgentCommand(db, {roomId:DM,agentId:NIGLET,
    sourceMessageId:order.sourceMessageId,reason:'human_tag'});
  const root = (await commands(DM,NIGLET)).find(c=>c.id===queuedRoot!.id)!;
  await claim(root);
  await daemon.execute('order', {...authority(root),address:DM,agent:'ruby',text:'Build the widget'}, NIGLET);
  order = (await commands(DM,RUBY)).find(c=>c.reason==='order')!;
  await claim(order);
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', {...authority(turn),status:'complete'}, WORKER);
  await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [ROOM,SOL]);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId,
    JSON.stringify({checks:'passing',pr:{number:42,headSha:'a'.repeat(40)}})]);
  await systemLine(db, {roomId:opened.cornerId,authorId:HUMAN,subject:{kind:'github',name:'GitHub'},
    verb:'passed checks',kind:'check-passed',object:{text:'checks',headSha:'a'.repeat(40)}});
  const review = (await commands(opened.cornerId,SOL))[0]!;
  await claim(review);
  await daemon.execute('postAgentTurnReceipt', {...authority(review),status:'failed',reason:'ACP error -32000: Authentication required'}, SOL);
  const {reconcileConfiguredCornerReviewers} = await import('./agent-command.js');
  for (let cycle=0;cycle<5;cycle++) await reconcileConfiguredCornerReviewers(db,ROOM);
  expect(await commands(opened.cornerId,SOL)).toHaveLength(0);
  const failures = (await commands(DM,RUBY)).filter(c=>c.reason==='report');
  expect(failures).toHaveLength(1);
  if (outcome === 'done') await daemon.execute('report', {...authority(order),status:'done',text:'done: the assigned coordination is complete'}, RUBY);
  else await daemon.execute('postAgentTurnReceipt', {...authority(order),status:'complete',completionKind:'no-reply'}, RUBY);
  const upstreamResults = outcome === 'done' ? 1 : 0;
  expect((await commands(DM,NIGLET)).filter(c=>c.reason==='report')).toHaveLength(upstreamResults);
  await claim(failures[0]!);
  // A later turn retains provenance for explicit escalation, not an automatic
  // obligation to report each status update to the original upstream orderer.
  await daemon.execute('postRoomMessage', {...authority(failures[0]!),text:'The reviewer still requires authentication.'}, RUBY);
  expect((await commands(DM,NIGLET)).filter(c=>c.reason==='report')).toHaveLength(upstreamResults);
  const {reportToCommander} = await import('./commander.js');
  const row = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1',[review.id])).rows[0]!;
  for(let attempt=0;attempt<5;attempt++) await db.transaction(tx=>reportToCommander(tx,opened.cornerId,SOL,
    `failed: Widget (${opened.cornerId}): ACP error -32000: Authentication required`,row,`repeated-failure-${attempt}`,{automatic:true}));
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND reason='report' AND private_payload->>'authorId'=$2`,[RUBY,SOL])).rowCount).toBe(1);
  // Closing the source corner silences both old pending and fresh reports.
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[opened.cornerId]);
  expect(await db.transaction(tx=>reportToCommander(tx,opened.cornerId,SOL,'failed: another auth failure',row,'after-close',{automatic:true})))
    .toMatchObject({skipped:true});
  expect((await commands(DM,RUBY)).filter(c=>c.reason==='report')).toHaveLength(0);
});


it.each([0,1])('WAKE-STORM: legacy pending failures collapse and closed-corner reports vanish (batch=%s)', async minutes => {
  const opened = await open();
  await db.query('UPDATE agents SET wake_batch_minutes=$2 WHERE agent_id=$1',[RUBY,minutes]);
  try {
    const queued = [];
    for(let attempt=0;attempt<3;attempt++) queued.push(await createAgentCommand(db,{
      roomId:DM,agentId:RUBY,sourceMessageId:null,reason:'report',
      privatePayload:{kind:'report',authorId:WORKER,fromRoomId:opened.cornerId,originCornerId:opened.cornerId,
        text:'failed: Authentication required'},
    }));
    const pending = (await commands(DM,RUBY)).filter(c=>c.reason==='report');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(queued[0]!.id);
    await expect(claim({...pending[0]!,id:queued[1]!.id})).rejects.toThrow();
    // Exercise an already released digest, not just a newly queued report.
    await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[opened.cornerId]);
    expect((await commands(DM,RUBY)).filter(c=>c.reason==='report')).toHaveLength(0);
    await expect(claim(pending[0]!)).rejects.toThrow();
  } finally {
    await db.query('UPDATE agents SET wake_batch_minutes=0 WHERE agent_id=$1',[RUBY]);
  }
});


it('WAKE-STORM: identical failures of separate Room orders retain both results', async () => {
  for (let task=0;task<2;task++) await createAgentCommand(db, {
    roomId:DM,agentId:RUBY,sourceMessageId:null,reason:'report',
    privatePayload:{kind:'report',authorId:WORKER,fromRoomId:ROOM,text:'failed: provider unavailable'},
  });
  expect((await commands(DM,RUBY)).filter(c=>c.reason==='report')).toHaveLength(2);
});


it('WAKE-STORM: a later delegate report publishes its reply without re-answering the inherited order', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await daemon.execute('report', {...authority(order),status:'done',text:'done: coordination finished'}, RUBY);
  await daemon.execute('report', {...authority(turn),status:'blocked',text:'blocked: reviewer requires authentication'}, WORKER);
  const returned = (await commands(DM,RUBY)).find(c=>c.reason==='report')!;
  await claim(returned);
  await daemon.execute('postRoomMessage', {...authority(returned),text:'The reviewer still needs to sign in.'}, RUBY);
  expect((await phone.readRoom(DM,HUMAN))!.messages.filter(m=>m.author.pubkey===RUBY && m.presentation==='message').map(m=>m.text))
    .toEqual(['done: coordination finished', 'The reviewer still needs to sign in.']);
});

it('Reproduction SELF-1: orders itself in another Room and corner, refuses the current place', async () => {
  await daemon.execute('order', { ...authority(order), address: ROOM, agent: 'ruby', text: 'Continue in the Room' }, RUBY);
  const roomTurn = (await commands(ROOM, RUBY)).find(c => c.reason === 'order')!;
  expect(roomTurn.source.body).toBe('Continue in the Room');
  await claim(roomTurn);
  await expect(daemon.execute('order', { ...authority(roomTurn), address: ROOM, agent: 'ruby', text: 'Recurse' }, RUBY))
    .rejects.toThrow('current place');
  await expect(daemon.execute('order', { ...authority(roomTurn), address: ROOM.toUpperCase(), agent: 'ruby', text: 'Recurse uppercase' }, RUBY))
    .rejects.toThrow('current place');
  const opened = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    name: 'self-work', objective: 'Continue own work', implementer: 'ruby',
    brief: { spec: 'Continue own work', repositoryWork: false } }, RUBY);
  await daemon.execute('order', { ...authority(order), address: opened.cornerId, text: 'Resume own corner' }, RUBY);
  const ownCornerTurn = (await commands(opened.cornerId, RUBY)).find(c => c.reason === 'order')!;
  expect(ownCornerTurn.source.body).toBe('Resume own corner');
  await claim(ownCornerTurn);
  await expect(daemon.execute('order', { ...authority(ownCornerTurn), address: opened.cornerId, text: 'Recurse' }, RUBY))
    .rejects.toThrow('current place');
  console.info('Demonstrated SELF-1: own Room and corner receive private orders; same-place recursion refused');
});

it('Reproduction SELF-1: cross-place self-tags wake, same-place self-tags do not, and ping-pong ends', async () => {
  const opened = await open();
  const post = async (turn: AgentCommand, cornerId: string) => daemon.execute('postCornerMessage', {
    ...authority(turn), cornerId, text: '@ruby continue here',
  }, RUBY);
  expect((await post(order, ROOM)).woken).toEqual(['ruby']);
  let turn = (await commands(ROOM, RUBY)).find(c => c.reason === 'agent_tag')!;
  await claim(turn);
  expect((await post(turn, ROOM)).woken).toEqual([]);
  expect((await post(turn, ROOM.toUpperCase())).woken).toEqual([]);
  expect((await post(turn, opened.cornerId)).woken).toEqual(['ruby']);
  turn = (await commands(opened.cornerId, RUBY)).find(c => c.reason === 'agent_tag')!;
  await claim(turn);
  expect((await post(turn, ROOM)).woken).toEqual(['ruby']);
  turn = (await commands(ROOM, RUBY)).find(c => c.reason === 'agent_tag' && c.parentCommandId === turn.id)!;
  await claim(turn);
  expect((await post(turn, opened.cornerId)).notWoken).toContainEqual({ handle: 'ruby', reason: 'agent tag chain depth limit reached' });
  console.info('Demonstrated SELF-1: public cross-place self-tags wake; same-place and depth-bound tags wake nobody');
});

it('Reproduction SELF-1: self-order ping-pong consumes the existing depth budget', async () => {
  let turn = order;
  for (const address of [ROOM, DM, ROOM]) {
    await daemon.execute('order', { ...authority(turn), address, agent: 'ruby', text: 'Continue elsewhere' }, RUBY);
    turn = (await commands(address, RUBY)).find(c => c.reason === 'order' && c.parentCommandId === turn.id)!;
    await claim(turn);
  }
  await expect(daemon.execute('order', { ...authority(turn), address: DM, agent: 'ruby', text: 'Continue elsewhere' }, RUBY))
    .rejects.toThrow('depth limit');
});

it('Reproduction SELF-2: own brief revision and background shell completion can finish silently', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('postBackgroundToolCompletion', { ...authority(turn), toolCallId: 'shell', title: 'Run tests', status: 'completed' }, WORKER);
  const shell = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'corner_background_tool')!;
  await claim(shell);
  await daemon.execute('markAgentTurnSilent', authority(shell), WORKER);
  const own = await daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    idempotencyKey: 'own-revision', name: 'own-revision', objective: 'Continue own work', implementer: 'ruby',
    brief: { spec: 'Continue own work', repositoryWork: false } }, RUBY);
  await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}'::jsonb)`, [own.cornerId, RUBY]);
  await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: own.cornerId, expectedRevision: 1,
    brief: { spec: 'Build the clarified widget', change: 'Clarify work' } }, RUBY);
  const revision = (await commands(own.cornerId, RUBY)).find(c => c.reason === 'corner_brief_revision')!;
  await claim(revision);
  await daemon.execute('markAgentTurnSilent', authority(revision), RUBY);
  console.info('Demonstrated SELF-2: completion and revision continuations accept silence without filler');
});

it.each([
  ['recover', '40P01', 1, 2],
  ['exhaust', '40P01', 10, 3],
  ['other error', '23505', 1, 1],
  ['authority revoked', '40P01', 1, 1],
  ['revision changed', '40P01', 1, 2],
])('R-BRIEF-DEADLOCK: %s rolls back the revision and command delivery', async (scenario, code, failures, expectedAttempts) => {
  const opened = await open();
  const snapshot = async () => ({
    briefs: (await db.query(`SELECT * FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision`, [opened.cornerId])).rows,
    commands: (await db.query(`SELECT * FROM agent_commands ORDER BY id`)).rows,
    journal: (await db.query(`SELECT * FROM live_journal WHERE event->>'roomId'=$1 ORDER BY stream_id,sequence`, [opened.cornerId])).rows,
    notes: (await db.query(`SELECT * FROM messages WHERE room_id=$1 ORDER BY id`, [opened.cornerId])).rows,
  });
  const before = await snapshot();
  const events: unknown[] = [];
  const hub = new LiveHub();
  hub.publish = event => { events.push(event); };
  let attempts = 0;
  const failure = Object.assign(new Error('brief transaction failure'), { code });
  const wrapped: import('./database.js').SqlDatabase = {
    query: (sql, values) => db.query(sql, values),
    transaction: async work => {
      attempts++;
      try {
        return await db.transaction(async tx => {
          const result = await work(tx);
          if (attempts <= failures) throw failure;
          return result;
        });
      } catch (error) {
        if (error !== failure) throw error;
        expect(events).toHaveLength(0);
        expect(await snapshot()).toEqual(before);
        if (scenario === 'authority revoked')
          await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [RUBY]);
        if (scenario === 'revision changed')
          await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: opened.cornerId,
            expectedRevision: 1, brief: { spec: 'Concurrent authorized scope', change: 'Concurrent revision' } }, RUBY);
        throw error;
      }
    },
  };
  const watched = new DaemonService(wrapped, hub);
  const input = { ...authority(order), cornerId: opened.cornerId, expectedRevision: 1,
    brief: { spec: 'Build the clarified widget', change: 'Clarify scope' } };
  if (scenario === 'recover') {
    expect((await watched.execute('reviseCornerBrief', input, RUBY)).revision).toBe(2);
    const restored = await daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY);
    expect(restored.brief?.spec).toBe(input.brief.spec);
    const after = await snapshot();
    expect(after.briefs).toHaveLength(2);
    expect(after.journal.length).toBeGreaterThan(before.journal.length);
    expect(after.notes.length).toBe(before.notes.length + 1);
    const pending = after.commands.filter(row => row.state === 'pending' && row.room_id === opened.cornerId);
    expect(pending).toHaveLength(1);
  } else {
    await expect(watched.execute('reviseCornerBrief', input, RUBY)).rejects.toThrow(
      scenario === 'authority revoked' ? /access|member|authority/i :
      scenario === 'revision changed' ? /revision changed/ : failure.message);
    expect(events).toHaveLength(0);
    if (scenario !== 'revision changed') expect(await snapshot()).toEqual(before);
  }
  expect(attempts).toBe(expectedAttempts);
});

it.each([true, false])('records mock reply evidence through brief reads (reply=%s)', async (reply) => {
  const opened = await open();
  const mock = randomBytes(32).toString('hex'), approval = randomBytes(32).toString('hex');
  const objectId = randomUUID(), urlObjectId = randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments,created_at)
    VALUES($1,$2,$3,'Mock', $4::jsonb,'2026-01-01T00:00:00Z')`,
    [mock, DM, RUBY, JSON.stringify([{mediaId: objectId}, {url: 'https://test/v1/media/' + urlObjectId}])]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,created_at)
    VALUES($1,$2,$3,'Use this mock',$4,'2026-01-01T00:01:00Z')`, [approval, DM, HUMAN, reply ? mock : null]);
  const revised = await daemon.execute('reviseCornerBrief', { ...authority(order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Build the approved widget', change: 'Record mock approval', approval: {sourceMessageId: approval} } }, RUBY);
  const restored = await daemon.execute('getCornerRestoreState', {cornerId: opened.cornerId}, WORKER);
  const revisions = await daemon.execute('listCornerBriefRevisions', {cornerId: opened.cornerId}, WORKER);
  for (const brief of [revised, restored.brief, revisions.revisions[0]]) {
    expect(brief?.approval).toMatchObject({kind: 'explicit-human-answer', sourceMessageId: approval,
      text: 'Use this mock', approvedBy: HUMAN, replyToMessageId: reply ? mock : null,
      replyToAttachmentIds: reply ? expect.arrayContaining([objectId, urlObjectId]) : [],
      replyToCreatedAt: reply ? expect.any(String) : null, approvedAt: expect.any(String)});
    if (reply) expect(Date.parse(brief!.approval!.approvedAt!)).toBeGreaterThan(Date.parse(brief!.approval!.replyToCreatedAt!));
  }
  // The worker can verify stored evidence without gaining access to the private DM.
  await expect(daemon.execute('getRoomMessage', {roomId: DM, messageId: approval}, WORKER)).rejects.toThrow();
});

it('SUPERVISION-3: agents cannot set or open with holds; human hold still gates merge', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await expect(daemon.execute('setCornerHold', { ...authority(turn), cornerId: opened.cornerId }, WORKER)).rejects.toThrow('close the PR');
  await expect(daemon.execute('createCorner', { ...authority(order), targetRoomId: ROOM,
    name:'refused-hold', objective:'Replay supervision', hold:true }, RUBY)).rejects.toThrow('close the PR');
  await db.transaction(tx => setCornerHold(tx, {cornerId:opened.cornerId}, HUMAN));
  expect((await cornerMergeGate(db, opened.cornerId, {number:1,headSha:'head'})).held).toBe(true);
});
