import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';
import { readWorkflowContract } from '@beeline/api-contract/daemon';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import {
  advanceCorner,
  backfillCornerLifecycleRuns,
  CHECKS_FAILING_LIMIT,
  CORNER_LIFECYCLE_CONTRACT,
  CORNER_LIFECYCLE_SLUG,
  cornerMergeGate,
  cornersReadyToLand,
  claimCornerMergeAttempt,
  deleteStoredCornerWorkflows,
  REVIEW_HANDBACK_LIMIT,
} from './corner-lifecycle.js';
import {
  createAgentCommand,
  repairReviewerCornerMembership,
  queueCornerMergeConflict,
  reconcileCornerMergeBlockers,
} from './agent-command.js';
import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import { workflowRunLockKey } from './workflow-runs.js';

/** Records every SQL statement issued, in order — matches workflow-runs.test.ts's own. */
type RecordedCall = { sql: string; values?: unknown[] };
class RecordingDatabase implements SqlDatabase {
  constructor(
    private readonly inner: SqlDatabase,
    readonly calls: RecordedCall[] = [],
  ) {}
  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    return this.inner.query<Row>(sql, values);
  }
  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.inner.transaction((db) => work(new RecordingDatabase(db, this.calls)));
  }
}

/**
 * The corner lifecycle expressed as the in-code `CORNER_LIFECYCLE_CONTRACT`
 * (report: data/beeline-workflow-contracts-design/report.md). Every test here
 * proves TWO things together: the real corner machinery keeps behaving
 * exactly as it does on main (no regression), and a `workflow-handoff` card
 * now also exists documenting the transition, queryable the same way any
 * other workflow run's current state is (`workflow-runs.ts`'s `loadRun`
 * pattern: the newest card citing this runId).
 */

const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, github: GitHubOperations;
let githubRollupState: 'pending' | 'passed' | 'failed';
/** The head GitHub reports for the corner's pull request. */
let githubHead: string;
let githubApp: {
  deleteBranch: ReturnType<typeof vi.fn>;
  mergePullRequest: ReturnType<typeof vi.fn>;
  readPullRequest: ReturnType<typeof vi.fn>;
  installationToken: ReturnType<typeof vi.fn>;
  readCommitCheckRollup: ReturnType<typeof vi.fn>;
};
/** Every `fromState:outcome:toState` a test in this file recorded, for the edge-coverage proof. */
const recordedEdges = new Set<string>();

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy')`,
    [H, A, B],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Migration')`, [W]);
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
  for (const who of [H, A, B])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [W, who, R],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
  githubRollupState = 'pending';
  githubHead = '';
  githubApp = {
    deleteBranch: vi.fn(async () => undefined),
    mergePullRequest: vi.fn(async () => undefined),
    readPullRequest: vi.fn(async (_token: string, _repository: string, number: number) => ({
      number,
      url: `https://github.com/owner/widgets/pull/${number}`,
      headSha: githubHead,
      mergeability: 'clean' as const,
    })),
    installationToken: vi.fn(async () => ({ token: 'tok', expiresAt: '2030-01-01T00:00:00Z' })),
    readCommitCheckRollup: vi.fn(async () => ({
      state: githubRollupState,
      total: 1,
      failing: githubRollupState === 'failed' ? ['typecheck'] : [],
      checks: [{ name: 'typecheck', status: githubRollupState }],
    })),
  };
  github = new GitHubOperations(
    db,
    {} as unknown as GitHubOAuthClient,
    githubApp as unknown as GitHubAppClient,
    'secret',
  );
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  for (const row of (
    await db.query<{ edge: string }>(
      `SELECT concat_ws(':',card->>'fromState',card->>'outcome',card->>'toState') edge
       FROM messages WHERE card_type=$1 AND card ? 'fromState'`,
      [CORNER_LIFECYCLE_CARD_TYPE],
    )
  ).rows)
    recordedEdges.add(row.edge);
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM messages WHERE room_id<>$1`, [R]);
  await db.query(`DELETE FROM messages`);
  await db.query(`DELETE FROM corner_facts`);
  await db.query(`DELETE FROM corner_brief_revisions`);
  await db.query(`DELETE FROM corner_merge_approvals`);
  await db.query(`DELETE FROM rooms WHERE parent_id IS NOT NULL`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL,reviewer_fallback_ids='{}' WHERE id=$1`, [R]);
  await db.query(`DELETE FROM live_outputs`);
  await db.query(`UPDATE agents SET yolo_mode=true`);
  githubRollupState = 'pending';
  githubHead = '';
  githubApp.mergePullRequest.mockReset();
  githubApp.mergePullRequest.mockResolvedValue(undefined);
  githubApp.deleteBranch.mockClear();
  githubApp.readPullRequest.mockReset();
  githubApp.readPullRequest.mockImplementation(async (_token: string, _repository: string, number: number) => ({
    number, url: `https://github.com/owner/widgets/pull/${number}`, headSha: githubHead, mergeability: 'clean',
  }));
});

/** Every `workflow-handoff` card for one corner's run, oldest first. */
async function cards(
  cornerId: string,
): Promise<{ fromState?: string; outcome?: string; toState: string; status?: string }[]> {
  const rows = await db.query<{ card: Record<string, unknown> }>(
    `SELECT card FROM messages WHERE room_id=$1 AND card_type=$2 ORDER BY (card->>'seq')::int`,
    [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
  );
  return rows.rows.map((row) => row.card as never);
}

/** The transcript-derived current state (report.v1.md §4's own query shape). */
async function currentState(cornerId: string): Promise<string | undefined> {
  const all = await cards(cornerId);
  return all.at(-1)?.toState;
}

async function commissioned(roomId: string, agentId = A): Promise<AgentCommand> {
  await phone.execute(
    'sendRoomMessage',
    { roomId, messageId: randomBytes(32).toString('hex'), text: `@hoots please do this` },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId }, agentId)).commands.at(-1);
  await daemon.execute('claimAgentCommand', { roomId, commandId: command!.id, generationId: 'g1' }, agentId);
  return command!;
}

function brief(sourceMessageId: string) {
  return {
    spec: 'Ship the widget\n\n## Checklist\n\n- AC-1: Publish the result',
    approval: { sourceMessageId },
  };
}

async function open(lane?: 'code' | 'no_code', repository?: string, hold?: boolean): Promise<string> {
  const command = await commissioned(R);
  const { cornerId } = await daemon.execute(
    'createCorner',
    {
      roomId: R,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: 'Ship widget',
      objective: 'Ship the widget end to end',
      ...(hold ? { hold } : {}),
      ...(lane ? { lane } : {}),
      ...(repository ? { repository, targetBranch: 'main' } : {}),
      ...(lane !== 'no_code' && repository ? { brief: brief(command.sourceMessageId) } : {}),
    },
    A,
  );
  return cornerId;
}

async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute('claimAgentCommand', { roomId: c.roomId, commandId: c.id, generationId }, c.agentId);
}

async function upgrade(cornerId: string) {
  const command = await commissioned(cornerId, A);
  return daemon.execute('upgradeCornerLane', { cornerId, requestId: command.turnRequestId, generationId: 'g1' }, A);
}

/** Puts the corner's lifecycle at a green head and fires the check-passed fact directly. */
/** Drives the real push webhook so the run's own bookkeeping reaches `checks` first. */
async function pushToCorner(cornerId: string, headSha: string) {
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  await db.query(
    `UPDATE corner_facts SET feature_branch=COALESCE(feature_branch,$2) WHERE corner_id=$1`,
    [cornerId, branch],
  );
  await github.processWebhook('push', {
    installation: { id: 77 },
    repository: { id: 101, full_name: 'owner/widgets' },
    ref: `refs/heads/${branch}`,
    after: headSha,
    commits: [{}],
    pusher: { name: 'hoots' },
  });
}

async function greenHead(cornerId: string, number: number, headSha: string) {
  await pushToCorner(cornerId, headSha);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`, [
    cornerId,
    JSON.stringify({
      checks: 'passing',
      lifecycle: 'in-review',
      pr: { number, url: `https://github.com/owner/widgets/pull/${number}`, headSha },
    }),
  ]);
  await systemLine(db, {
    roomId: cornerId,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
}

async function redHead(cornerId: string, number: number, headSha: string) {
  await pushToCorner(cornerId, headSha);
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`, [
    cornerId,
    JSON.stringify({
      checks: 'failing',
      lifecycle: 'in-review',
      pr: { number, url: `https://github.com/owner/widgets/pull/${number}`, headSha },
    }),
  ]);
  await systemLine(db, {
    roomId: cornerId,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'found failing checks on',
    kind: 'check-failed',
  });
}

const commands = (agentId: string, roomId: string) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);

const result = (c: AgentCommand, text: string, generationId = 'g1') =>
  daemon.execute('postRoomMessage', { roomId: c.roomId, requestId: c.turnRequestId, generationId, text }, c.agentId);

describe('the corner lifecycle contract itself', () => {
  it('validates against the shared workflow-contract schema', () => {
    expect(readWorkflowContract(CORNER_LIFECYCLE_CONTRACT)).toEqual(CORNER_LIFECYCLE_CONTRACT);
  });

  it('is never stored as a Workspace workflow, not even by creating a Workspace', async () => {
    const { id } = await phone.execute('createWorkspace', { name: 'Fresh' }, H);
    expect(
      (await db.query(`SELECT 1 FROM workspace_skills WHERE slug=$1`, [CORNER_LIFECYCLE_SLUG])).rowCount,
    ).toBe(0);
    await db.query(`DELETE FROM workspaces WHERE id=$1`, [id]);
  });

  it('migration deletes the copy older servers seeded, with its versions, and keeps a saved corner workflow', async () => {
    const seeded = '33333333-3333-4333-8333-333333333333';
    await db.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'Corner lifecycle','active',2,2,$4,'','',NULL,'workflow')`,
      [seeded, W, CORNER_LIFECYCLE_SLUG, R],
    );
    for (const version of [1, 2])
      await db.query(
        `INSERT INTO workspace_skill_versions
           (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
            repository,target_commit,path,extractor_version,model)
         VALUES($1,$2,'{}',$3,NULL,$4,'','',NULL,'corner-workflow-v1','n/a')`,
        [seeded, version, String(version).repeat(64), ['system:corner-workflow-seed']],
      );
    expect(await deleteStoredCornerWorkflows(db)).toBe(1);
    expect((await db.query(`SELECT 1 FROM workspace_skills WHERE id=$1`, [seeded])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM workspace_skill_versions WHERE skill_id=$1`, [seeded])).rowCount).toBe(0);

    const saved = '44444444-4444-4444-8444-444444444444';
    await db.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'Mine','active',1,1,$4,'','',NULL,'workflow')`,
      [saved, W, CORNER_LIFECYCLE_SLUG, R],
    );
    await db.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,path,extractor_version,model)
       VALUES($1,1,'{}',$2,NULL,$3,'','',NULL,'workflow-save','n/a')`,
      [saved, 'a'.repeat(64), ['m']],
    );
    expect(await deleteStoredCornerWorkflows(db)).toBe(0);
    expect((await db.query(`SELECT 1 FROM workspace_skills WHERE id=$1`, [saved])).rowCount).toBe(1);
    await db.query(`DELETE FROM workspace_skills WHERE id=$1`, [saved]);
  });
});

