import { phoneFetch } from '../../../tests/helpers/phone-operation.js';

import { cornerKindSql } from './corner-opening.js';

import { setRoomEventSubscriptions } from './agent-subscriptions.js';

import { type createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueryResultRow } from 'pg';

import { migrate, migrateData, type QueryResult, type SqlDatabase } from './database.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { describedWorkflow, PgliteDatabase, migratedDatabase, assignCornerWorker } from './test-support.js';

import { PhoneService } from './phone-service.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { GitHubOperations } from './github-operations.js';

import { LiveHub } from './live.js';

import { backfillArchivedCornerCleanup } from './corner-cleanup-backfill.js';

import { deleteArchivedCornerBranch } from './corner-branch-cleanup.js';

import { systemLine } from './system-line.js';

import { addressedToPersonSql } from './corner-owed.js';

import { GitHubHttpError, type GitHubAppClient, type GitHubOAuthClient } from '@beeline/auth/github';

import type { AgentCommand } from '@beeline/api-contract/daemon';

import {
  advanceCorner,
  backfillCornerLifecycleRuns,
  CORNER_LIFECYCLE_SLUG,
  cornerMergeGate,
  confirmCornerMergeAuthority,
  deleteStoredCornerWorkflows,
} from './corner-lifecycle.js';

import { createAgentCommand, repairReviewerCornerMembership, queueCornerMergeConflict, reconcileCornerMergeBlockers, CORNER_CHECKS_BLOCKED_CARD_TYPE, type CommandRow } from './agent-command.js';

import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';

import { cornerImplementerSql, cornerOwnerSql } from './corner-worker.js';

import { cornerRunStateSql } from './corner-run.js';

import { getWorkflowRun, liveWorkflowRun, saveWorkflow, startWorkflow } from './workflow-runs.js';


/** Records every SQL statement issued, in order — matches workflow-runs.test.ts's own. */
export type RecordedCall = { sql: string; values?: unknown[] };

export class RecordingDatabase implements SqlDatabase {
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


/** Integration coverage for merge, authority and delivery. The pure transition
 * table and retired-card replacement live in corner-machine.test.ts. */

export const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64);

export const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222';

export let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, github: GitHubOperations;

export let githubRollupState: 'pending' | 'passed' | 'failed';

/** The head GitHub reports for the corner's pull request. */
export let githubHead: string;

export let githubApp: {
  branchDeletionSafety: ReturnType<typeof vi.fn>;
  openPullRequestsForBranch: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  markPullRequestReadyForReview: ReturnType<typeof vi.fn>;
  mergePullRequest: ReturnType<typeof vi.fn>;
  readPullRequestQueue: ReturnType<typeof vi.fn>;
  dequeuePullRequest: ReturnType<typeof vi.fn>;
  closePullRequest: ReturnType<typeof vi.fn>;
  readPullRequest: ReturnType<typeof vi.fn>;
  readPullRequestDiscussion: ReturnType<typeof vi.fn>;
  installationToken: ReturnType<typeof vi.fn>;
  readCommitCheckRollup: ReturnType<typeof vi.fn>;
  confirmNoChecks: ReturnType<typeof vi.fn>;
};

