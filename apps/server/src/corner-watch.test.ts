import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { GITHUB_SUBJECT, systemLine } from './system-line.js';
import { readAgentCommands } from './agent-command.js';
import { ensureCornerWorkflowSeeded } from './corner-workflow.js';
import type { CornerWatchKind } from '@beeline/api-contract/daemon';

const W = 'a'.repeat(64),
  H = 'b'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
let db: PgliteDatabase, daemon: DaemonService;
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Watcher'),($2,'human','Owner')`,
    [W, H],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [W, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Watch test')`, [WS]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$4,'Parent',NULL),($2,$4,'A',$1),($3,$4,'B',$1)`,
    [P, A, B, WS],
  );
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other parent')`, [
    OTHER,
    WS,
  ]);
  await db.query(
    `INSERT INTO corner_facts(corner_id,workflow_state,owner_agent_id) VALUES($1,'implement',$3),($2,'implement',$3)`,
    [A, B, W],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, A, W],
  );
  daemon = new DaemonService(db, new LiveHub());
  await ensureCornerWorkflowSeeded(db, WS, P);
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM messages`);
  await db.query(`DELETE FROM corner_watches`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`UPDATE rooms SET archived_at=NULL`);
  await db.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [B, P]);
  await db.query(
    `UPDATE corner_facts SET workflow_state='implement',lifecycle='{"lifecycle":"working","checks":"unknown"}'`,
  );
});
const watch = (kinds: CornerWatchKind[] = ['merged'], roomId = A, cornerId = B, agentId = W) =>
  daemon.execute('watchCorner', { roomId, cornerId, kinds }, agentId);
const emit = (kind: CornerWatchKind = 'merged') =>
  systemLine(db, {
    roomId: B,
    id: `event-${kind}`,
    authorId: H,
    subject: GITHUB_SUBJECT,
    verb: kind === 'merged' ? 'merged' : 'checked',
    kind,
    object: { text: 'Ship widget', url: 'https://github.com/owner/widgets/pull/42' },
    durableFact: 'merge',
  });
const wakes = () => readAgentCommands(db, A, W).then((r) => r.commands);

it('Reproduction O-2: a watcher receives a named sibling merge in A', async () => {
  await daemon.execute('setEventSubscriptions', { roomId: A, kinds: ['merged'] }, W);
  await watch();
  // Production archives the watched corner before writing its merge line.
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [B]);
  await emit();
  const commands = await wakes();
  console.info(`Reproduction O-2: watcher wakes in A = ${commands.length}, body names B`);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    roomId: A,
    reason: 'watched_corner',
    action: 'input',
    sourceMessageId: 'event-merged',
  });
  expect(commands[0]!.source.body).toContain(`Watched corner B (${B}): merged`);
});

it.each(['non-member', 'non-sibling', 'self', 'archived', 'room', 'invalid kind'])(
  'refuses %s and writes nothing',
  async (reason) => {
    if (reason === 'non-sibling')
      await db.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [B, OTHER]);
    if (reason === 'archived')
      await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [B]);
    await expect(
      watch(
        reason === 'invalid kind' ? ['joined' as CornerWatchKind] : ['merged'],
        A,
        reason === 'self' ? A : reason === 'room' ? P : B,
        reason === 'non-member' ? H : W,
      ),
    ).rejects.toThrow(
      reason === 'non-member'
        ? 'access denied'
        : reason === 'self'
          ? 'cannot watch itself'
          : reason === 'invalid kind'
            ? 'watch kinds'
            : 'active child or sibling',
    );
    expect((await db.query(`SELECT * FROM corner_watches`)).rowCount).toBe(0);
  },
);

it('returns all merged PR snapshot fields from corner facts', async () => {
  await db.query(
    `UPDATE corner_facts SET workflow_state='done',lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      B,
      JSON.stringify({
        lifecycle: 'done',
        checks: 'passing',
        pr: {
          number: 42,
          url: 'https://github.com/owner/widgets/pull/42',
          headSha: 'a'.repeat(40),
          mergeCommitSha: 'b'.repeat(40),
        },
      }),
    ],
  );
  expect(await watch()).toEqual({
    kinds: ['merged'],
    snapshot: {
      id: B,
      name: 'B',
      workflowState: 'done',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
      headSha: 'a'.repeat(40),
      checks: 'passing',
      mergeCommitSha: 'b'.repeat(40),
    },
  });
  expect(await wakes()).toEqual([]);
});

it('lets a parent Room watch its child', async () => {
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, P, W],
  );
  expect((await watch(['merged'], P)).snapshot.id).toBe(B);
  await emit();
  expect((await readAgentCommands(db, P, W)).commands).toHaveLength(1);
});

it('filters kinds and replaces the earlier watch', async () => {
  await watch(['check-failed']);
  await watch();
  await emit('check-failed');
  expect(await wakes()).toEqual([]);
  await emit();
  expect(await wakes()).toHaveLength(1);
});

it.each(['check-passed', 'check-failed'] as const)(
  'fans out %s even through the workflow route',
  async (kind) => {
    await watch([kind]);
    await emit(kind);
    expect(await wakes()).toHaveLength(1);
    expect((await wakes())[0]!.source.body).toContain(`Watched corner B (${B}): ${kind}`);
  },
);

it('an empty list removes the watch', async () => {
  await watch();
  expect((await watch([])).kinds).toEqual([]);
  expect((await db.query(`SELECT * FROM corner_watches`)).rowCount).toBe(0);
  await emit();
  expect(await wakes()).toEqual([]);
});

it('a duplicate line wakes once', async () => {
  await watch();
  expect((await emit()).inserted).toBe(true);
  expect((await emit()).inserted).toBe(false);
  expect(await wakes()).toHaveLength(1);
});

it.each(['removed membership', 'archived watcher'])('%s stops wakes', async (reason) => {
  await watch();
  if (reason === 'removed membership')
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1`, [A]);
  else await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [A]);
  await emit();
  expect(await wakes()).toEqual([]);
});
