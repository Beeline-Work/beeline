import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { cornerMergeGate, advanceCorner } from './corner-lifecycle.js';
import { isCornerReviewer } from './agent-health.js';
import { systemLine } from './system-line.js';
const H = 'a'.repeat(64), OWNER_AGENT = 'b'.repeat(64), REVIEWER_A = 'c'.repeat(64),
  REVIEWER_B = 'd'.repeat(64), OUTSIDER = 'e'.repeat(64);
const W = '11111111-1111-4111-8111-111111111112', R = '22222222-2222-4222-8222-222222222223',
  C = '33333333-3333-4333-8333-333333333334';
const HEAD = '1'.repeat(40);
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, github: GitHubOperations;
let authors: string[];
let requestId: string;
let incomplete = false, moved = false;
const reportPresence = async (agentId: string, status: string) => db.query(
  `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence',$3::jsonb)`,
  [R, agentId, JSON.stringify({ status, observedAt: Math.floor(Date.now()/1000) })]);
beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Owner','owner'),
       ($3,'agent','ReviewerA','reviewera'),($4,'agent','ReviewerB','reviewerb'),($5,'agent','Outsider','outsider')`,
    [H, OWNER_AGENT, REVIEWER_A, REVIEWER_B, OUTSIDER],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
       ($1,$5,NULL),($2,$5,'opus-4-5'),($3,$5,'opus-4-5'),($4,$5,'some-light-model')`,
    [OWNER_AGENT, REVIEWER_A, REVIEWER_B, OUTSIDER, H],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1,created_by=$3 WHERE id=$2`, [R, C, OWNER_AGENT]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Do work',$3::jsonb)`,
    [
      C,
      OWNER_AGENT,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: '1'.repeat(40) },
      }),
    ],
  );
  for (const who of [H, OWNER_AGENT, REVIEWER_A, REVIEWER_B, OUTSIDER])
    for (const room of [null, R])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  await reportPresence(REVIEWER_A, 'online');
  await reportPresence(REVIEWER_B, 'online');
  authors = [OWNER_AGENT]; incomplete = false; moved = false;
  const app = { issuesRequest: vi.fn(async (_token: string, _repo: string, _method: string, path: string) => {
    if (!path.includes('/commits?')) return { head: { sha: moved ? '2'.repeat(40) : HEAD }, commits: authors.length };
    const page = Number(new URL(`https://test/${path}`).searchParams.get('page') ?? 1);
    return incomplete ? [] : authors.slice((page - 1) * 100, page * 100).map(id => ({ commit: { author: { email: `${id.slice(0,16)}@users.noreply.github.com` },
      committer: { email: `${id.slice(0,16)}@users.noreply.github.com` }, message: 'Change' } }));
  }) };
  github = new GitHubOperations(db, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'test');
  vi.spyOn(github, 'roomAnchorTarget').mockResolvedValue({ token: 'test', repository: 'test/repo', defaultBranch: 'main' });
  phone = new PhoneService(db, 'http://test');
  daemon = Object.assign(new DaemonService(db, new LiveHub()), { github });
  await phone.execute('sendRoomMessage', { roomId: R, messageId: '9'.repeat(64), text: '@outsider Set the corner reviewer' }, H);
  const command = (await daemon.execute('getAgentCommands', { roomId: R }, OUTSIDER)).commands[0]!;
  await daemon.execute('claimAgentCommand', { roomId: R, commandId: command.id, generationId: 'reviewer-proof' }, OUTSIDER);
  requestId = command.turnRequestId;
});

afterEach(async () => { await db.close(); });
const set = (reviewer: string, actor = OUTSIDER) => daemon.execute('renameCorner', { roomId: R, requestId, generationId: 'reviewer-proof', cornerId: C, reviewer }, actor);
const approve = (actor: string) => daemon.execute('approveCornerMerge', { cornerId: C, headSha: HEAD }, actor);
const gate = () => cornerMergeGate(db, C, { number: 7, headSha: HEAD });

it('lets any member agent set and change the reviewer without a brief edit', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: REVIEWER_A }, H);
  await set('reviewerb');
  expect(await isCornerReviewer(db, C, REVIEWER_B)).toBe(true);
  expect(await isCornerReviewer(db, C, REVIEWER_A)).toBe(false);
  await expect(approve(REVIEWER_A)).rejects.toThrow('NOT_CONFIGURED_REVIEWER');
  await approve(REVIEWER_B);
  expect(await gate()).toMatchObject({ approved: true, open: true });
  await set('reviewera');
  expect(await gate()).toMatchObject({ approved: false, open: false });
  await set('reviewera');
  const lines = await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%set the corner reviewer%'`, [C]);
  expect(lines.rowCount).toBe(2);
  expect((await db.query(`SELECT reviewer_agent_id FROM rooms WHERE id=$1`, [R])).rows[0]).toEqual({ reviewer_agent_id: REVIEWER_A });
});

it('retains the Room reviewer and fallbacks when the corner override is unset', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: REVIEWER_A, reviewerFallbackIds: [REVIEWER_B] }, H);
  expect(await isCornerReviewer(db, C, REVIEWER_A)).toBe(true);
  expect(await isCornerReviewer(db, C, REVIEWER_B)).toBe(true);
  await approve(REVIEWER_B);
  expect((await gate()).approved).toBe(true);
});

it('refuses the implementer, commit authors, people and nonmembers when setting the reviewer', async () => {
  await expect(set('owner')).rejects.toThrow('implementer cannot review');
  authors = [...Array<string>(100).fill(OWNER_AGENT), REVIEWER_B];
  await expect(set('reviewerb')).rejects.toThrow('commit author cannot review');
  await expect(set('human')).rejects.toThrow('agent member');
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, REVIEWER_B]);
  await expect(set('reviewerb')).rejects.toThrow('agent member');
});

it('rechecks authors at PASS time after a reviewer contributes commits', async () => {
  await set('reviewerb');
  authors.push(REVIEWER_B);
  await expect(approve(REVIEWER_B)).rejects.toThrow('commit author cannot review');
  expect((await gate()).approved).toBe(false);
});

it('refuses self approval even through a Room fallback', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: REVIEWER_A, reviewerFallbackIds: [OWNER_AGENT] }, H);
  await expect(approve(OWNER_AGENT)).rejects.toThrow('implementer cannot review');
});

it('fails closed on incomplete authors or a changed live head', async () => {
  incomplete = true;
  await expect(set('reviewerb')).rejects.toThrow('incomplete');
  incomplete = false; moved = true;
  await expect(set('reviewerb')).rejects.toThrow('PR head changed');
});

it('dispatches green review to the corner reviewer and projects its reviewer surface', async () => {
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: REVIEWER_A }, H);
  await set('reviewerb');
  const note = await systemLine(db, { roomId: C, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed checks',
    kind: 'check-passed', object: { text: 'checks', headSha: HEAD } });
  await advanceCorner(db, C, { kind: 'checks', result: 'passing', sourceMessageId: note.id });
  const commands = await daemon.execute('getAgentCommands', { roomId: C }, REVIEWER_B);
  expect(commands.commands.some(command => command.reason === 'corner_review_dispatch')).toBe(true);
  expect(await daemon.execute('getAgentConfiguration', { roomId: C, agentId: REVIEWER_B }, REVIEWER_B)).toMatchObject({ isReviewer: true });
});