beforeAll(async () => {
  db = await migratedDatabase();
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
    branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: false })),
    openPullRequestsForBranch: vi.fn(async () => []),
    deleteBranch: vi.fn(async () => undefined),
    markPullRequestReadyForReview: vi.fn(async () => undefined),
    mergePullRequest: vi.fn(async () => undefined),
    readPullRequestQueue: vi.fn(async () => ({ id: 'PR_7', headSha: SHA, entry: null })),
    dequeuePullRequest: vi.fn(async () => undefined),
    closePullRequest: vi.fn(async () => undefined),
    readPullRequestDiscussion: vi.fn(async () => ({
      files: [{ filename: 'widget.ts', status: 'modified', additions: 3, deletions: 1 }],
      reviews: [{ author: 'speedy', state: 'COMMENTED', body: 'Looks close' }],
      reviewComments: [],
      comments: [],
    })),
    readPullRequest: vi.fn(async (_token: string, _repository: string, number: number) => ({
      number,
      url: `https://github.com/owner/widgets/pull/${number}`,
      headSha: githubHead,
      mergeability: 'clean' as const,
    })),
    installationToken: vi.fn(async () => ({ token: 'tok', expiresAt: '2030-01-01T00:00:00Z' })),
    confirmNoChecks: vi.fn(async () => true),
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
  // Keep real queue reconciliation; only commit-author evidence is a provider fixture.
  vi.spyOn(github, 'assertCornerReviewerNotAuthor').mockResolvedValue(undefined);
  // Live handoff head reads have separate REVIEW-HEAD-1 provider coverage.
  vi.spyOn(github, 'refreshCornerReviewHead').mockResolvedValue(undefined);
  Object.assign(daemon, { github });
}, 30_000);

afterAll(async () => db?.close());


/**
 * Each open corner with a pull request has its implementer call merge_corner
 * once (`GitHubOperations.landCorner`). Nothing about the run state gates the
 * call: only the merge gate on the exact current head does.
 */
export async function implementersMerge(operations: GitHubOperations = github): Promise<number> {
  const corners = await db.query<{ corner_id: string }>(
    `SELECT fact.corner_id FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
     WHERE corner.archived_at IS NULL AND fact.lifecycle->'pr' IS NOT NULL ORDER BY fact.corner_id`,
  );
  const attempted = await Promise.all(corners.rows.map((row) => operations.landCorner(row.corner_id)));
  return attempted.filter(Boolean).length;
}

beforeEach(async () => {
  await db.query(`DELETE FROM agent_schedules`);
  await db.query(`DELETE FROM agent_subscriptions`);
  await db.query(`DELETE FROM work_schedules`);
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM messages WHERE room_id<>$1`, [R]);
  await db.query(`DELETE FROM messages`);
  await db.query(`DELETE FROM corner_facts`);
  await db.query(`DELETE FROM corner_brief_revisions`);
  await db.query(`DELETE FROM corner_merge_approvals`);
  await db.query(`DELETE FROM rooms WHERE parent_id IS NOT NULL`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
  await db.query(`DELETE FROM live_outputs`);
  await db.query(`UPDATE agents SET yolo_mode=true`);
  githubRollupState = 'pending';
  githubHead = '';
  githubApp.readCommitCheckRollup.mockReset();
  githubApp.readCommitCheckRollup.mockImplementation(async () => ({ state: githubRollupState, total: 1,
    failing: githubRollupState === 'failed' ? ['typecheck'] : [], checks: [{ name: 'typecheck', status: githubRollupState }] }));
  githubApp.readPullRequestQueue.mockReset();
  githubApp.readPullRequestQueue.mockResolvedValue({ id: 'PR_7', headSha: SHA, entry: null });
  githubApp.dequeuePullRequest.mockReset();
  githubApp.dequeuePullRequest.mockResolvedValue(undefined);
  githubApp.markPullRequestReadyForReview.mockReset();
  githubApp.mergePullRequest.mockReset();
  githubApp.mergePullRequest.mockResolvedValue(undefined);
  githubApp.deleteBranch.mockReset();
  githubApp.deleteBranch.mockResolvedValue(undefined);
  githubApp.branchDeletionSafety.mockReset();
  githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: false });
  githubApp.openPullRequestsForBranch.mockReset();
  githubApp.openPullRequestsForBranch.mockResolvedValue([]);
  githubApp.closePullRequest.mockReset();
  githubApp.closePullRequest.mockResolvedValue(undefined);
  githubApp.readPullRequest.mockReset();
  githubApp.readPullRequest.mockImplementation(async (_token: string, _repository: string, number: number) => ({
    number, url: `https://github.com/owner/widgets/pull/${number}`, headSha: githubHead, mergeability: 'clean',
  }));
});