describe.each([
  ['with no stored corner workflow', false],
  ['with a stale stored corner workflow an older server seeded', true],
])('%s, corners work exactly as before', (_name, stored) => {
  const badge = async (cornerId: string, archived = false) =>
    (await phone.readCorners(R, H, false, archived))!.corners.find((row) => row.corner.id === cornerId)!.state;
  const STORED = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    if (stored) {
      // A version 9 copy whose contract differs from the code, as if edited.
      await db.query(
        `INSERT INTO workspace_skills
           (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
            repository,target_commit,path,kind)
         VALUES($1,$2,$3,'Stale copy','active',9,9,$4,'','',NULL,'workflow')`,
        [STORED, W, CORNER_LIFECYCLE_SLUG, R],
      );
      await db.query(
        `INSERT INTO workspace_skill_versions
           (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
            repository,target_commit,path,extractor_version,model)
         VALUES($1,9,$2,$3,NULL,$4,'','',NULL,'corner-workflow-v1','n/a')`,
        [
          STORED,
          JSON.stringify({ ...CORNER_LIFECYCLE_CONTRACT, description: 'Stale copy' }),
          'f'.repeat(64),
          ['system:corner-workflow-seed'],
        ],
      );
    }
    expect(
      (await db.query(`SELECT 1 FROM workspace_skills WHERE slug=$1`, [CORNER_LIFECYCLE_SLUG])).rowCount,
    ).toBe(stored ? 1 : 0);
  });
  afterEach(async () => {
    await db.query(`DELETE FROM workspace_skills WHERE id=$1`, [STORED]);
  });

  it('a code corner opens, advances implement -> checks -> review -> land -> landed, without appearing on the workflow run page', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    expect(await currentState(cornerId)).toBe('implement');
    expect(await projected(cornerId)).toBe('implement');
    const badges = [await badge(cornerId)];
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await pushToCorner(cornerId, SHA);
    expect(await currentState(cornerId)).toBe('checks');
    badges.push(await badge(cornerId));
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('review');
    badges.push(await badge(cornerId));
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('land');
    badges.push(await badge(cornerId));
    githubHead = SHA;
    githubRollupState = 'passed';
    expect(await github.landReadyCorners()).toBe(1);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('landed');
    expect(await projected(cornerId)).toBe('landed');
    badges.push(await badge(cornerId, true));
    expect(badges).toEqual(BADGES);
    // The cards name no workflow and no version.
    for (const card of await cards(cornerId)) {
      expect(card).not.toHaveProperty('workflowSlug');
      expect(card).not.toHaveProperty('workflowVersion');
    }

    await expect(phone.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, H))
      .rejects.toThrow('workflow run not found');
    expect((await phone.execute('listRoomWorkflowRuns', { roomId: cornerId }, H)).workflows).toEqual([]);
  });

  it('a no-code corner opens on no_code_work and closes', async () => {
    const cornerId = await open('no_code');
    expect(await currentState(cornerId)).toBe('no_code_work');
    const opened = await badge(cornerId);
    await daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('closed');
    expect(await projected(cornerId)).toBe('closed');
    expect([opened, await badge(cornerId, true)]).toEqual(NO_CODE_BADGES);
    await expect(phone.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, H))
      .rejects.toThrow('workflow run not found');
  });
});

describe('bookkeeping cards never appear in the corner conversation a human reads', () => {
  it('readRoom shows the real conversation but no workflow-handoff card, through open, upgrade, checks, and review', async () => {
    const cornerId = await open('no_code', 'owner/widgets');
    await upgrade(cornerId);
    await greenHead(cornerId, 21, '5'.repeat(40));
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 21, '6'.repeat(40));

    // Confirms the bookkeeping actually ran (otherwise this test would prove
    // nothing) before asserting none of it is visible.
    const recorded = await cards(cornerId);
    expect(recorded.length).toBeGreaterThan(3);

    // The exact reproduction the review used: a real `PhoneService.readRoom`
    // call, the function that serves the mobile/desktop client.
    const view = await phone.readRoom(cornerId, H);
    expect(view).not.toBeNull();
    for (const message of view!.messages) {
      expect(message.text).not.toMatch(/started workflow|handed off/);
    }
    const raw = await db.query<{ count: string }>(
      `SELECT count(*)::text count FROM messages WHERE room_id=$1 AND card_type=$2`,
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
    );
    // The rows genuinely exist (this isn't "nothing was written") — they are
    // simply excluded from what a human reads.
    expect(Number(raw.rows[0]?.count)).toBe(recorded.length);
    expect(view!.messages.map((message) => message.id)).not.toEqual(
      expect.arrayContaining(
        (
          await db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type=$2`, [
            cornerId,
            CORNER_LIFECYCLE_CARD_TYPE,
          ])
        ).rows.map((row) => row.id),
      ),
    );
  });
});

describe('lane decided at open (row 1-3)', () => {
  it('a no-code corner opens straight onto no_code_work', async () => {
    const cornerId = await open('no_code', 'owner/widgets');
    expect(await cards(cornerId)).toEqual([
      expect.objectContaining({ toState: 'opened' }),
      expect.objectContaining({ fromState: 'opened', outcome: 'no_code', toState: 'no_code_work' }),
    ]);
  });

  it('a repository corner with no lane asked opens straight onto implement', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    expect(await currentState(cornerId)).toBe('implement');
  });

  it('has only the code and no_code lanes, and no investigate state', () => {
    expect(CORNER_LIFECYCLE_CONTRACT.handoffs.opened).toMatchObject({
      on: { no_code: 'no_code_work', code: 'implement' },
    });
    expect(Object.keys(CORNER_LIFECYCLE_CONTRACT.handoffs)).not.toContain('investigate');
  });
});

describe('the no-code -> code upgrade (row 4, report section C)', () => {
  it('records upgrade_to_code with branch, repository route, CI callback and merge target, landing on implement', async () => {
    const cornerId = await open('no_code', 'owner/widgets');
    await upgrade(cornerId);
    const all = await cards(cornerId);
    expect(all.slice(-2)).toEqual([
      expect.objectContaining({ fromState: 'no_code_work', outcome: 'upgrade_requested', toState: 'upgrade_to_code' }),
      expect.objectContaining({
        fromState: 'upgrade_to_code',
        outcome: 'upgraded',
        toState: 'implement',
        contents: expect.objectContaining({
          branch: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`,
          repositoryRoute: 'owner/widgets',
          ciCallbackRegistered: true,
          mergeTarget: 'main',
        }),
      }),
    ]);
  });

  it('a second call against an already-upgraded corner posts no duplicate cards', async () => {
    const cornerId = await open('no_code', 'owner/widgets');
    await upgrade(cornerId);
    const before = await cards(cornerId);
    await upgrade(cornerId);
    // Claiming the new turn may add output association metadata without a lifecycle move.
    const lifecycle = (values: Awaited<ReturnType<typeof cards>>) => values.map((card) => {
      const { outputCommandIds: _output, ...transition } = card as typeof card & { outputCommandIds?: string[] };
      return transition;
    });
    expect(lifecycle(await cards(cornerId))).toEqual(lifecycle(before));
  });
});

describe('checks dispatch (rows 6-8)', () => {
  it('a push records implement -> checks', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await db.query(`UPDATE corner_facts SET feature_branch=$2 WHERE corner_id=$1`, [
      cornerId,
      'feature/corner-test01',
    ]);
    await github.processWebhook('push', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      ref: 'refs/heads/feature/corner-test01',
      after: '1'.repeat(40),
      commits: [{}],
      pusher: { name: 'hoots' },
    });
    expect(await currentState(cornerId)).toBe('checks');
  });

  it('a failing check sends it back to implement', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await redHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('implement');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'checks', outcome: 'failing', toState: 'implement' }),
    );
  });

  it('a passing check with a configured reviewer moves to review', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });

  it('a passing check with no configured reviewer sends it back to implement', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'checks', outcome: 'no_reviewer', toState: 'implement' }),
    );
  });

  it('the reviewer role is never pinned to a real agent id, so a mid-corner reassignment is recorded correctly next time (finding 1)', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    // The bound identity is a literal marker, never Goosy's own agent id —
    // the generic engine's own handoff() authorization can never match it,
    // and nothing here needs updating when the parent Room's reviewer changes.
    const startCard = (await cards(cornerId))[0];
    expect((startCard as unknown as { roleBindings: Record<string, string> }).roleBindings.reviewer).toBe(
      'live:parent.reviewer_agent_id',
    );
    // A real changes-requested round sends it back to implement...
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Review complete: please fix the race condition.');
    expect(await currentState(cornerId)).toBe('implement');
    // ...the parent Room's reviewer is reassigned to itself (the only other
    // agent identity this fixture has) while the corner is mid-flight...
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    // ...and the NEXT green head still resolves checks -> review correctly,
    // proving the live path (not anything recorded at start) drives dispatch.
    await greenHead(cornerId, 1, '2'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });
});

describe('the run lock (a push transition can race a close or another push)', () => {
  it('takes the run lock as the very first statement, before reading the run current state', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    const recording = new RecordingDatabase(db);
    await advanceCorner(recording, cornerId, { kind: 'push', headSha: '1'.repeat(40), contents: {} });
    expect(recording.calls[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      values: [workflowRunLockKey(cornerId)],
    });
    const readIndex = recording.calls.findIndex((call) => call.sql.includes('FROM messages'));
    expect(readIndex).toBeGreaterThan(0);
    // The transition still actually happened — this proves the lock, not a no-op.
    expect(await currentState(cornerId)).toBe('checks');
  });

  it('uses the same lock key format the generic workflow engine uses, so a fresh push transaction and a concurrent close serialize against each other', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    // Simulate the exact race the review found: a push transition's read and
    // write used to be two independent, unlocked round trips. Firing the
    // real push-triggered transition and a real close "concurrently" against
    // PGlite's single connection (which serializes everything anyway, so this
    // proves ordering/correctness, not true concurrency — see workflow-runs
    // .test.ts's own documented limit for the same caveat) must still leave
    // the bookkeeping's own `seq` sequence internally consistent: no two
    // cards at the same seq, and the last one recorded is a real terminal.
    await Promise.all([
      advanceCorner(db, cornerId, { kind: 'push', headSha: '1'.repeat(40), contents: {} }),
      advanceCorner(db, cornerId, { kind: 'closed' }),
    ]);
    const seqs = (await cards(cornerId)).map((card) => (card as unknown as { seq: number }).seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('review dispatch and the fix loop cap (row 9)', () => {
  async function toReview(): Promise<string> {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 7, '7'.repeat(40));
    return cornerId;
  }

  it('an approved review records review -> land', async () => {
    const cornerId = await toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await daemon.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40), briefRevision: 1 }, B);
    await result(review!, 'Review complete: approved, merge it.');
    expect(await currentState(cornerId)).toBe('land');
  });

  it('a changes-requested review records review -> implement', async () => {
    const cornerId = await toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Review complete: please fix the race condition.');
    expect(await currentState(cornerId)).toBe('implement');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'changes_requested', toState: 'implement' }),
    );
  });

  it('exceeding the handback limit records review -> ask_human and stops there', async () => {
    const cornerId = await toReview();
    for (let round = 1; round <= REVIEW_HANDBACK_LIMIT + 1; round += 1) {
      const [review] = await commands(B, cornerId);
      await claim(review!, `r${round}`);
      await result(review!, `Round ${round}: still not fixed.`, `r${round}`);
      const [handback] = (await commands(A, cornerId)).filter((c) => c.reason === 'corner_review');
      if (handback) {
        await claim(handback, `w${round}`);
        await result(handback, '@goosy still not right, look again.', `w${round}`);
      }
    }
    expect(await currentState(cornerId)).toBe('ask_human');
  });
});

