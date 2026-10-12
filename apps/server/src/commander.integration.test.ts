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
import { readAgentCommands } from './agent-command.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64), RUBY = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
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
const commands = (roomId: string, agentId: string) => readAgentCommands(db, roomId, agentId).then(r => r.commands);
async function open() {
  return daemon.execute('createCorner', { ...authority(order), requestId: order.turnRequestId,
    targetRoomId: ROOM, name: 'Widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', approval: { sourceMessageId: order.sourceMessageId } },
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
  expect(opened.watch?.kinds).toEqual(['opened', 'merged', 'closed']);
});
it('delivers blocked privately to Ruby and Ruby orders the current worker privately', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { ...authority(turn), text: 'blocked: need an endpoint decision' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: WORKER, body: 'blocked: need an endpoint decision' } });
  await claim(report);
  await daemon.execute('order', { ...authority(report), address: opened.cornerId, text: 'Use endpoint v2' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'Use endpoint v2' } });
  expect((await db.query(`SELECT text FROM messages WHERE text IN ($1,$2)`,
    ['blocked: need an endpoint decision', 'Use endpoint v2'])).rowCount).toBe(0);
});
it('Ruby reports a decision she cannot settle to the captain visibly in the original DM', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await daemon.execute('report', { ...authority(turn), text: 'needs-decision: choose the product scope' }, WORKER);
  const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  await claim(report);
  await daemon.execute('report', { ...authority(report), text: 'needs-decision: choose the product scope' }, RUBY);
  const rows = (await db.query(`SELECT room_id,author_id,text FROM messages WHERE text=$1`,
    ['needs-decision: choose the product scope'])).rows;
  expect(rows).toEqual([{ room_id: DM, author_id: RUBY, text: 'needs-decision: choose the product scope' }]);
  expect((await phone.readRoom(DM, HUMAN))?.messages.some(m => m.text === rows[0]!.text)).toBe(true);
});
it('nested Room orders forward reports one commander at a time before reaching the human', async () => {
  const otherRoom = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Agent work',$3)`, [otherRoom, WS, HUMAN]);
  for (const agent of [RUBY, WORKER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [WS, otherRoom, agent]);
  await daemon.execute('order', { ...authority(order), address: ROOM, text: 'Run the project' }, RUBY);
  const managerOrder = (await commands(ROOM, WORKER)).find(c => c.reason === 'order')!;
  await claim(managerOrder);
  await daemon.execute('order', { ...authority(managerOrder), address: otherRoom, text: 'Decide the project scope' }, WORKER);
  const childOrder = (await commands(otherRoom, RUBY)).find(c => c.reason === 'order')!;
  await claim(childOrder);
  const text = 'needs-decision: select the final scope';
  await daemon.execute('report', { ...authority(childOrder), text }, RUBY);
  const managerReport = (await commands(ROOM, WORKER)).find(c => c.reason === 'report')!;
  await claim(managerReport);
  await daemon.execute('report', { ...authority(managerReport), text }, WORKER);
  const rubyReport = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
  expect(rubyReport).toMatchObject({ private: true, source: { authorId: WORKER, body: text } });
  expect((await db.query(`SELECT 1 FROM messages WHERE text=$1`, [text])).rowCount).toBe(0);
  await claim(rubyReport);
  await daemon.execute('report', { ...authority(rubyReport), text }, RUBY);
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
it('private final replies, drafts, activity and empty completion produce no transcript', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const before = (await db.query(`SELECT id FROM messages`)).rows;
  await daemon.execute('postAgentDraft', { ...authority(turn), agentId: WORKER, turnId: turn.turnRequestId, text: 'private draft' }, WORKER);
  await daemon.execute('postRoomMessage', { ...authority(turn), text: 'private final output' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete', completionKind: 'no-reply' }, WORKER);
  expect((await db.query(`SELECT id FROM messages`)).rows).toEqual(before);
  expect((await commands(opened.cornerId, WORKER))).toEqual([]);
});
it('reconnect recovery keeps every private report, even when each was queued offline', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  for (const text of ['blocked: missing input', 'failed: build stopped', 'needs-decision: select scope'])
    await daemon.execute('report', { ...authority(turn), text }, WORKER);
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
it('prepares the first brief of a human-opened corner from a member DM', async () => {
  const opened = await phone.execute('createHumanCorner', { roomId: ROOM, title: 'Widget' }, HUMAN);
  await expect(daemon.execute('renameCorner', { ...authority(order), cornerId: opened.id,
    name: 'Prepared', objective: 'Build the widget',
    brief: { spec: 'Build the widget', approval: { sourceMessageId: order.sourceMessageId } } }, RUBY))
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
  await daemon.execute('report', { ...authority(turn), text: 'done: widget ready for the next step' }, WORKER);
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