/** The corner's worker, derived from its assignment commands. */
export async function derivedWorker(cornerId: string): Promise<string | null> {
  return (await db.query<{ worker: string | null }>(
    `SELECT ${cornerImplementerSql('fact', 'corner')} worker FROM corner_facts fact
     JOIN rooms corner ON corner.id=fact.corner_id WHERE fact.corner_id=$1`, [cornerId])).rows[0]?.worker ?? null;
}


/** Every `workflow-handoff` card for one corner's run, oldest first. */
export async function cards(
  cornerId: string,
): Promise<{ fromState?: string; outcome?: string; toState: string; status?: string }[]> {
  const rows = await db.query<{ card: Record<string, unknown> }>(
    `SELECT card FROM messages WHERE room_id=$1 AND card_type=$2 ORDER BY (card->>'seq')::int`,
    [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
  );
  return rows.rows.map((row) => row.card as never);
}


/** The transcript-derived current state (report.v1.md §4's own query shape). */
export async function currentState(cornerId: string): Promise<string | undefined> {
  await advanceCorner(db, cornerId, { kind: 'reconcile' });
  return (await db.query<{ state: string }>(`SELECT machine->>'state' state FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]?.state;
}


export async function commissioned(roomId: string, agentId = A): Promise<AgentCommand> {
  const handle = (await db.query<{handle:string}>('SELECT handle FROM identities WHERE id=$1',[agentId])).rows[0]!.handle;
  await phone.execute(
    'sendRoomMessage',
    { roomId, messageId: randomBytes(32).toString('hex'), text: `@${handle} please do this` },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId }, agentId)).commands.at(-1);
  await daemon.execute('claimAgentCommand', { roomId, commandId: command!.id, generationId: 'g1' }, agentId);
  return command!;
}


export function brief(sourceMessageId: string) {
  return {
    spec: 'Ship the widget\n\n## Checklist\n\n- AC-1: Publish the result',
    approval: { sourceMessageId },
  };
}


export async function open(repository?: string, hold?: boolean, commander = A): Promise<string> {
  const command = await commissioned(R, commander);
  const { cornerId } = await daemon.execute(
    'createCorner',
    {
      roomId: R,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: 'Ship-widget',
      objective: 'Ship the widget end to end',
      ...(commander !== A ? { implementer: 'hoots' } : {}),

      ...(repository ? { repository, targetBranch: 'main' } : {}),
      brief: brief(command.sourceMessageId),
    },
    commander,
  );
  // Legacy agent-set holds remain releasable after the citation requirement.
  if (hold) await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,set_by_agent_id,standing)
    VALUES($1,$2,$3,'owner')`, [cornerId,H,A]);
  return cornerId;
}


export async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute('claimAgentCommand', { roomId: c.roomId, commandId: c.id, generationId }, c.agentId);
}


/** Puts the corner's lifecycle at a green head and fires the check-passed fact directly. */
/** Drives the real push webhook so the run's own bookkeeping reaches `checks` first. */
export async function pushToCorner(cornerId: string, headSha: string) {
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  await db.query(`SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(command.id,command.generation_id,'complete',NULL,NULL) ended
    FROM agent_commands command JOIN rooms corner ON corner.id=command.room_id JOIN corner_facts fact ON fact.corner_id=corner.id
    WHERE command.room_id=$1 AND (command.agent_id=${cornerImplementerSql('fact', 'corner')}
      OR command.agent_id IS DISTINCT FROM COALESCE(fact.reviewer_agent_id,(SELECT reviewer_agent_id FROM rooms WHERE id=corner.parent_id)))
      AND command.reason<>'report' AND command.state IN ('pending','claimed') AND command.action IN ('input','resume')) terminal`, [cornerId]);
  githubHead = headSha;
  await github.processWebhook('push', {
    installation: { id: 77 },
    repository: { id: 101, full_name: 'owner/widgets' },
    ref: `refs/heads/${branch}`,
    after: headSha,
    commits: [{}],
    pusher: { name: 'hoots' },
  });
}


export async function greenHead(cornerId: string, number: number, headSha: string) {
  await pushToCorner(cornerId, headSha);
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
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


export async function redHead(cornerId: string, number: number, headSha: string) {
  await pushToCorner(cornerId, headSha);
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
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


/** Start a fresh assignment after the preceding implementation handed off. */
export async function resumeWorker(cornerId: string): Promise<AgentCommand> {
  const parent = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE room_id=$1
    AND reason='corner_objective' ORDER BY inbox_sequence LIMIT 1`, [cornerId])).rows[0];
  const created = await createAgentCommand(db, { roomId: cornerId, agentId: A, sourceMessageId: null,
    reason: 'order', parent, retainDepth: true,
    privatePayload: { ...parent?.private_payload, kind: 'order', authorId: H,
      fromRoomId: parent?.private_payload?.fromRoomId ?? R, text: 'Continue the implementation' } });
  return (await commands(A, cornerId)).find(command => command.id === created!.id)!;
}


export const commands = (agentId: string, roomId: string) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);


export const result = (c: AgentCommand, text: string, generationId = 'g1') =>
  daemon.execute('postRoomMessage', { roomId: c.roomId, requestId: c.turnRequestId, generationId, text }, c.agentId);


/** A fixture that finishes execution, including the real helper's final receipt. */
export async function terminalResult(c: AgentCommand, text: string, generationId = 'g1') {
  const published = await result(c, text, generationId);
  await daemon.execute('postAgentTurnReceipt', { roomId: c.roomId, requestId: c.turnRequestId,
    generationId, agentId: c.agentId, status: 'complete' }, c.agentId);
  return published;
}


/** Review repair orders originate in the Room; corner turns cannot order themselves. */
export async function orderRepairsFromRoom(review: AgentCommand, cornerId: string, text: string) {
  const coordination = await createAgentCommand(db, { roomId: R, agentId: B, sourceMessageId: null,
    privatePayload: { kind: 'order', text: 'Coordinate review repairs', authorId: A, fromRoomId: R },
    reason: 'order', parent: (await db.query<import('./agent-command.js').CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [review.id])).rows[0] });
  const turn = (await commands(B, R)).find(command => command.id === coordination!.id)!;
  await claim(turn);
  await daemon.execute('order', { roomId: R, requestId: turn.turnRequestId, generationId: 'g1', address: cornerId, text }, B);
}


export const SHA = '7'.repeat(40);

/** The phone badge at implement, checks, review, review with a yes, and landed. */
// These fixtures leave the opening worker command queued through the PR stages.
export const BADGES = ['working', 'working', 'working', 'working', 'archived'];

/** The phone badge at a freshly opened implement and closed. */
export const OPEN_CLOSE_BADGES = ['working', 'archived'];

export const branchOf = (cornerId: string) => `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;


export async function reasons(cornerId: string, agentId: string): Promise<string[]> {
  return (
    await db.query<{ reason: string }>(
      `SELECT reason FROM agent_commands WHERE room_id=$1 AND reason<>'report' AND agent_id=$2 ORDER BY created_at,id`,
      [cornerId, agentId],
    )
  ).rows.map((row) => row.reason);
}


/** The persisted machine state read by the phone badge. */
export async function projected(cornerId: string): Promise<string | null> {
  return (
    await db.query<{ workflow_state: string | null }>(`SELECT ${cornerRunStateSql('$1::uuid')} workflow_state`, [cornerId])
  ).rows[0]!.workflow_state;
}


/** A code corner whose green head woke the configured reviewer (Goosy). */
export async function inReview(number = 7, headSha = SHA): Promise<string> {
  const cornerId = await open('owner/widgets');
  await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await greenHead(cornerId, number, headSha);
  return cornerId;
}


export function approve(cornerId: string, headSha = SHA, agentId = B) {
  return daemon.execute('approveCornerMerge', { cornerId, headSha }, agentId);
}


/** The reviewer's PASS on a green head; GitHub reports that head green. */
export async function approved(): Promise<string> {
  const cornerId = await inReview();
  const [review] = await commands(B, cornerId);
  await claim(review!);
  await approve(cornerId);
  await result(review!, `approved ${SHA}`);
  githubHead = SHA;
  githubRollupState = 'passed';
  return cornerId;
}


export async function mergedWebhook(cornerId: string, number: number, headSha: string) {
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


export async function say(roomId: string, text: string) {
  await phone.execute('sendRoomMessage', { roomId, messageId: randomBytes(32).toString('hex'), text }, H);
}


export async function revise(cornerId: string, service = daemon) {
  await fallback(cornerId, false);
  const command = await commissioned(R, F);
  return service.execute('reviseCornerBrief', {
    roomId: R, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 1,
    brief: { ...brief(command.sourceMessageId), spec: 'Revised widget\n\n## Checklist\n- Ship it', change: 'Changed scope' },
  }, F);
}


export const F = 'e'.repeat(64);

/** Another agent member of the Room; a stored fallback reviewer list is retired and ignored. */
export async function fallback(cornerId: string, online = true) {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Fallback','fallback') ON CONFLICT DO NOTHING`, [F]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [F, H]);
  for (const roomId of [null, R])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [W, roomId, F]);
  await repairReviewerCornerMembership(db, cornerId, F);
  if (online) await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [R, F]);
}
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
get github(){return github;}, set github(value: typeof github){github=value;},
get githubRollupState(){return githubRollupState;}, set githubRollupState(value: typeof githubRollupState){githubRollupState=value;},
get githubHead(){return githubHead;}, set githubHead(value: typeof githubHead){githubHead=value;},
get githubApp(){return githubApp;}, set githubApp(value: typeof githubApp){githubApp=value;},
};
export function fixtureScope2(_name: string, stored: boolean) {

  const badge = async (cornerId: string, archived = false) =>
    (await rootFixture.phone.readCorners(R, H, false, archived))!.corners.find((row) => row.corner.id === cornerId)!.state;

  const STORED = '55555555-5555-4555-8555-555555555555';


  beforeEach(async () => {
    if (stored) {
      // A version 9 copy whose contract differs from the code, as if edited.
      await rootFixture.db.query(
        `INSERT INTO workspace_skills
           (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
            repository,target_commit,path,kind)
         VALUES($1,$2,$3,'Stale copy','active',9,9,$4,'','',NULL,'workflow')`,
        [STORED, W, CORNER_LIFECYCLE_SLUG, R],
      );
      await rootFixture.db.query(
        `INSERT INTO workspace_skill_versions
           (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
            repository,target_commit,path,extractor_version,model)
         VALUES($1,9,$2,$3,NULL,$4,'','',NULL,'corner-workflow-v1','n/a')`,
        [
          STORED,
          JSON.stringify({ version: 1, name: 'corner', description: 'Stale copy' }),
          'f'.repeat(64),
          ['system:corner-workflow-seed'],
        ],
      );
    }
    expect(
      (await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE slug=$1`, [CORNER_LIFECYCLE_SLUG])).rowCount,
    ).toBe(stored ? 1 : 0);
  });

  afterEach(async () => {
    await rootFixture.db.query(`DELETE FROM workspace_skills WHERE id=$1`, [STORED]);
  });
return {
badge,
STORED,
_name,
stored,
};
}
export function fixtureScope9() {

  async function toReview(): Promise<string> {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 7, '7'.repeat(40));
    return cornerId;
  }
return {
toReview,
};
}
export function fixtureScope10() {


  async function seedWakeSources(roomId: string) {
    const id = randomUUID();
    await rootFixture.db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":60}','wake',now())`, [id, W, roomId, A, H]);
    await rootFixture.db.query(`INSERT INTO agent_schedule_occurrences(schedule_id,scheduled_for,message_id)
      VALUES($1,now(),$2)`, [id, randomUUID()]);
    await rootFixture.db.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt)
      VALUES($1,$2,$3,$4,'room','joined','wake')`, [randomUUID(), W, roomId, A]);
    await rootFixture.db.query(`INSERT INTO work_schedules(schedule_id,agent_id,room_id,revision,schedule)
      VALUES($1,$2,$3,1,'{}')`, [id, A, roomId]);
    for (const member of [A,B,H]) await setRoomEventSubscriptions(rootFixture.db,roomId,member,['joined']);
    return id;
  }


  async function expectWakeSources(roomId: string, count: number) {
    for (const table of ['agent_schedules', 'agent_subscriptions', 'work_schedules'])
      expect((await rootFixture.db.query(`SELECT 1 FROM ${table} WHERE room_id=$1 ${table === 'agent_subscriptions' && count ? "AND event='joined'" : ''}`, [roomId])).rowCount).toBe(table === 'agent_subscriptions' ? count * 3 : count);
    expect((await rootFixture.db.query(`SELECT 1 FROM room_access WHERE room_id=$1 AND event_subscriptions<>'[]'::jsonb`,
      [roomId])).rowCount).toBe(count ? 3 : 0);
  }
return {
seedWakeSources,
expectWakeSources,
};
}
export function fixtureScope11() {

  /** The implementer (Hoots) is online, so a revision can wake it. */
  const implementerOnline = () => rootFixture.db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [R, A],
  );
return {
implementerOnline,
};
}
export function fixtureScope14() {

  /** A GitHubOperations whose first repository-target read (after the gate read) runs `change` first. */
  function racedWith(change: () => Promise<void>) {
    const state = { injected: false };
    const interposed: SqlDatabase = {
      transaction: work => rootFixture.db.transaction(work),
      query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
        if (!state.injected && sql.includes('SELECT (fact.lifecycle') && sql.includes('JOIN github_repositories repository')) {
          state.injected = true;
          await change();
        }
        return rootFixture.db.query<Row>(sql, values);
      },
    };
    return { state, raced: new GitHubOperations(interposed, {} as GitHubOAuthClient, rootFixture.githubApp as unknown as GitHubAppClient, 'secret') };
  }


  /** GitHub merges once: after the first merge the live pull request reads merged. */
  function mergesOnceOnGitHub(cornerId: string) {
    rootFixture.githubApp.mergePullRequest.mockImplementationOnce(async () => {
      rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/widgets/pull/7',
        headSha: SHA, headRef: branchOf(cornerId), baseRef: 'main', merged: true, mergedAt: '2026-01-01T00:00:00Z' });
    });
  }
return {
racedWith,
mergesOnceOnGitHub,
};
}
export function fixtureScope18() {

  const running = {
    state: 'failed',
    total: 2,
    failing: ['Body suite'],
    checks: [{ name: 'Body suite', status: 'failed' }, { name: 'Server suite', status: 'pending' }],
  };

  const finished = {
    ...running,
    checks: [{ name: 'Body suite', status: 'failed' }, { name: 'Server suite', status: 'passed' }],
  };

  async function checkRun(cornerId: string, name: string, conclusion: string, headSha = SHA) {
    await rootFixture.github.processWebhook('check_run', {
      installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action: 'completed',
      check_run: { id: 9, name, status: 'completed', conclusion,
        check_suite: { head_branch: branchOf(cornerId), head_sha: headSha } },
    });
  }

  async function redWhileRunning(): Promise<string> {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({ checks: 'unknown', lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA } }),
    ]);
    await pushToCorner(cornerId, SHA);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(running);
    await checkRun(cornerId, 'Body suite', 'failure');
    return cornerId;
  }

  const checksOf = async (cornerId: string) =>
    (await rootFixture.db.query<{ checks: string }>(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [cornerId]))
      .rows[0]!.checks;
return {
running,
finished,
checkRun,
redWhileRunning,
checksOf,
};
}
export function fixtureScope19() {

  async function cornerAtHead(): Promise<string> {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({
        checks: 'unknown',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA },
      }),
    ]);
    await pushToCorner(cornerId, SHA);
    return cornerId;
  }

  async function checkRunWebhook(cornerId: string, name: string, conclusion: string) {
    await rootFixture.github.processWebhook('check_run', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'completed',
      check_run: {
        id: 9,
        name,
        status: 'completed',
        conclusion,
        check_suite: { head_branch: branchOf(cornerId), head_sha: SHA },
      },
    });
  }

  const cornerCheckWakes = async (cornerId: string) =>
    (await rootFixture.daemon.execute('getAgentCommands', { roomId: cornerId }, A)).commands.filter(
      (command) => command.reason === 'corner_check',
    );
return {
cornerAtHead,
checkRunWebhook,
cornerCheckWakes,
};
}
export function fixtureScope20() {

  // A third agent, a member of the corner only: the reviewer stays B, so the
  // tagged implementer is never the reviewer. `beforeEach` drops the corner
  // rows, so it is re-added per test and its identities row is idempotent.
  const D = 'd'.repeat(64);

  async function taggableMember(cornerId: string): Promise<void> {
    await rootFixture.db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Sol','sol') ON CONFLICT(id) DO NOTHING`,
      [D],
    );
    await rootFixture.db.query(
      `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT(agent_id) DO UPDATE SET owner_id=EXCLUDED.owner_id`,
      [D, H],
    );
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
      [W, R, D],
    );
  }

  const workerOf = derivedWorker;
return {
D,
taggableMember,
workerOf,
};
}
export function fixtureScope24() {

  function mergeDaemon(operations = rootFixture.github) {
    return new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => operations.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id, onBlocked) => operations.landCornerOutcome(id, onBlocked));
  }
