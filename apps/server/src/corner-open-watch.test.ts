import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { readAgentCommands } from './agent-command.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

/**
 * open_corner watches the new corner for `merged` on the opener's behalf, and
 * a late watch_corner on a merged corner hands back the merge. Merges drive the
 * real GitHub `pull_request` closed webhook.
 */

const H = 'a'.repeat(64),
  A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, github: GitHubOperations;
let pr = 0;

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`,
    [H, A],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Watch')`, [W]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,
       repository_target_branch,github_installation_id)
     VALUES($1,$2,'Widgets','owner/widgets','https://github.com/owner/widgets.git','repository','main',77)`,
    [R, W],
  );
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'42','owner','User','selected','active')`,
    [H],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/widgets','main')`,
  );
  for (const who of [H, A])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [W, who, R],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
  github = new GitHubOperations(
    db,
    {} as unknown as GitHubOAuthClient,
    { deleteBranch: vi.fn(async () => undefined) } as unknown as GitHubAppClient,
    'secret',
  );
}, 30_000);
afterAll(async () => db?.close());

async function open(watchMerge?: boolean) {
  await phone.execute(
    'sendRoomMessage',
    { roomId: R, messageId: randomBytes(32).toString('hex'), text: '@ruby please do this' },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId: R }, A)).commands.at(-1)!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: R, commandId: command.id, generationId: 'g1' },
    A,
  );
  pr += 1;
  return daemon.execute(
    'createCorner',
    {
      roomId: R,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: `Step-${pr}`,
      objective: 'Ship the widget end to end',
      repository: 'owner/widgets',
      targetBranch: 'main',
      ...(watchMerge === undefined ? {} : { watchMerge }),
      brief: { spec: 'Ship the widget', approval: { sourceMessageId: command.sourceMessageId } },
    },
    A,
  );
}

/** Lands the corner's pull request through the real merge webhook. */
async function merge(cornerId: string) {
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  const number = 100 + pr;
  const url = `https://github.com/owner/widgets/pull/${number}`;
  await db.query(
    `UPDATE corner_facts SET feature_branch=$2,lifecycle=$3::jsonb WHERE corner_id=$1`,
    [
      cornerId,
      branch,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: { number, url, headSha: '9'.repeat(40), targetBranch: 'main' },
      }),
    ],
  );
  await github.processWebhook('pull_request', {
    installation: { id: 77 },
    repository: { id: 101, full_name: 'owner/widgets' },
    action: 'closed',
    pull_request: {
      number,
      title: 'Ship the widget',
      html_url: url,
      head: { ref: branch, sha: '9'.repeat(40) },
      base: { ref: 'main' },
      merged: true,
      merged_at: '2026-10-08T20:03:00Z',
      merge_commit_sha: 'f'.repeat(40),
      commits: 1,
      changed_files: 1,
    },
    sender: { login: 'octocat' },
  });
}

/** The opener's merge wakes in the parent Room, whichever route queued them. */
async function mergeWakes() {
  return (await readAgentCommands(db, R, A)).commands.filter(
    (c) => c.reason === 'watched_corner' || c.reason === 'subscribed_event',
  );
}

async function clearWakes() {
  await db.query(
    `UPDATE agent_commands SET state='complete',completed_at=now()
     WHERE room_id=$1 AND reason IN ('watched_corner','subscribed_event')`,
    [R],
  );
}

it('open_corner watches for merged by default and the merge wakes the opener once', async () => {
  await clearWakes();
  const created = await open();
  expect(created.watch).toEqual({ roomId: R, kinds: ['merged'] });
  await merge(created.cornerId);
  const wakes = await mergeWakes();
  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.reason).toBe('watched_corner');
  expect(wakes[0]!.source.body).toContain(
    `Watched corner Step-${pr} (${created.cornerId}): merged · merge commit ${'f'.repeat(40)}`,
  );
}, 30_000);

it('watchMerge false opens without a watch and the merge wakes nobody', async () => {
  await clearWakes();
  const created = await open(false);
  expect(created.watch).toBeUndefined();
  await merge(created.cornerId);
  expect(await mergeWakes()).toEqual([]);
}, 30_000);

it('a late watch_corner on a merged corner returns the merge and wakes once', async () => {
  await clearWakes();
  const created = await open(false);
  await merge(created.cornerId);
  const late = await daemon.execute(
    'watchCorner',
    { roomId: R, cornerId: created.cornerId, kinds: ['merged'] },
    A,
  );
  expect(late).toMatchObject({
    kinds: [],
    state: 'merged',
    woken: true,
    snapshot: { id: created.cornerId, mergeCommitSha: 'f'.repeat(40) },
  });
  expect(await mergeWakes()).toHaveLength(1);
  // Asking again does not wake a second time for the same merge.
  expect(
    await daemon.execute(
      'watchCorner',
      { roomId: R, cornerId: created.cornerId, kinds: ['merged'] },
      A,
    ),
  ).toMatchObject({ state: 'merged', woken: false });
  expect(await mergeWakes()).toHaveLength(1);
}, 30_000);

it('a watch_corner on a corner closed without merging says so', async () => {
  const created = await open(false);
  await daemon.execute('archiveCorner', { cornerId: created.cornerId }, A);
  expect(
    await daemon.execute(
      'watchCorner',
      { roomId: R, cornerId: created.cornerId, kinds: ['merged'] },
      A,
    ),
  ).toMatchObject({
    kinds: [],
    state: 'closed',
    snapshot: { id: created.cornerId, mergeCommitSha: null },
  });
  expect(
    (await db.query(`SELECT 1 FROM corner_watches WHERE corner_id=$1`, [created.cornerId]))
      .rowCount,
  ).toBe(0);
}, 30_000);

it('an opener also subscribed to Room merged is woken once by one merge', async () => {
  await clearWakes();
  await daemon.execute('setEventSubscriptions', { roomId: R, kinds: ['merged'] }, A);
  try {
    const created = await open();
    expect(created.watch).toEqual({ roomId: R, kinds: ['merged'] });
    await merge(created.cornerId);
    const wakes = await mergeWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.source.body).toContain(created.cornerId);
    expect(wakes[0]!.source.body).toContain(`merge commit ${'f'.repeat(40)}`);
  } finally {
    await daemon.execute('setEventSubscriptions', { roomId: R, kinds: [] }, A);
  }
}, 30_000);