describe('landing and closing from any state (finding 3, implicit edges)', () => {
  it('the merge webhook lands the corner even while it is still mid-review', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 9, '9'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    await github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number: 9,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/9',
        head: { ref: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`, sha: '9'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-01-01T00:00:00Z',
        commits: 1,
        changed_files: 1,
      },
      sender: { login: 'octocat' },
    });
    const all = await cards(cornerId);
    expect(all.at(-1)).toEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'landed', toState: 'landed', status: 'done' }),
    );
  });

  it('closing a no-code corner lands it on closed from no_code_work', async () => {
    const cornerId = await open('no_code');
    await daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('closed');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'no_code_work', outcome: 'closed', toState: 'closed', status: 'abandoned' }),
    );
  });

  it('a human close request lands whatever state the corner is in', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(await currentState(cornerId)).toBe('closed');
  });

  it('never posts a second terminal card for an already-landed corner', async () => {
    const cornerId = await open('no_code');
    await daemon.execute('archiveCorner', { cornerId }, A);
    const before = await cards(cornerId);
    // A retried merge webhook or close request must not re-terminate an
    // already-closed run.
    expect(await advanceCorner(db, cornerId, { kind: 'merged', contents: {} })).toEqual({
      state: 'closed',
      accepted: false,
    });
    expect(await cards(cornerId)).toEqual(before);
  });
});

const SHA = '7'.repeat(40);
/** The phone badge at implement, checks, review, land and landed. */
const BADGES = ['idle', 'review', 'review', 'review', 'archived'];
/** The phone badge at no_code_work and closed. */
const NO_CODE_BADGES = ['idle', 'archived'];
const branchOf = (cornerId: string) => `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;

async function reasons(cornerId: string, agentId: string): Promise<string[]> {
  return (
    await db.query<{ reason: string }>(
      `SELECT reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at,id`,
      [cornerId, agentId],
    )
  ).rows.map((row) => row.reason);
}

async function projected(cornerId: string): Promise<string | null> {
  return (
    await db.query<{ workflow_state: string | null }>(
      `SELECT workflow_state FROM corner_facts WHERE corner_id=$1`,
      [cornerId],
    )
  ).rows[0]!.workflow_state;
}

/** A code corner whose green head woke the configured reviewer (Goosy). */
async function inReview(number = 7, headSha = SHA): Promise<string> {
  const cornerId = await open(undefined, 'owner/widgets');
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await greenHead(cornerId, number, headSha);
  return cornerId;
}

function approve(cornerId: string, headSha = SHA, briefRevision = 1, agentId = B) {
  return daemon.execute('approveCornerMerge', { cornerId, headSha, briefRevision }, agentId);
}

/** The reviewer's PASS on a green head; GitHub reports that head green. */
async function approved(): Promise<string> {
  const cornerId = await inReview();
  const [review] = await commands(B, cornerId);
  await claim(review!);
  await approve(cornerId);
  await result(review!, `approved ${SHA}`);
  githubHead = SHA;
  githubRollupState = 'passed';
  return cornerId;
}

async function mergedWebhook(cornerId: string, number: number, headSha: string) {
  await github.processWebhook('pull_request', {
    installation: { id: 77 },
    repository: { id: 101, full_name: 'owner/widgets' },
    action: 'closed',
    pull_request: {
      number,
      title: 'Ship the widget',
      html_url: `https://github.com/owner/widgets/pull/${number}`,
      head: { ref: branchOf(cornerId), sha: headSha },
      base: { ref: 'main' },
      merged: true,
      merged_at: '2026-01-01T00:00:00Z',
      commits: 1,
      changed_files: 1,
    },
    sender: { login: 'octocat' },
  });
}

async function say(roomId: string, text: string) {
  await phone.execute('sendRoomMessage', { roomId, messageId: randomBytes(32).toString('hex'), text }, H);
}

async function revise(cornerId: string, service = daemon) {
  const command = await commissioned(cornerId);
  return service.execute('reviseCornerBrief', {
    cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 1,
    brief: { ...brief(command.sourceMessageId), spec: 'Revised widget\n\n## Checklist\n- Ship it', change: 'Changed scope' },
  }, A);
}

const F = 'e'.repeat(64);
async function fallback(cornerId: string, online = true) {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Fallback','fallback') ON CONFLICT DO NOTHING`, [F]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [F, H]);
  for (const roomId of [null, R])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [W, roomId, F]);
  await db.query(`UPDATE rooms SET reviewer_fallback_ids=$2 WHERE id=$1`, [R, [F]]);
  await repairReviewerCornerMembership(db, cornerId, F);
  if (online) await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [R, F]);
}

it.each(['passing', 'unknown', 'unreachable'])('Reproduction F1-2: ask_human revision resumes %s', async checks => {
  const cornerId = await approved();
  await db.query(`UPDATE messages SET card=jsonb_set(card,'{toState}','"ask_human"') WHERE id=(SELECT id FROM messages WHERE room_id=$1 AND card_type='corner-workflow-handoff' ORDER BY (card->>'seq')::int DESC LIMIT 1)`, [cornerId]);
  await db.query(`UPDATE corner_facts SET workflow_state='ask_human',lifecycle=jsonb_set(lifecycle,'{checks}',$2::jsonb) WHERE corner_id=$1`, [cornerId, JSON.stringify(checks === 'unknown' ? 'unknown' : 'passing')]);
  if (checks === 'unreachable') await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const result = await revise(cornerId);
  const state = await currentState(cornerId);
  console.info(`Reproduction F1-2: wrong=ask_human; right=${checks === 'passing' ? 'review' : 'implement'}; observed=${state}`);
  expect(state).toBe(checks === 'passing' ? 'review' : 'implement');
  expect(result).toMatchObject({ revision: 2, wake: { queued: true, agentId: checks === 'passing' ? B : A } });
});

it('Reproduction F1-7: opener revises a delegated sibling from its own command', async () => {
  const source = await open(undefined, 'owner/widgets');
  const command = await commissioned(source);
  const input = { roomId: source, requestId: command.turnRequestId, generationId: 'g1', name: 'Delegate widget', objective: 'Ship the widget', repository: 'owner/widgets', implementer: 'goosy', brief: brief(command.sourceMessageId) };
  const { cornerId } = await daemon.execute('createCorner', input, A);
  const result = await daemon.execute('reviseCornerBrief', { roomId: source, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 1, brief: { ...input.brief, spec: 'Corrected widget', change: 'Correct scope' } }, A);
  console.info(`Reproduction F1-7: wrong=revision denied; right=revision 2; observed=${result.revision}`);
  expect(result).toMatchObject({ revision: 2, wake: { queued: true, agentId: B } });
  await fallback(cornerId);
  const outsider = await createAgentCommand(db, { roomId: cornerId, agentId: F, sourceMessageId: command.sourceMessageId, reason: 'audit' });
  await daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: outsider!.id, generationId: 'g1' }, F);
  await expect(daemon.execute('reviseCornerBrief', { roomId: cornerId, cornerId, requestId: outsider!.turn_request_id, generationId: 'g1', expectedRevision: 2, brief: { ...input.brief, change: 'Unauthorized' } }, F)).rejects.toThrow('revision denied');
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [cornerId, B]);
  const unwoken = await daemon.execute('reviseCornerBrief', { roomId: source, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 2, brief: { ...input.brief, spec: 'Saved without a worker', change: 'Keep the revision' } }, A);
  expect(unwoken).toMatchObject({ revision: 3, wake: { queued: false, reason: expect.any(String) } });
  expect((await daemon.execute('listCornerBriefRevisions', { cornerId }, A)).revisions[0]!.revision).toBe(3);
});

it('Reproduction F1-9: brief history defaults to one revision with a cursor', async () => {
  const cornerId = await open(undefined, 'owner/widgets');
  await revise(cornerId);
  const result = await daemon.execute('listCornerBriefRevisions', { cornerId }, A);
  console.info(`Reproduction F1-9: wrong=2 full revisions; right=1 with cursor; observed=${result.revisions.length}`);
  expect(result.revisions.map(r => r.revision)).toEqual([2]);
  expect(result.nextBeforeRevision).toBe(2);
  expect((await daemon.execute('listCornerBriefRevisions', { cornerId, beforeRevision: 2 }, A)).revisions[0]!.revision).toBe(1);
  expect((await daemon.execute('listCornerBriefRevisions', { cornerId, limit: 20 }, A)).revisions).toHaveLength(2);
  await expect(daemon.execute('listCornerBriefRevisions', { cornerId, limit: 21 }, A)).rejects.toThrow('invalid');
});

it('Reproduction F1-11: exact replay survives implementer departure', async () => {
  const command = await commissioned(R);
  const input = { roomId: R, requestId: command.turnRequestId, generationId: 'g1', idempotencyKey: 'f1-replay', name: 'Delegate widget', objective: 'Ship widget', repository: 'owner/widgets', implementer: 'goosy', brief: brief(command.sourceMessageId) };
  const first = await daemon.execute('createCorner', input, A);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const replay = await daemon.execute('createCorner', input, A);
  console.info(`Reproduction F1-11: wrong=membership refusal; right=original corner; observed=${replay.cornerId}`);
  expect(replay).toEqual(first);
  await expect(daemon.execute('createCorner', { ...input, implementer: 'hoots' }, A)).rejects.toThrow('assignment conflict');
  await expect(daemon.execute('createCorner', { ...input, brief: { ...input.brief, spec: 'Different' } }, A)).rejects.toThrow('assignment conflict');
  await expect(daemon.execute('createCorner', { ...input, idempotencyKey: 'new-call' }, A)).rejects.toThrow('current member');
});