return {
mergeDaemon,
};
}
export function fixtureScope26() {

  function mergeDaemon(operations = rootFixture.github) {
    return new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => operations.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id, onBlocked) => operations.landCornerOutcome(id, onBlocked));
  }


  function providerPr(cornerId: string, merged = false, headSha = SHA) {
    return {
      number: 7, url: 'https://github.com/owner/widgets/pull/7', title: 'Ship the widget',
      headSha, headRef: branchOf(cornerId), baseRef: 'main', merged, mergeability: 'clean',
      ...(merged ? { mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: '8'.repeat(40) } : {}),
    };
  }


  async function landing(cornerId: string) {
    expect(await currentState(cornerId)).toBe('archived');

    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived_at)
      .not.toBeNull();
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%merged%'`, [cornerId])).rowCount)
      .toBe(1);
  }
return {
mergeDaemon,
providerPr,
landing,
};
}
export function fixtureScope30() {

  /** The corner's human requester orders the merge through its agent's order_corner_merge. */
  async function order(cornerId: string, service: DaemonService = rootFixture.daemon) {
    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    return service.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
  }
return {
order,
};
}
export function fixtureScope31() {

  const REFUSAL = /this corner's brief does not assign repository work; revise the brief before merging/;


  /** Sets the corner's current brief: none at all, or a revision with this repositoryWork. */
  async function briefSays(cornerId: string, repositoryWork: boolean | 'none') {
    if (repositoryWork === 'none') {
      await rootFixture.db.query(`DELETE FROM corner_brief_revisions WHERE corner_id=$1`, [cornerId]);
      return;
    }
    const command = await commissioned(R);
    await rootFixture.daemon.execute('reviseCornerBrief', {
      roomId: R, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 1,
      brief: { ...brief(command.sourceMessageId), repositoryWork, change: 'Say whether files change' },
    }, A);
  }


  function wired() {
    return new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id: string) => rootFixture.github.landCornerOutcome(id));
  }


  /** A green head with no reviewer configured, waiting for a person's yes. */
  async function waitingForPerson(): Promise<string> {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    return cornerId;
  }
