import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkflowContract } from '@beeline/api-contract/daemon';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { systemLine } from './system-line.js';
import { REVIEW_HANDBACK_LIMIT } from './agent-command.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { CORNER_WORKFLOW_CONTRACT, CORNER_WORKFLOW_SLUG, ensureCornerWorkflowSeeded } from './corner-workflow.js';

/**
 * The corner lifecycle expressed as the built-in "corner" workflow contract
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
  // This fixture inserts its Workspace directly (as every other corner test
  // file does), bypassing both `createWorkspace`'s seeding and the deploy
  // backfill — seed it explicitly here instead, the way an already-existing
  // Workspace gets it in production.
  await ensureCornerWorkflowSeeded(db, W, R);
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
  githubRollupState = 'pending';
  const githubApp = {
    deleteBranch: vi.fn(async () => undefined),
    mergePullRequest: vi.fn(async () => undefined),
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
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
  githubRollupState = 'pending';
});

/** Every `workflow-handoff` card for one corner's run, oldest first. */
async function cards(
  cornerId: string,
): Promise<{ fromState?: string; outcome?: string; toState: string; status?: string }[]> {
  const rows = await db.query<{ card: Record<string, unknown> }>(
    `SELECT card FROM messages WHERE room_id=$1 AND card_type=$2 ORDER BY (card->>'seq')::int`,
    [cornerId, 'workflow-handoff'],
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
  const intent = { sourceMessageId, snapshot: '@hoots please do this' };
  return {
    buildSpec: 'Ship the widget',
    intentVerbatim: [intent],
    criteria: [{ id: 'AC-1', text: 'Publish the result' }],
    references: [],
    approvalBasis: { kind: 'initiating-command' as const, ...intent },
  };
}

async function open(lane?: 'code' | 'no_code' | 'research', repository?: string): Promise<string> {
  const command = await commissioned(R);
  const { cornerId } = await daemon.execute(
    'createCorner',
    {
      roomId: R,
      requestId: command.turnRequestId,
      generationId: 'g1',
      name: 'Ship widget',
      objective: 'Ship the widget end to end',
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

describe('the corner workflow contract itself', () => {
  it('validates against the shared workflow-contract schema', () => {
    expect(readWorkflowContract(CORNER_WORKFLOW_CONTRACT)).toEqual(CORNER_WORKFLOW_CONTRACT);
  });

  it('is seeded as an active, discoverable workspace_skills row of kind workflow', async () => {
    const row = await db.query<{ kind: string; state: string }>(
      `SELECT kind,state FROM workspace_skills WHERE workspace_id=$1 AND slug=$2`,
      [W, CORNER_WORKFLOW_SLUG],
    );
    expect(row.rows[0]).toEqual({ kind: 'workflow', state: 'active' });
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

  it('a research corner opens onto investigate, a dead end with no programmatic exit', async () => {
    const cornerId = await open('research', 'owner/widgets');
    expect(await currentState(cornerId)).toBe('investigate');
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
    expect(await cards(cornerId)).toEqual(before);
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
    const { noteCornerWorkflowImplicitEdge } = await import('./corner-workflow.js');
    await noteCornerWorkflowImplicitEdge(db, { cornerId, toState: 'landed' });
    expect(await cards(cornerId)).toEqual(before);
  });
});