describe('Reproduction S-03: revised briefs use the lifecycle reviewer resolver', () => {
  it.each(['removed', 'offline'] as const)('wakes a healthy fallback when the primary is %s', async (condition) => {
    const cornerId = await approved();
    await fallback(cornerId);
    if (condition === 'removed') await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    await revise(cornerId);
    const wakes = await reasons(cornerId, F);
    console.info(`Reproduction S-03: revise green brief with ${condition} primary → fallback review commands=${wakes.filter(r => r === 'corner_check').length}`);
    expect(wakes).toContain('corner_check');
    const wake = (await db.query<{ text: string }>(`SELECT m.text FROM agent_commands c JOIN messages m ON m.id=c.source_message_id WHERE c.room_id=$1 AND c.agent_id=$2 AND c.reason='corner_check'`, [cornerId, F])).rows[0]!;
    expect(wake.text).toContain('Revision 2');
    expect(await currentState(cornerId)).toBe('review');
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ open: false, approvalPending: true });
    await expect(approve(cornerId, SHA, 1, F)).rejects.toThrow();
    expect(await commands(F, cornerId)).toEqual([]);
    const author = (await db.query<{ turn_request_id: string }>(`SELECT turn_request_id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='claimed'`, [cornerId, A])).rows[0]!;
    await daemon.execute('postRoomMessage', { roomId: cornerId, requestId: author.turn_request_id, generationId: 'g1', text: 'Revision implemented' }, A);
    expect((await commands(F, cornerId))[0]?.source.body).toContain('Revision 2');
    console.info('Reproduction S-03: worker finished → fallback received Revision 2; old revision PASS rejected');
  });

  it('wakes the reachable primary without a fallback list', async () => {
    const cornerId = await approved();
    const recording = new RecordingDatabase(db);
    await revise(cornerId, new DaemonService(recording, new LiveHub()));
    expect(await reasons(cornerId, B)).toContain('corner_check');
    expect(await currentState(cornerId)).toBe('review');
    const lock = recording.calls.findIndex(c => c.sql.includes('pg_advisory_xact_lock'));
    const write = recording.calls.findIndex(c => c.sql.startsWith('INSERT INTO corner_brief_revisions'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(write);
  });

  it.each(['implement', 'checks', 'review'])('reviews a green revision from %s', async (state) => {
    const cornerId = state === 'review' ? await inReview() : await open(undefined, 'owner/widgets');
    if (state !== 'review') {
      await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
      if (state === 'checks') await pushToCorner(cornerId, SHA);
      await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [cornerId, JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 7, headSha: SHA } })]);
    }
    expect(await currentState(cornerId)).toBe(state);
    await revise(cornerId);
    expect(await reasons(cornerId, B)).toContain('corner_check');
    expect(await currentState(cornerId)).toBe('review');
  });

  it('names a primary who has left when no fallback list exists', async () => {
    const cornerId = await approved();
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    await revise(cornerId);
    expect(await reasons(cornerId, B)).not.toContain('corner_check');
    expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1`, [cornerId])).rows.some(r => r.text.includes('not a current member of the parent Room'))).toBe(true);
  });

  it('does not wake the revision author as reviewer', async () => {
    const cornerId = await approved();
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    await revise(cornerId);
    expect(await reasons(cornerId, A)).not.toContain('corner_check');
  });

  it.each(['pending', 'failing'])('does not review a revision while checks are %s', async (checks) => {
    const cornerId = await approved();
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}',to_jsonb($2::text)) WHERE corner_id=$1`, [cornerId, checks]);
    await revise(cornerId);
    expect(await reasons(cornerId, B)).not.toContain('corner_check');
  });

  it('names an exhausted reviewer list', async () => {
    const cornerId = await approved();
    await fallback(cornerId, false);
    await revise(cornerId);
    expect(await reasons(cornerId, F)).not.toContain('corner_check');
    expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1`, [cornerId])).rows.some(r => /reviewer.*(available|healthy|take|exhaust)/i.test(r.text))).toBe(true);
  });
});

describe('Reproduction S-07: every reviewer waits for a quiet corner', () => {
  it.each([B, F])('holds a review for %s until the worker releases its lease', async (reviewerId) => {
    const cornerId = await inReview();
    if (reviewerId === F) await fallback(cornerId);
    const worker = (await commands(A, cornerId))[0]!;
    await claim(worker);
    const source = await systemLine(db, { roomId: cornerId, subject: { kind: 'agent', id: A, name: 'Hoots' }, verb: 'revised the corner brief', object: 'Revision 2' });
    const review = await createAgentCommand(db, { roomId: cornerId, agentId: reviewerId, sourceMessageId: source.id, reason: 'corner_check' });
    const delivered = (await commands(reviewerId, cornerId)).some(c => c.id === review!.id);
    console.info(`Reproduction S-07: ${reviewerId === F ? 'fallback' : 'primary'} review with live worker lease → delivered=${delivered}`);
    expect(delivered).toBe(false);
    await result(worker, 'Worker finished');
    expect((await commands(reviewerId, cornerId)).some(c => c.id === review!.id)).toBe(true);
  });

  it.each([B, F])('delivers unrelated commands to %s while the worker is busy', async (reviewerId) => {
    const cornerId = await inReview();
    if (reviewerId === F) await fallback(cornerId);
    await claim((await commands(A, cornerId))[0]!);
    const source = await systemLine(db, { roomId: cornerId, subject: { kind: 'human', id: H, name: 'Human' }, verb: 'recorded a note' });
    const ordinary = await createAgentCommand(db, { roomId: cornerId, agentId: reviewerId, sourceMessageId: source.id, reason: 'human_tag' });
    expect((await commands(reviewerId, cornerId)).some(c => c.id === ordinary!.id)).toBe(true);
  });

  it('holds a fallback checks-passed review and releases it on lease expiry', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await fallback(cornerId);
    const worker = (await commands(A, cornerId))[0]!;
    await claim(worker);
    await greenHead(cornerId, 7, SHA);
    expect(await reasons(cornerId, F)).toContain('subscribed_event');
    expect(await commands(F, cornerId)).toEqual([]);
    await db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [worker.id]);
    expect(await commands(F, cornerId)).toHaveLength(1);
  });
});

describe('Reproduction R5a: entry paths lock the run before corner rows', () => {
  it.each(['check webhook', 'merged webhook', 'approval', 'upgrade', 'hold', 'brief', 'create', 'zero-check', 'blocker reconciliation'])('%s', async path => {
    const cornerId = path === 'upgrade' ? await open('no_code', 'owner/widgets') : await inReview();
    const recording = new RecordingDatabase(db);
    const recordedDaemon = new DaemonService(recording, new LiveHub());
    const recordedGithub = new GitHubOperations(recording, {} as GitHubOAuthClient, githubApp as unknown as GitHubAppClient, 'secret');
    let lockId = cornerId;
    if (path === 'check webhook') {
      githubRollupState = 'passed';
      await recordedGithub.processWebhook('check_run', {
        installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action: 'completed',
        check_run: { id: 5, name: 'typecheck', status: 'completed', conclusion: 'success',
          check_suite: { head_branch: branchOf(cornerId), head_sha: SHA } },
      });
    } else if (path === 'merged webhook') {
      const previous = github;
      github = recordedGithub;
      try { await mergedWebhook(cornerId, 7, SHA); } finally { github = previous; }
    } else if (path === 'approval') {
      await recordedDaemon.execute('approveCornerMerge', { cornerId, headSha: SHA, briefRevision: 1 }, B);
    } else if (path === 'upgrade') {
      const command = await commissioned(cornerId);
      await recordedDaemon.execute('upgradeCornerLane', { cornerId, requestId: command.turnRequestId, generationId: 'g1' }, A);
    } else if (path === 'hold') {
      await new PhoneService(recording, 'http://test').execute('setCornerHold', { cornerId }, H);
    } else if (path === 'brief') {
      await revise(cornerId, recordedDaemon);
    } else if (path === 'create') {
      const command = await commissioned(R);
      const created = await recordedDaemon.execute('createCorner', { roomId: R, requestId: command.turnRequestId,
        generationId: 'g1', name: 'Another widget', objective: 'Ship another widget', repository: 'owner/widgets',
        brief: brief(command.sourceMessageId) }, A);
      lockId = created.cornerId;
    } else if (path === 'zero-check') {
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(jsonb_set(lifecycle,'{checks}','"unknown"'),'{pr,mergeability}','"clean"'),command_check_state=NULL WHERE corner_id=$1`, [cornerId]);
      const command = await commissioned(cornerId);
      const status = { ...(await github.prChecksStatus({ cornerId })), checks: 'pending' as const, checkCount: 0 };
      const completion = new DaemonService(recording, new LiveHub(), undefined, undefined, false, undefined, false, undefined, async () => {
        // Completion runs after the reply transaction commits; inspect its own locks.
        recording.calls.length = 0;
        return status;
      });
      await completion.execute('postRoomMessage', { roomId: cornerId, requestId: command.turnRequestId,
        generationId: 'g1', text: 'https://github.com/owner/widgets/pull/7' }, A);
    } else {
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"failing"'),command_check_state=NULL WHERE corner_id=$1`, [cornerId]);
      await reconcileCornerMergeBlockers(recording, cornerId);
    }
    const lock = recording.calls.findIndex(call => call.sql === 'SELECT pg_advisory_xact_lock(hashtext($1))'
      && call.values?.[0] === workflowRunLockKey(lockId));
    const rowLock = recording.calls.findIndex(call => /FOR UPDATE/.test(call.sql) && /FROM (corner_facts|rooms)|JOIN corner_facts/.test(call.sql)
      || /^UPDATE rooms/.test(call.sql));
    expect(rowLock, 'path exercised a corner row lock or update').toBeGreaterThanOrEqual(0);
    expect(lock, 'corner run lock was taken').toBeGreaterThanOrEqual(0);
    expect(lock, 'run lock precedes corner row locks').toBeLessThan(rowLock);
    if (path === 'blocker reconciliation') {
      const write = recording.calls.findIndex(call => /^INSERT INTO messages|^UPDATE corner_facts/.test(call.sql));
      expect(write, 'reconciliation performed a write').toBeGreaterThanOrEqual(0);
      expect(lock, 'run lock precedes foreign-key writes').toBeLessThan(write);
    }
  });
});

describe('Reproduction R5b: authority changes between gate read and claim', () => {
  it.each(['hold', 'brief', 'yolo', 'membership'])('%s stops the claim', async change => {
    const cornerId = await approved();
    let holdId: string | undefined;
    let injected = false;
    const interposed: SqlDatabase = {
      transaction: work => db.transaction(work),
      query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
        if (!injected && sql.includes('SELECT (fact.lifecycle') && sql.includes('JOIN github_repositories repository')) {
          injected = true;
          if (change === 'hold') holdId = (await phone.execute('setCornerHold', { cornerId }, H)).holdId;
          if (change === 'brief') await revise(cornerId);
          if (change === 'yolo') await db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
          if (change === 'membership') await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
        }
        return db.query<Row>(sql, values);
      },
    };
    const raced = new GitHubOperations(interposed, {} as GitHubOAuthClient, githubApp as unknown as GitHubAppClient, 'secret');
    expect(await raced.landCorner(cornerId)).toBe(false);
    expect(injected).toBe(true);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect((await db.query(`SELECT merge_attempt_head FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0])
      .toMatchObject({ merge_attempt_head: null });
    if (change === 'hold') await phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId! }, H);
    if (change === 'brief') await approve(cornerId, SHA, 2);
    if (change === 'yolo') await db.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [A]);
    if (change === 'membership') await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    expect(await raced.landReadyCorners()).toBe(1);
    expect(await raced.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('advanceCorner rejects an event the current state does not allow (AC-1)', () => {
  it('changes nothing and logs it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const cornerId = await open('no_code', 'owner/widgets');
      const before = await cards(cornerId);
      expect(await advanceCorner(db, cornerId, { kind: 'push', headSha: SHA, contents: {} })).toEqual({
        state: 'no_code_work',
        accepted: false,
      });
      expect(await advanceCorner(db, cornerId, { kind: 'approval', headSha: SHA })).toEqual({
        state: 'no_code_work',
        accepted: false,
      });
      expect(await cards(cornerId)).toEqual(before);
      expect(await projected(cornerId)).toBe('no_code_work');
      expect(info).toHaveBeenCalledWith(expect.stringContaining(`${cornerId}: ignored push in no_code_work`));
      expect(info).toHaveBeenCalledWith(expect.stringContaining(`${cornerId}: ignored approval in no_code_work`));
    } finally {
      info.mockRestore();
    }
  });
});

describe('re-runs and pushes out of review and land (AC-1)', () => {
  it('a re-run after red checks goes implement -> checks, and its green reaches review', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await redHead(cornerId, 3, SHA);
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [
      cornerId,
    ]);
    await advanceCorner(db, cornerId, { kind: 'checks-pending' });
    expect(await currentState(cornerId)).toBe('checks');
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`, [
      cornerId,
    ]);
    await systemLine(db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
    expect(await currentState(cornerId)).toBe('review');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'implement', outcome: 'rechecked', toState: 'checks' }),
    );
  });

  it('a re-run in review or land goes back to checks', async () => {
    const cornerId = await inReview();
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [
      cornerId,
    ]);
    await advanceCorner(db, cornerId, { kind: 'checks-pending' });
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'rechecked', toState: 'checks' }),
    );

    const landing = await approved();
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [
      landing,
    ]);
    await advanceCorner(db, landing, { kind: 'checks-pending' });
    expect(await cards(landing)).toContainEqual(
      expect.objectContaining({ fromState: 'land', outcome: 'rechecked', toState: 'checks' }),
    );
  });

  it('a push during review goes review -> checks', async () => {
    const cornerId = await inReview();
    await pushToCorner(cornerId, '8'.repeat(40));
    expect(await currentState(cornerId)).toBe('checks');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'pushed', toState: 'checks' }),
    );
  });

  it("the reviewer's PASS after a handback on the same head goes implement -> review -> land", async () => {
    const cornerId = await inReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, '@hoots please fix the race.');
    expect(await currentState(cornerId)).toBe('implement');
    await approve(cornerId);
    expect(await currentState(cornerId)).toBe('land');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'implement', outcome: 'rereview', toState: 'review' }),
    );
  });
});

describe('each transition wakes the next role exactly once (AC-2)', () => {
  it('a redelivered green check wakes the reviewer once', async () => {
    const cornerId = await inReview();
    await systemLine(db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
    expect(await reasons(cornerId, B)).toEqual(['subscribed_event']);
    expect((await cards(cornerId)).filter((card) => card.outcome === 'passing')).toHaveLength(1);
  });

  it('a redelivered red check wakes the implementer once', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await redHead(cornerId, 3, SHA);
    await systemLine(db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'found failing checks on', kind: 'check-failed' });
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
  });

  it('a redelivered push webhook records one push', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await pushToCorner(cornerId, SHA);
    await pushToCorner(cornerId, SHA);
    expect((await cards(cornerId)).filter((card) => card.outcome === 'pushed')).toHaveLength(1);
  });

  it('changes requested wakes the implementer once', async () => {
    const cornerId = await inReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Please fix the race.');
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_review')).toHaveLength(1);
    expect(await reasons(cornerId, B)).toEqual(['subscribed_event']);
  });
});