return {
REFUSAL,
briefSays,
wired,
waitingForPerson,
};
}
export function fixtureScope34() {

  beforeEach(() => { Object.assign(rootFixture.phone, { github: rootFixture.github }); });

  afterEach(() => { Object.assign(rootFixture.phone, { github: undefined }); });

  async function closeAndClean() {
    const cornerId = await open('owner/widgets');
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    return cornerId;
  }
return {
closeAndClean,
};
}
export function fixtureScope35() {

  const combinedSha = '9'.repeat(40);

  async function queued() {
    const cornerId = await approved();
    rootFixture.githubApp.readPullRequest.mockResolvedValue({
      headSha: SHA, headRef: branchOf(cornerId), baseRef: 'main', baseSha: '8'.repeat(40), merged: false,
    });
    rootFixture.githubApp.readPullRequestQueue.mockResolvedValue({ id: 'PR_7', headSha: SHA,
      entry: { id: 'MQ_7', headCommit: { oid: combinedSha } } });
    rootFixture.githubApp.mergePullRequest.mockResolvedValue('queued');
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id: string) => rootFixture.github.landCornerOutcome(id));
    expect(await wiredDaemon.execute('mergeCorner', { cornerId }, A)).toEqual({ status: 'queued', headSha: SHA });
    expect(await currentState(cornerId)).toBe('idle');
    const visible = (await rootFixture.phone.readCorners(R, H))!.corners.find(row => row.corner.id === cornerId);
    expect(visible?.lifecycle.mergeQueue).toEqual({ headSha: SHA, combinedSha });
    return cornerId;
  }