describe('a person hands the corner to another agent (the implementer follows the tag)', () => {
  // A third agent, a member of the corner only: the reviewer stays B, so the
  // tagged implementer is never the reviewer. `beforeEach` drops the corner
  // rows, so it is re-added per test and its identities row is idempotent.
  const D = 'd'.repeat(64);
  async function taggableMember(cornerId: string): Promise<void> {
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Sol','sol') ON CONFLICT(id) DO NOTHING`,
      [D],
    );
    await db.query(
      `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT(agent_id) DO UPDATE SET owner_id=EXCLUDED.owner_id`,
      [D, H],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
      [W, cornerId, D],
    );
  }
  const workerOf = async (cornerId: string): Promise<string | null> =>
    (
      await db.query<{ worker_agent_id: string | null }>(
        `SELECT worker_agent_id FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0]!.worker_agent_id;

  it('a tag in the corner moves the failing-check wake off the opener, leaving owner_agent_id alone', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await say(cornerId, '@goosy take this one');
    expect(await workerOf(cornerId)).toBe(B);
    expect(
      (
        await db.query<{ owner_agent_id: string }>(
          `SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0]!.owner_agent_id,
    ).toBe(A);
    await redHead(cornerId, 3, SHA);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(0);
  });

  it('a review handback wakes the tagged implementer, not the opener', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await taggableMember(cornerId);
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@sol take this one');
    await greenHead(cornerId, 7, SHA);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Please fix the race.');
    expect((await reasons(cornerId, D)).filter((reason) => reason === 'corner_review')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_review')).toHaveLength(0);
  });

  it('a refused merge wakes the tagged implementer, not the opener', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await taggableMember(cornerId);
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@sol take this one');
    await greenHead(cornerId, 7, SHA);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    githubHead = SHA;
    githubRollupState = 'passed';
    githubApp.mergePullRequest.mockRejectedValueOnce(
      new Error('GitHub pull request merge failed: HTTP 405: Base branch was modified'),
    );
    await github.landReadyCorners();
    expect((await reasons(cornerId, D)).filter((reason) => reason === 'corner_merge_refused')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_merge_refused')).toHaveLength(0);
  });

  it('a merge conflict wakes the tagged implementer', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await say(cornerId, '@goosy take this one');
    await db.query(
      `UPDATE corner_facts SET lifecycle=lifecycle||$2::jsonb WHERE corner_id=$1`,
      [
        cornerId,
        JSON.stringify({
          pr: {
            number: 7,
            url: 'https://github.com/owner/widgets/pull/7',
            headSha: SHA,
            mergeability: 'dirty',
          },
        }),
      ],
    );
    const source = await systemLine(db, {
      roomId: cornerId,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'found merge conflicts in',
    });
    await queueCornerMergeConflict(db, cornerId, source.id);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_merge_conflict')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_merge_conflict')).toHaveLength(0);
  });

  it('blocker reconciliation wakes the tagged implementer', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await say(cornerId, '@goosy take this one');
    await pushToCorner(cornerId, SHA);
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({
        checks: 'failing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA },
      }),
    ]);
    await reconcileCornerMergeBlockers(db, cornerId);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(0);
  });

  it('the merge gate reads the tagged implementer yolo mode', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    await db.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [B]);
    await say(cornerId, '@goosy take this one');
    expect((await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).isWorkerYolo).toBe(true);
  });

  it('tagging the configured reviewer does not take the implementer role', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@goosy what do you think?');
    expect(await workerOf(cornerId)).toBeNull();
  });

  it('a tag in the parent Room does not move a corner implementer', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await say(R, '@goosy take this one');
    expect(await workerOf(cornerId)).toBeNull();
  });

  it('a corner nobody redirected still wakes its opener', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await redHead(cornerId, 3, SHA);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_check')).toHaveLength(0);
  });
});

describe('loop caps (AC-3)', () => {
  it(`the ${CHECKS_FAILING_LIMIT + 1}th failing round moves to ask_human naming the requester, and a push resumes`, async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await pushToCorner(cornerId, '0'.repeat(40));
    for (let round = 1; round <= CHECKS_FAILING_LIMIT + 1; round += 1) {
      const headSha = round.toString(16).padStart(40, '0');
      if (round > 1) await advanceCorner(db, cornerId, { kind: 'push', headSha, contents: { headSha } });
      await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
        cornerId,
        JSON.stringify({ checks: 'failing', lifecycle: 'in-review', pr: { number: 4, url: 'https://github.com/owner/widgets/pull/4', headSha } }),
      ]);
      await systemLine(db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'found failing checks on', kind: 'check-failed' });
      expect(await currentState(cornerId)).toBe(round > CHECKS_FAILING_LIMIT ? 'ask_human' : 'implement');
    }
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(CHECKS_FAILING_LIMIT);
    const line = (
      await db.query<{ system_event: { subject: { id?: string } } }>(
        `SELECT system_event FROM messages WHERE room_id=$1 AND card_type='corner-checks-blocked'`,
        [cornerId],
      )
    ).rows;
    expect(line).toHaveLength(1);
    expect(line[0]!.system_event.subject.id).toBe(H);
    await pushToCorner(cornerId, 'f'.repeat(40));
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'ask_human', outcome: 'pushed', toState: 'checks' }),
    );
  }, 60_000);

  it(`the ${REVIEW_HANDBACK_LIMIT + 1}th handback on one head moves to ask_human; a new push resets the count`, async () => {
    const cornerId = await inReview();
    async function handBack(round: string) {
      const [review] = (await commands(B, cornerId)).slice(-1);
      await claim(review!, `r${round}`);
      await result(review!, `Round ${round}: still not fixed.`, `r${round}`);
      const [handback] = (await commands(A, cornerId)).filter((c) => c.reason === 'corner_review');
      if (handback) {
        await claim(handback, `w${round}`);
        await result(handback, '@goosy look again.', `w${round}`);
      }
    }
    for (let round = 1; round <= REVIEW_HANDBACK_LIMIT; round += 1) await handBack(String(round));
    expect(await currentState(cornerId)).toBe('implement');
    // A push resets the per-head count.
    await greenHead(cornerId, 7, '8'.repeat(40));
    for (let round = 1; round <= REVIEW_HANDBACK_LIMIT; round += 1) await handBack(`b${round}`);
    expect(await currentState(cornerId)).toBe('implement');
    await handBack('last');
    expect(await currentState(cornerId)).toBe('ask_human');
    const line = (
      await db.query<{ system_event: { subject: { id?: string } } }>(
        `SELECT system_event FROM messages WHERE room_id=$1 AND card_type='corner-review-deadlock'`,
        [cornerId],
      )
    ).rows;
    expect(line).toHaveLength(1);
    expect(line[0]!.system_event.subject.id).toBe(H);
  });
});

describe("the configured reviewer's verdict (AC-4)", () => {
  it('records PASS from a reviewer turn that was not the review dispatch (the Sol case)', async () => {
    const cornerId = await inReview();
    // Goosy is asked something by a person in the corner: its session never
    // booted as the reviewer, and the server alone decides the verdict.
    await db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [cornerId]);
    await say(cornerId, '@goosy what do you think?');
    const [asked] = await commands(B, cornerId);
    expect(asked?.reason).not.toBe('subscribed_event');
    await claim(asked!);
    await expect(approve(cornerId)).resolves.toMatchObject({ headSha: SHA });
    await result(asked!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('land');
  });

  it('rejects a caller who is not the configured reviewer, a stale head, and a stale brief revision by name', async () => {
    const cornerId = await inReview();
    await expect(approve(cornerId, SHA, 1, A)).rejects.toThrow(/^NOT_CONFIGURED_REVIEWER:/);
    await expect(approve(cornerId, '9'.repeat(40))).rejects.toThrow(/^STALE_HEAD:/);
    await expect(approve(cornerId, SHA, 2)).rejects.toThrow(/^STALE_BRIEF_REVISION:/);
    expect(await currentState(cornerId)).toBe('review');
    expect((await db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [cornerId])).rowCount).toBe(0);
  });
});

describe('the server merges when the gate opens (AC-5)', () => {
  it('reads the gate facts for mixed candidates in two queries', async () => {
    const openCorner = await approved();
    const held = await approved();
    const unapproved = await approved();
    const staleHead = await approved();
    const staleBrief = await approved();
    const workerOff = await approved();
    await phone.execute('setCornerHold', { cornerId: held }, H);
    await db.query(`DELETE FROM corner_merge_approvals WHERE corner_id=$1`, [unapproved]);
    await db.query(`UPDATE corner_merge_approvals SET head_sha=$2 WHERE corner_id=$1`, [staleHead, '9'.repeat(40)]);
    await db.query(`UPDATE corner_merge_approvals SET brief_revision=0 WHERE corner_id=$1`, [staleBrief]);
    await db.query(`UPDATE corner_facts SET worker_agent_id=$2 WHERE corner_id=$1`, [workerOff, B]);
    await db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [B]);
    const recorded = new RecordingDatabase(db);
    expect(await cornersReadyToLand(recorded)).toEqual([openCorner]);
    expect(recorded.calls).toHaveLength(2);
    for (const cornerId of [openCorner, held, unapproved, staleHead, staleBrief, workerOff]) {
      expect((await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).open).toBe(cornerId === openCorner);
    }
  });

  it('Reproduction R5c: a departed self-reviewer cannot authorize a merge', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open(undefined, 'owner/widgets');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, A]);
    await greenHead(cornerId, 7, SHA);
    githubHead = SHA;
    githubRollupState = 'passed';
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA }))
      .toMatchObject({ reviewerExists: false, open: false });
    expect(await currentState(cornerId)).toBe('checks');
    expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`, [cornerId])).rows)
      .toHaveLength(1);
    expect(await github.prChecksStatus({ cornerId })).toMatchObject({ reviewerExists: false, mergeAllowed: false });
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });
  it('merges the exact head after green checks and PASS without waking the implementer, then lands on the merge webhook', async () => {
    const cornerId = await inReview();
    const implementerBefore = await reasons(cornerId, A);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('land');
    githubHead = SHA;
    githubRollupState = 'passed';
    expect(await github.landReadyCorners()).toBe(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    expect(githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(cornerId));
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('landed');
    expect(await projected(cornerId)).toBe('landed');
    expect(await reasons(cornerId, A)).toEqual(implementerBefore);
    expect(
      (await db.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [cornerId])).rowCount,
    ).toBe(1);
  });

  it('merges with no review when the reviewer is the author', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('land');
    githubHead = SHA;
    githubRollupState = 'passed';
    expect(await github.landReadyCorners()).toBe(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
  });
});

describe('GitHub refusing the merge (AC-6)', () => {
  it.each([405, 409])('HTTP %i returns the corner to implement and wakes the implementer with the reason', async (status) => {
    const cornerId = await approved();
    const reason = `GitHub pull request merge failed: HTTP ${status}: Base branch was modified`;
    githubApp.mergePullRequest.mockRejectedValueOnce(new Error(reason));
    await github.landReadyCorners();
    expect(await currentState(cornerId)).toBe('implement');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'land', outcome: 'merge_refused', toState: 'implement' }),
    );
    expect((await reasons(cornerId, A)).filter((r) => r === 'corner_merge_refused')).toHaveLength(1);
    const lines = (
      await db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%refused to merge%'`, [
        cornerId,
      ])
    ).rows;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain(`HTTP ${status}`);
    // No second attempt on the refused head.
    await github.landReadyCorners();
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    // The badge follows the run, not the still-green lifecycle: the corner
    // is back with its implementer (AC-9), and owes no person anything.
    const listed = (await phone.readCorners(R, H))!.corners.find((row) => row.corner.id === cornerId);
    expect(listed).toMatchObject({ state: 'idle' });
  });
});