return {
combinedSha,
queued,
};
}
export { phoneFetch } from '../../../tests/helpers/phone-operation.js';
export { cornerKindSql } from './corner-opening.js';
export { setRoomEventSubscriptions } from './agent-subscriptions.js';
export { createHash, randomBytes, randomUUID } from 'node:crypto';
export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
export { migrate, migrateData } from './database.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { describedWorkflow, PgliteDatabase, migratedDatabase, assignCornerWorker } from './test-support.js';
export { PhoneService } from './phone-service.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { GitHubOperations } from './github-operations.js';
export { LiveHub } from './live.js';
export { backfillArchivedCornerCleanup } from './corner-cleanup-backfill.js';
export { deleteArchivedCornerBranch } from './corner-branch-cleanup.js';
export { systemLine } from './system-line.js';
export { addressedToPersonSql } from './corner-owed.js';
export { GitHubHttpError } from '@beeline/auth/github';
export { advanceCorner, backfillCornerLifecycleRuns, CORNER_LIFECYCLE_SLUG, cornerMergeGate, confirmCornerMergeAuthority, deleteStoredCornerWorkflows } from './corner-lifecycle.js';
export { createAgentCommand, repairReviewerCornerMembership, queueCornerMergeConflict, reconcileCornerMergeBlockers, CORNER_CHECKS_BLOCKED_CARD_TYPE } from './agent-command.js';
export { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
export { cornerImplementerSql, cornerOwnerSql } from './corner-worker.js';
export { cornerRunStateSql } from './corner-run.js';
export { getWorkflowRun, liveWorkflowRun, saveWorkflow, startWorkflow } from './workflow-runs.js';
export type { QueryResultRow } from 'pg';
export type { QueryResult, SqlDatabase } from './database.js';
export type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
export type { AgentCommand } from '@beeline/api-contract/daemon';
export type { CommandRow } from './agent-command.js';