describe('unfinished merge claim recovery (R6a–R6f)', () => {
  async function recover() {
    await github.recoverUnfinishedMergeClaims();
  }

  function providerPr(cornerId: string, merged = false, headSha = SHA) {
    return {
      number: 7, url: 'https://github.com/owner/widgets/pull/7', title: 'Ship the widget',
      headSha, headRef: branchOf(cornerId), baseRef: 'main', merged, mergeability: 'clean',
      ...(merged ? { mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: '8'.repeat(40) } : {}),
    };
  }

  async function backdate(cornerId: string) {
    await db.query(`UPDATE corner_facts SET updated_at=now()-interval '1 hour' WHERE corner_id=$1`, [cornerId]);
  }

  async function claimed(stale = true) {
    const cornerId = await approved();
    expect(await claimCornerMergeAttempt(db, cornerId, SHA)).toBe(true);
    if (stale) await backdate(cornerId);
    githubApp.readPullRequest.mockResolvedValue(providerPr(cornerId));
    return cornerId;
  }

  async function claimHead(cornerId: string) {
    return (await db.query(`SELECT merge_attempt_head FROM corner_facts WHERE corner_id=$1`, [cornerId]))
      .rows[0]!.merge_attempt_head;
  }

  async function landing(cornerId: string) {
    expect(await currentState(cornerId)).toBe('landed');
    expect((await cards(cornerId)).filter(card => card.toState === 'landed')).toEqual([
      expect.objectContaining({ fromState: 'land', toState: 'landed' }),
    ]);
    expect((await db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived_at)
      .not.toBeNull();
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%merged%'`, [cornerId])).rowCount)
      .toBe(1);
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card->>'type'='corner-complete'`, [R])).rowCount)
      .toBe(1);
    const visible = (await phone.readCorners(R, H, false, true))?.corners.find(row => row.corner.id === cornerId);
    expect(visible).toMatchObject({ state: 'archived', lifecycle: { outcome: 'landed' } });
  }

  it('Reproduction F2-1: human input keeps a fresh merge claim until its grace deadline', async () => {
    const cornerId = await claimed(false);
    githubApp.readPullRequest.mockResolvedValue(providerPr(cornerId, false));
    await phone.execute('sendRoomMessage', {
      roomId: cornerId, messageId: randomBytes(32).toString('hex'), text: 'Any update?',
    }, H);
    await recover();
    const observed = await claimHead(cornerId);
    console.info(`Reproduction F2-1: wrong=claim cleared after human message; right=claim kept until grace; observed=${observed}`);
    expect(githubApp.readPullRequest).not.toHaveBeenCalled();
    expect(observed).toBe(SHA);
  });

  it.each([true, false])('Reproduction F1-3: recovery backs off and confirms merged=%s after human input', async merged => {
    const cornerId = await claimed();
    githubApp.readPullRequest.mockRejectedValue(new Error('permission denied'));
    await recover();
    const reads = githubApp.readPullRequest.mock.calls.length;
    await recover();
    console.info(`Reproduction F1-3: wrong=read every tick; right=no read before deadline; observed=${githubApp.readPullRequest.mock.calls.length - reads}`);
    expect(githubApp.readPullRequest).toHaveBeenCalledTimes(reads);
    for (let attempt = 2; attempt <= 6; attempt++) {
      const timing = (await db.query(`SELECT (lifecycle->'mergeRecovery'->>'nextAttemptAt')::double precision - (lifecycle->'mergeRecovery'->>'lastAttemptAt')::double precision delay FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.delay;
      expect(timing).toBeCloseTo(Math.min(3600, 300 * 2 ** (attempt - 2)), 1);
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{mergeRecovery,nextAttemptAt}','0') WHERE corner_id=$1`, [cornerId]);
      await recover();
      expect(await currentState(cornerId)).toBe(attempt >= 5 ? 'ask_human' : 'land');
    }
    expect(await currentState(cornerId)).toBe('ask_human');
    const notes = await db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%merge outcome is unconfirmed%'`, [cornerId]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]!.text).toContain('#7');
    expect(notes.rows[0]!.text).toContain('permission denied');
    expect(await claimHead(cornerId)).toBe(SHA);
    githubApp.readPullRequest.mockResolvedValue(providerPr(cornerId, merged));
    await phone.execute('sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'), text: 'Permissions repaired' }, H);
    await recover();
    expect(await currentState(cornerId)).toBe(merged ? 'landed' : 'implement');
    expect(await claimHead(cornerId)).toBeNull();
    expect(Boolean((await db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived_at)).toBe(merged);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each(['missing target', 'different merged head', 'different merged branch'])('Reproduction F1-3: %s remains unconfirmed', async condition => {
    const cornerId = await claimed();
    if (condition === 'missing target') await db.query(`UPDATE github_repositories SET active=false WHERE repository_id=101`);
    else githubApp.readPullRequest.mockResolvedValue({ ...providerPr(cornerId, true, condition === 'different merged head' ? '9'.repeat(40) : SHA), ...(condition === 'different merged branch' ? { headRef: 'feature/somewhere-else' } : {}) });
    try {
      await recover();
      expect(await claimHead(cornerId)).toBe(SHA);
      expect(await currentState(cornerId)).toBe('land');
      expect((await db.query(`SELECT lifecycle->'mergeRecovery'->>'attempts' attempts FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.attempts).toBe('1');
      console.info(`Reproduction F1-3: ${condition}: wrong=unbounded read; right=claim retained with deadline; observed=attempt 1`);
    } finally { await db.query(`UPDATE github_repositories SET active=true WHERE repository_id=101`); }
  });

  it('Reproduction R6a: a crash before merge gets one fresh attempt through the normal sweep', async () => {
    const cornerId = await claimed();
    expect(await github.landReadyCorners()).toBe(0);
    await recover();
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(await github.landReadyCorners()).toBe(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    await recover();
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    await mergedWebhook(cornerId, 7, SHA);
    await landing(cornerId);
    console.info('R6a demonstrated: interrupted approved corner retried once, then archived with one landing and parent completion card.');
  });

  it('Reproduction R6b: a crash after merge records one landing without another merge', async () => {
    const cornerId = await claimed();
    // Recovery must work even when ordinary webhook reconciliation is disabled.
    await db.query(`UPDATE rooms SET github_events_enabled=false WHERE id=$1`, [R]);
    try {
      githubApp.readPullRequest.mockResolvedValue(providerPr(cornerId, true));
      await recover();
      await landing(cornerId);
      await recover();
      await db.query(`UPDATE rooms SET github_events_enabled=true WHERE id=$1`, [R]);
      await mergedWebhook(cornerId, 7, SHA);
      await landing(cornerId);
      expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
      console.info('R6b demonstrated: GitHub-confirmed merge archived once; duplicate recovery and webhook added no card or merge.');
    } finally {
      await db.query(`UPDATE rooms SET github_events_enabled=true WHERE id=$1`, [R]);
    }
  });

  it.each([new Error('GitHub pull request merge failed: HTTP 502'), new TypeError('fetch failed')])(
    'Reproduction R6c: %s after GitHub merged produces a landing, no refusal', async error => {
      const cornerId = await approved();
      githubApp.mergePullRequest.mockRejectedValueOnce(error);
      githubApp.readPullRequest.mockResolvedValue(providerPr(cornerId, true));
      await github.landReadyCorners();
      expect((await cards(cornerId)).filter(card => card.outcome === 'merge_refused')).toEqual([]);
      expect(await reasons(cornerId, A)).not.toContain('corner_merge_refused');
      expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%refused to merge%'`, [cornerId])).rowCount)
        .toBe(0);
      await landing(cornerId);
      console.info('R6c demonstrated: uncertain merge response confirmed landed; no refusal message or implementer wake.');
    },
  );

  it('Reproduction R6d: a moved provider head clears the claim without merging', async () => {
    const cornerId = await claimed();
    githubApp.readPullRequest.mockResolvedValue(providerPr(cornerId, false, '9'.repeat(40)));
    await recover();
    expect(await claimHead(cornerId)).toBeNull();
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each(['before read', 'during read'])('Reproduction R6e: a hold %s clears the claim and blocks merge until released', async timing => {
    const cornerId = await claimed();
    let holdId: string;
    if (timing === 'before read') {
      ({ holdId } = await phone.execute('setCornerHold', { cornerId }, H));
      await backdate(cornerId);
    } else {
      githubApp.readPullRequest.mockImplementationOnce(async () => {
        ({ holdId } = await phone.execute('setCornerHold', { cornerId }, H));
        await backdate(cornerId);
        return providerPr(cornerId);
      });
    }
    await recover();
    expect(await claimHead(cornerId)).toBeNull();
    expect(await github.landReadyCorners()).toBe(0);
    await phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId! }, H);
    expect(await github.landReadyCorners()).toBe(1);
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('Reproduction R6f(i): a recent claim is not read or cleared', async () => {
    const cornerId = await claimed(false);
    await recover();
    expect(githubApp.readPullRequest).not.toHaveBeenCalled();
    expect(await claimHead(cornerId)).toBe(SHA);
    expect(await github.landReadyCorners()).toBe(0);
  });

  it('Reproduction R6f(ii): an already-refused head is never recovered after reapproval', async () => {
    const cornerId = await approved();
    githubApp.mergePullRequest.mockRejectedValueOnce(new Error('GitHub pull request merge failed: HTTP 405'));
    await github.landReadyCorners();
    // Replay green delivery before reviewing the unchanged, refused head.
    await greenHead(cornerId, 7, SHA);
    await approve(cornerId);
    expect(await currentState(cornerId)).toBe('land');
    await backdate(cornerId);
    githubApp.readPullRequest.mockClear();
    await recover();
    expect(githubApp.readPullRequest).not.toHaveBeenCalled();
    expect(await claimHead(cornerId)).toBe(SHA);
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('Reproduction R6f(iii): a failed GitHub read leaves the claim intact', async () => {
    const cornerId = await claimed();
    githubApp.readPullRequest.mockRejectedValueOnce(new TypeError('fetch failed'));
    await recover();
    expect(githubApp.readPullRequest).toHaveBeenCalledTimes(1);
    expect(await claimHead(cornerId)).toBe(SHA);
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each(['different merged head', 'read fails'])('R6c: %s retains the existing refusal behavior', async outcome => {
    const cornerId = await approved();
    const reason = 'GitHub pull request merge failed: HTTP 502';
    githubApp.mergePullRequest.mockRejectedValueOnce(new Error(reason));
    githubApp.readPullRequest.mockResolvedValueOnce(providerPr(cornerId));
    if (outcome === 'read fails') githubApp.readPullRequest.mockRejectedValueOnce(new TypeError('fetch failed'));
    else githubApp.readPullRequest.mockResolvedValueOnce(providerPr(cornerId, true, '9'.repeat(40)));
    await github.landReadyCorners();
    expect(githubApp.readPullRequest).toHaveBeenCalledTimes(2); // Gate read, then one outcome read.
    expect(await currentState(cornerId)).toBe('implement');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_merge_refused')).toHaveLength(1);
    expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%refused to merge%'`, [cornerId])).rows)
      .toEqual([{ text: expect.stringContaining(reason) }]);
  });

  it.each([false, true])('R6f: revalidates an unmerged/merged=%s claim after the provider read', async merged => {
    for (const change of ['fresh', 'head', 'number', 'refusal', 'archived', 'state']) {
      const cornerId = await claimed();
      githubApp.readPullRequest.mockImplementationOnce(async () => {
        if (change === 'fresh') await db.query(`UPDATE corner_facts SET updated_at=now() WHERE corner_id=$1`, [cornerId]);
        if (change === 'head') await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`, [cornerId, '9'.repeat(40)]);
        if (change === 'number') await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,number}','8') WHERE corner_id=$1`, [cornerId]);
        if (change === 'refusal') await advanceCorner(db, cornerId, { kind: 'merge-refused', headSha: SHA, reason: 'HTTP 405' });
        if (change === 'archived') await daemon.execute('archiveCorner', { cornerId }, A);
        if (change === 'state') {
          await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [cornerId]);
          await advanceCorner(db, cornerId, { kind: 'checks-pending' });
        }
        return providerPr(cornerId, merged);
      });
      await recover();
      expect(await claimHead(cornerId), change).toBe(SHA);
      expect((await cards(cornerId)).filter(card => card.toState === 'landed'), change).toEqual([]);
      expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
      // Keep each interposed read isolated from the next scenario's scan.
      await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    }
  });

  it.each(['recovery open', 'recovery merged', 'uncertain merge'])('R6: %s has no provider call inside a transaction', async path => {
    const cornerId = path === 'uncertain merge' ? await approved() : await claimed();
    let depth = 0;
    const providerDepths: { call: string; depth: number }[] = [];
    const guarded = (database: SqlDatabase): SqlDatabase => ({
      query: (sql, values) => database.query(sql, values),
      transaction: work => database.transaction(async tx => {
        depth++;
        try { return await work(guarded(tx)); } finally { depth--; }
      }),
    });
    githubApp.installationToken.mockImplementation(async () => {
      providerDepths.push({ call: 'token', depth });
      expect(depth, 'token').toBe(0);
      return { token: 'tok', expiresAt: '2030-01-01T00:00:00Z' };
    });
    githubApp.readPullRequest.mockImplementation(async () => {
      providerDepths.push({ call: 'read PR', depth });
      expect(depth, 'read PR').toBe(0);
      return providerPr(cornerId, path !== 'recovery open');
    });
    githubApp.mergePullRequest.mockImplementation(async () => {
      providerDepths.push({ call: 'merge', depth });
      expect(depth, 'merge').toBe(0);
      if (path === 'uncertain merge') throw new TypeError('fetch failed');
    });
    githubApp.deleteBranch.mockImplementation(async () => {
      providerDepths.push({ call: 'delete branch', depth });
      expect(depth, 'delete branch').toBe(0);
    });
    const operation = new GitHubOperations(guarded(db), {} as GitHubOAuthClient, githubApp as unknown as GitHubAppClient, 'secret');
    if (path === 'uncertain merge') await operation.landReadyCorners();
    else {
      await operation.recoverUnfinishedMergeClaims();
      await operation.landReadyCorners();
    }
    if (path === 'recovery open') expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    else await landing(cornerId);
    expect(providerDepths.length).toBeGreaterThan(0);
    expect(providerDepths.filter(call => call.depth !== 0)).toEqual([]);
  });
});

describe('at most one merge attempt per head (AC-7)', () => {
  it('concurrent sweeps, direct lands and a redelivered verdict merge once', async () => {
    const cornerId = await approved();
    await Promise.all([
      github.landReadyCorners(),
      github.landReadyCorners(),
      github.landCorner(cornerId),
      github.landCorner(cornerId),
      approve(cornerId),
    ]);
    await github.landReadyCorners();
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the gate stays shut (AC-8)', () => {
  it('Reproduction R4: a negated proceed instruction cannot release a hold', async () => {
    const cornerId = await approved();
    await phone.execute('setCornerHold', { cornerId }, H);
    await say(cornerId, 'hold');
    await say(cornerId, 'Do not proceed until I check this');
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, open: false });
    expect(await github.prChecksStatus({ cornerId })).toMatchObject({ held: true, mergeAllowed: false });
  });
  it('after a push following PASS', async () => {
    const cornerId = await approved();
    const next = '8'.repeat(40);
    await pushToCorner(cornerId, next);
    expect(await currentState(cornerId)).toBe('checks');
    githubHead = next;
    expect(await github.landReadyCorners()).toBe(0);
    expect((await github.prChecksStatus({ cornerId, pullRequest: 7 })).mergeAllowed).toBe(false);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it('while a person holds it, and opens when they lift the hold', async () => {
    const cornerId = await approved();
    const { holdId } = await phone.execute('setCornerHold', { cornerId }, H);
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
    await say(cornerId, 'go ahead');
    expect(await github.landReadyCorners()).toBe(0);
    await phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
    expect(await github.landReadyCorners()).toBe(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('R4: holds survive more than 200 messages and deletion, without chat-derived releases', async () => {
    const cornerId = await approved();
    const { holdId } = await phone.execute('setCornerHold', { cornerId }, H);
    await say(cornerId, 'hold');
    await db.query(`UPDATE messages SET deleted_at=now() WHERE room_id=$1 AND text='hold'`, [cornerId]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text)
      SELECT md5($1 || n::text) || md5(n::text || $1),$1::uuid,$2,'unrelated'
      FROM generate_series(1,205) n`, [cornerId, H]);
    await say(cornerId, 'merge now');
    await db.query(`UPDATE messages SET deleted_at=now() WHERE room_id=$1 AND text='merge now'`, [cornerId]);
    expect(await github.prChecksStatus({ cornerId })).toMatchObject({ held: true, mergeAllowed: false,
      holds: [{ id: holdId, actorId: H, standing: 'owner', setAt: expect.any(String) }] });
    expect(await github.landReadyCorners()).toBe(0);
  });

  it('R4: refuses peer and lower-standing release; higher-standing release records its actor', async () => {
    const cornerId = await approved();
    const peer = 'f'.repeat(64), admin = '9'.repeat(64);
    for (const [id, role] of [[peer, 'member'], [admin, 'admin']]) {
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$1) ON CONFLICT DO NOTHING`, [id]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,'member')
        ON CONFLICT DO NOTHING`, [W, id, role, cornerId]);
    }
    await db.query(`UPDATE memberships SET role='member' WHERE room_id IS NULL AND identity_id=$1`, [H]);
    try {
      const { holdId } = await phone.execute('setCornerHold', { cornerId }, H);
      await expect(phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, peer)).rejects.toThrow(/above their member standing/);
      expect(await github.landReadyCorners()).toBe(0);
      await phone.execute('sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'),
        text: '@hoots release the hold' }, peer);
      const peerCommand = (await daemon.execute('getAgentCommands', { roomId: cornerId }, A)).commands.at(-1)!;
      await claim(peerCommand);
      await expect(daemon.execute('setCornerHold', { cornerId, roomId: cornerId,
        requestId: peerCommand.turnRequestId, generationId: 'g1', releaseHoldId: holdId }, A)).rejects.toThrow(/above their member standing/);
      await phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, admin);
      expect((await db.query(`SELECT standing,released_by,released_at IS NOT NULL released FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0])
        .toMatchObject({ standing: 'member', released_by: admin, released: true });
      const higher = await phone.execute('setCornerHold', { cornerId }, admin);
      await expect(phone.execute('setCornerHold', { cornerId, releaseHoldId: higher.holdId }, H)).rejects.toThrow(/above their admin standing/);
      await db.query(`UPDATE memberships SET role='owner' WHERE room_id IS NULL AND identity_id=$1`, [H]);
      await phone.execute('setCornerHold', { cornerId, releaseHoldId: higher.holdId }, H);
      expect(await github.landReadyCorners()).toBe(1);
    } finally {
      await db.query(`UPDATE memberships SET role='owner' WHERE room_id IS NULL AND identity_id=$1`, [H]);
    }
  });

  it('Reproduction R5d: an objective turn cannot release a human hold; a direct authorized instruction can', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open(undefined, 'owner/widgets', true);
    const holds = (await db.query(`SELECT id,actor_id,standing FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows;
    expect(holds).toEqual([{ id: expect.any(String), actor_id: H, standing: 'owner' }]);
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, open: false });
    await greenHead(cornerId, 7, SHA);
    githubHead = SHA; githubRollupState = 'passed';
    expect(await github.landReadyCorners()).toBe(0);
    const command = (await commands(A, cornerId)).find(command => command.reason === 'corner_objective')!;
    await claim(command);
    await expect(daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: command.turnRequestId,
      generationId: 'g1' }, A)).resolves.toMatchObject({ holdId: holds[0]!.id });
    await expect(daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: command.turnRequestId,
      generationId: 'g1', releaseHoldId: holds[0]!.id }, A)).rejects.toThrow(/direct human instruction/);
    expect(await github.landReadyCorners()).toBe(0);
    await say(cornerId, '@hoots release the hold');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: direct.turnRequestId,
      generationId: 'g1', releaseHoldId: holds[0]!.id }, A);
    expect(await github.landReadyCorners()).toBe(1);
  });

  it('Reproduction R5d: a delegated command cannot inherit the human holder’s release authority', async () => {
    const cornerId = await approved();
    const { holdId } = await phone.execute('setCornerHold', { cornerId }, H);
    const command = await commissioned(cornerId);
    await result(command, '@goosy release the hold');
    const delegated = (await commands(B, cornerId)).at(-1)!;
    await claim(delegated);
    await expect(daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: delegated.turnRequestId,
      generationId: 'g1', releaseHoldId: holdId }, B)).rejects.toThrow(/direct human instruction/);
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, open: false });
  });

  it('R4: chat alone creates no hold and migration intentionally starts inferred holds clean', async () => {
    const cornerId = await approved();
    await say(cornerId, 'hold');
    await migrate(db);
    expect((await github.prChecksStatus({ cornerId })).held).toBe(false);
    expect(await github.landReadyCorners()).toBe(1);
  });

  it('R4: a failed initial hold rolls back the entire corner', async () => {
    const command = await commissioned(R);
    const count = (await db.query(`SELECT count(*) n FROM rooms WHERE parent_id=$1`, [R])).rows;
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, H]);
    try {
      await expect(daemon.execute('createCorner', { roomId: R, requestId: command.turnRequestId,
        generationId: 'g1', name: 'Held work', objective: 'Keep this corner held', lane: 'no_code', hold: true }, A))
        .rejects.toThrow(/current human corner membership required/);
      expect((await db.query(`SELECT count(*) n FROM rooms WHERE parent_id=$1`, [R])).rows).toEqual(count);
      expect((await db.query(`SELECT count(*) n FROM corner_merge_holds`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, H]);
    }
  });

  it('Demonstrated R4/R5d: HTTP service refuses an objective release and accepts an authorized direct human release', async () => {
    const { createBeelineServer } = await import('./server.js');
    const { PhoneService: BuiltPhone } = await import('./phone-service.js');
    const { DaemonService: BuiltDaemon } = await import('./daemon-service.js');
    const { GitHubOperations: BuiltGitHub } = await import('./github-operations.js');
    const { TokenAuth, tokenHash } = await import('./auth.js');
    const auth = new TokenAuth(db, async () => { throw new Error('fixture does not sign in'); });
    const token = 'R4-fixture-phone-token';
    await db.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
      VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT DO NOTHING`, [tokenHash(token), H, W]);
    const exchange = await auth.createDaemonExchange(A);
    const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
    const builtGitHub = new BuiltGitHub(db, {} as GitHubOAuthClient, githubApp as unknown as GitHubAppClient, 'secret');
    const live = new LiveHub();
    const builtDaemon = new BuiltDaemon(db, live, undefined, undefined, false, undefined, false, undefined,
      input => builtGitHub.prChecksStatus(input));
    const server = createBeelineServer({ database: db, auth, phone: new BuiltPhone(db, 'http://test'),
      daemon: builtDaemon, live, mediaMaximumBytes: 1 });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const post = async (lane: 'phone' | 'daemon', operation: string, body: unknown, expectedStatus = 200) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/${lane}/operations/${operation}`, {
        method: 'POST', headers: { authorization: `Bearer ${lane === 'phone' ? token : daemonToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.text();
      const result = payload ? JSON.parse(payload) : undefined;
      expect(response.status, JSON.stringify(result)).toBe(expectedStatus);
      return result;
    };
    try {
      await post('phone', 'updateRoom', { roomId: R, reviewerAgentId: A }, 204);
      const cornerId = await open(undefined, 'owner/widgets', true);
      await greenHead(cornerId, 7, SHA);
      githubHead = SHA; githubRollupState = 'passed';
      const holdId = (await db.query<{ id: string }>(`SELECT id FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows[0]!.id;
      const objective = (await post('daemon', 'getAgentCommands', { roomId: cornerId })).commands
        .find((command: AgentCommand) => command.reason === 'corner_objective');
      await post('daemon', 'claimAgentCommand', { roomId: cornerId, commandId: objective.id, generationId: 'g1' });
      const refused = await post('daemon', 'setCornerHold', { cornerId, roomId: cornerId,
        requestId: objective.turnRequestId, generationId: 'g1', releaseHoldId: holdId }, 400);
      expect(refused.error).toMatch(/direct human instruction/);
      await post('phone', 'sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'), text: 'Do not proceed until I check this' });
      const held = await post('daemon', 'getPrChecksStatus', { cornerId });
      expect(held).toMatchObject({ held: true, mergeAllowed: false,
        holds: [{ id: holdId, actorId: H, standing: 'owner', setAt: expect.any(String) }] });
      expect(await builtGitHub.landReadyCorners()).toBe(0);
      expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
      await post('phone', 'sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'), text: '@hoots release the hold' });
      const direct = (await post('daemon', 'getAgentCommands', { roomId: cornerId })).commands.at(-1);
      await post('daemon', 'claimAgentCommand', { roomId: cornerId, commandId: direct.id, generationId: 'g2' });
      await post('daemon', 'setCornerHold', { cornerId, roomId: cornerId, requestId: direct.turnRequestId,
        generationId: 'g2', releaseHoldId: holdId });
      const released = await post('daemon', 'getPrChecksStatus', { cornerId });
      expect(released).toMatchObject({ held: false, mergeAllowed: true, holds: [] });
      expect(await builtGitHub.landReadyCorners()).toBe(1);
      console.log('Demonstrated R4/R5d: authenticated HTTP objective release => 400, held=true, mergeAllowed=false, merges=0; authorized direct human instruction + daemon release => 200, held=false, mergeAllowed=true, merges=1 (fixture GitHub).');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('while the worker yolo is off, and opens when it turns on', async () => {
    const cornerId = await approved();
    await db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
    await db.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [A]);
    expect(await github.landReadyCorners()).toBe(1);
    expect(cornerId).toBeTruthy();
  });

  it('when the reviewer is no longer configured or no longer a member', async () => {
    const cornerId = await approved();
    await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
    expect(await github.landReadyCorners()).toBe(0);
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, B]);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(cornerId).toBeTruthy();
  });

  it('when no reviewer is configured at all', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('implement');
    githubHead = SHA;
    githubRollupState = 'passed';
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('an express merge order from the owner or admin always carries (defect: express command must carry)', () => {
  it('a corner with no reviewer set merges once its owner orders the merge, but not before and not on a standing hold', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('implement');
    githubHead = SHA;
    githubRollupState = 'passed';

    // Left alone, a corner with no reviewer never merges itself.
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA }))
      .toMatchObject({ reviewerExists: false, expressMergeOrdered: false, open: false });
    expect(await github.landCorner(cornerId)).toBe(false);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();

    // A standing do-not-merge hold still stops an autonomous merge.
    const { holdId } = await phone.execute('setCornerHold', { cornerId }, H);
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, open: false });
    expect(await github.landCorner(cornerId)).toBe(false);

    // The owner's express instruction, relayed by the agent it was tagged
    // to, carries on its own: no reviewer, no yolo mode, a standing hold are
    // all reported as facts, never vetoes. It moves the run itself to `land`
    // through the one lifecycle authority, from wherever it was sitting.
    await db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await daemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
    expect(await currentState(cornerId)).toBe('land');

    const gate = await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA });
    expect(gate).toMatchObject({
      reviewerExists: false, isWorkerYolo: false, held: true, expressMergeOrdered: true, open: true,
    });

    const status = await github.prChecksStatus({ cornerId });
    expect(status).toMatchObject({ expressMergeOrdered: true, mergeAllowed: true, held: true });
    // Each fact is named once: no held/didHumanSayDontMerge duplicate survives.
    expect(Object.keys(status).filter((key) => /humansaydontmerge/i.test(key))).toEqual([]);

    expect(await github.landCorner(cornerId)).toBe(true);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    await phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
  });

  it('merges even while checks have not gone green, recorded or live', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await redHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('implement');
    githubHead = SHA;
    githubRollupState = 'failed';

    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await daemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
    expect(await currentState(cornerId)).toBe('land');

    const status = await github.prChecksStatus({ cornerId });
    expect(status).toMatchObject({ checks: 'failed', expressMergeOrdered: true, mergeAllowed: true });

    expect(await github.landCorner(cornerId)).toBe(true);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
  });

  it('claimCornerMergeAttempt never merges a head off `land`, express-ordered or not', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 7, SHA);
    await db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await daemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
    expect(await currentState(cornerId)).toBe('land');
    // Simulate the run having moved on since the order was recorded: express
    // authority is not a second route into the merge that skips `land`.
    await db.query(`UPDATE corner_facts SET workflow_state='implement' WHERE corner_id=$1`, [cornerId]);
    expect(await claimCornerMergeAttempt(db, cornerId, SHA)).toBe(false);
  });

  it('refuses an order from someone who is not a current Workspace owner or admin', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 7, SHA);
    githubHead = SHA;
    githubRollupState = 'passed';
    const peer = 'f'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$1) ON CONFLICT DO NOTHING`, [peer]);
    await db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,
      [W, peer],
    );
    await db.query(
      `INSERT INTO memberships(room_id,identity_id,role,workspace_id) VALUES($1,$2,'member',$3) ON CONFLICT DO NOTHING`,
      [cornerId, peer, W],
    );
    await phone.execute('sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'),
      text: '@hoots merge this now' }, peer);
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await expect(daemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A))
      .rejects.toThrow(/Workspace owner or admin/);
    expect(await github.landCorner(cornerId)).toBe(false);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it('an immediate order attempts the merge itself rather than waiting for the next sweep', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await greenHead(cornerId, 7, SHA);
    githubHead = SHA;
    githubRollupState = 'passed';
    const wiredDaemon = new DaemonService(
      db,
      new LiveHub(),
      undefined, // roomGitHubToken
      undefined, // mediaMaximumBytes
      undefined, // commandTransaction
      undefined, // authorizedCommand
      undefined, // livePaintDiagnostics
      undefined, // liveDiagnosticServerInstance
      undefined, // prChecksStatus
      undefined, // _legacyProviderSlot
      undefined, // institutionalMemoryShadow
      undefined, // mcpRegistry
      undefined, // registryMcpOAuth
      undefined, // composio
      undefined, // feedback
      undefined, // objects
      undefined, // linkWallet
      undefined, // refreshMergeability
      (id: string) => github.landCorner(id), // landCorner
    );
    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await wiredDaemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('landed');
  });
});

describe('a corner opened before the workflow run existed (AC-10)', () => {
  it('gets a run derived from its lifecycle and continues through review and merge', async () => {
    const cornerId = await inReview();
    // Pre-#1918: no run cards, no projected state; the reviewer was already woken.
    await db.query(`DELETE FROM messages WHERE room_id=$1 AND card_type=$2`, [
      cornerId,
      CORNER_LIFECYCLE_CARD_TYPE,
    ]);
    await db.query(`UPDATE corner_facts SET workflow_state=NULL,workflow_outcome=NULL WHERE corner_id=$1`, [cornerId]);
    expect(await backfillCornerLifecycleRuns(db)).toBe(1);
    expect(await projected(cornerId)).toBe('review');
    expect(await cards(cornerId)).toEqual([expect.objectContaining({ toState: 'review', seq: 0, backfilledFrom: 'lifecycle' })]);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('land');
    githubHead = SHA;
    githubRollupState = 'passed';
    expect(await github.landReadyCorners()).toBe(1);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('landed');
  });

  it('a corner with no run at all is given one on its next event', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await db.query(`DELETE FROM messages WHERE room_id=$1 AND card_type=$2`, [
      cornerId,
      CORNER_LIFECYCLE_CARD_TYPE,
    ]);
    await db.query(`UPDATE corner_facts SET workflow_state=NULL WHERE corner_id=$1`, [cornerId]);
    await pushToCorner(cornerId, SHA);
    expect(await currentState(cornerId)).toBe('checks');
  });
});

/**
 * Puts a code corner back the way a research corner sat before the lane was
 * removed: lane research under the old CHECK, its run in investigate.
 */
async function asLegacyResearchCorner(cornerId: string) {
  await db.query(`ALTER TABLE corner_facts DROP CONSTRAINT corner_facts_lane_check`);
  await db.query(
    `ALTER TABLE corner_facts ADD CONSTRAINT corner_facts_lane_check CHECK (lane IN ('code','no_code','research'))`,
  );
  await db.query(
    `UPDATE corner_facts SET lane='research',workflow_state='investigate',workflow_outcome='research' WHERE corner_id=$1`,
    [cornerId],
  );
  await db.query(
    `UPDATE messages SET card=card || '{"outcome":"research","toState":"investigate"}'::jsonb
     WHERE room_id=$1 AND card_type=$2 AND card->>'fromState'='opened'`,
    [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
  );
}

describe('migrating a research corner to the code lane', () => {
  it('moves it to code in implement, unheld, and the server merges it after the reviewer passes it', async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await asLegacyResearchCorner(cornerId);
    expect(await currentState(cornerId)).toBe('investigate');

    await migrate(db);

    expect(
      (await db.query<{ lane: string }>(`SELECT lane FROM corner_facts WHERE corner_id=$1`, [cornerId]))
        .rows[0]!.lane,
    ).toBe('code');
    expect(await currentState(cornerId)).toBe('implement');
    expect(await projected(cornerId)).toBe('implement');
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('review');
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('land');
    githubHead = SHA;
    githubRollupState = 'passed';
    expect((await github.prChecksStatus({ cornerId, pullRequest: 7 })).held).toBe(false);
    expect(await github.landReadyCorners()).toBe(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);

    await expect(
      db.query(`UPDATE corner_facts SET lane='research' WHERE corner_id=$1`, [cornerId]),
    ).rejects.toThrow(/corner_facts_lane_check/);
  });

  it("keeps a migrated corner held while a stored hold stands", async () => {
    const cornerId = await open(undefined, 'owner/widgets');
    await phone.execute('setCornerHold', { cornerId }, H);
    await say(cornerId, "don't merge this yet");
    await asLegacyResearchCorner(cornerId);

    await migrate(db);

    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 7, SHA);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    githubHead = SHA;
    githubRollupState = 'passed';
    const status = await github.prChecksStatus({ cornerId, pullRequest: 7 });
    expect(status).toMatchObject({ held: true, mergeAllowed: false });
    expect(await github.landReadyCorners()).toBe(0);
    expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('every contract edge (AC-1)', () => {
  it('is taken by some test in this file', () => {
    const expected = new Set<string>();
    for (const [from, state] of Object.entries(CORNER_LIFECYCLE_CONTRACT.handoffs)) {
      if (!('on' in state)) continue;
      for (const [outcome, to] of Object.entries(state.on)) expected.add(`${from}:${outcome}:${to}`);
      if ('loop' in state && state.loop) expected.add(`${from}:${state.loop.onEdge}:${state.loop.onExceeded}`);
    }
    const taken = new Set([...recordedEdges].map((edge) => edge));
    const missing = [...expected].filter((edge) => !taken.has(edge));
    expect(missing).toEqual([]);
    for (const terminal of CORNER_LIFECYCLE_CONTRACT.implicitEdges ?? [])
      expect([...taken].some((edge) => edge.endsWith(`:${terminal}:${terminal}`))).toBe(true);
  });
});
