import { describe, expect, it, vi, GitHubAppClient, GitHubOAuthClient, seedCornerOpening, insertCornerFacts, GitHubOperations, HUMAN, REVIEWER, fixtureScope1 } from './github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();

  it.each(['workflow_job', 'workflow_run', 'delete'])(
    'does not refresh an installation for %s webhooks', async (event) => {
      await scope1.database.query(
        `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
         VALUES(77,$1,'42','owner','User','selected','active')`,
        [HUMAN],
      );
      const app = {
        installationAccount: vi.fn(),
        listRepositories: vi.fn(),
      } as unknown as GitHubAppClient;
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

      await operations.processWebhook(event, {
        action: 'completed', installation: { id: 77 },
      });

      expect(app.installationAccount).not.toHaveBeenCalled();
      expect(app.listRepositories).not.toHaveBeenCalled();
    },
  );

  it('records GitHub repository visibility on installation refresh', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    let widgetsPrivate = true;
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 101,
          installationId: 77,
          fullName: 'owner/widgets',
          defaultBranch: 'main',
          private: widgetsPrivate,
        },
        {
          id: 102,
          installationId: 77,
          fullName: 'owner/open',
          defaultBranch: 'main',
          private: false,
        },
      ]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const stored = async () =>
      (
        await scope1.database.query<{ repository_id: number; private: boolean | null }>(
          `SELECT repository_id,private FROM github_repositories WHERE installation_id=77 ORDER BY repository_id`,
        )
      ).rows;

    await operations.processWebhook('installation', {
      action: 'created',
      installation: { id: 77 },
    });
    expect(await stored()).toEqual([
      { repository_id: 101, private: true },
      { repository_id: 102, private: false },
    ]);

    widgetsPrivate = false;
    await operations.processWebhook('repository', {
      action: 'publicized',
      installation: { id: 77 },
    });
    expect(await stored()).toEqual([
      { repository_id: 101, private: false },
      { repository_id: 102, private: false },
    ]);
  });

  it('records a repository auto-merge toggle on the next installation sync', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,allow_auto_merge)
       VALUES(101,77,'owner/widgets','main',false)`,
    );
    let widgetsAutoMerge = false;
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42',
        login: 'owner',
        type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [
        {
          id: 101,
          installationId: 77,
          fullName: 'owner/widgets',
          defaultBranch: 'main',
          private: false,
          allowAutoMerge: widgetsAutoMerge,
        },
      ]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const stored = async () =>
      (
        await scope1.database.query<{ allow_auto_merge: boolean | null }>(
          `SELECT allow_auto_merge FROM github_repositories WHERE repository_id=101`,
        )
      ).rows[0]?.allow_auto_merge;

    expect(await stored()).toBe(false);

    // A repo already bound to a Room with a reviewer gets auto-merge turned
    // on later, on GitHub's side, with nobody touching the Room. The next
    // webhook-triggered sync is the only thing that records it.
    widgetsAutoMerge = true;
    await operations.processWebhook('repository', {
      action: 'edited',
      installation: { id: 77 },
    });
    expect(await stored()).toBe(true);
  });

  it('still refreshes the catalog for a repository lifecycle webhook', async () => {
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    const app = {
      installationAccount: vi.fn(async () => ({
        id: '42', login: 'owner', type: 'User' as const,
        repositorySelection: 'selected' as const,
      })),
      listRepositories: vi.fn(async () => [{
        id: 101, installationId: 77, fullName: 'owner/renamed', defaultBranch: 'main',
      }]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

    await operations.processWebhook('repository', {
      action: 'renamed', installation: { id: 77 },
    });

    expect(app.installationAccount).toHaveBeenCalledWith(77);
    expect((await scope1.database.query<{ full_name: string }>(
      `SELECT full_name FROM github_repositories WHERE repository_id=101`,
    )).rows[0]?.full_name).toBe('owner/renamed');
  });

  it('uses the Room exact-repository token to list and dispatch on the stored default branch', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','trunk')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,github_installation_id)
       VALUES($1,$2,'General','github:101','git://github.com/owner/widgets',77)`,
      [room, workspace],
    );
    const app = {
      installationToken: vi.fn(async () => ({
        token: 'room-token',
        expiresAt: '2030-01-01T00:00:00Z',
      })),
      listDispatchableWorkflows: vi.fn(async () => [
        { id: 12, name: 'Release', lastRunAt: 1_789_214_400, conclusion: 'success' },
      ]),
      dispatchWorkflow: vi.fn(async () => undefined),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

    await expect(operations.listRoomWorkflows(room)).resolves.toEqual({
      defaultBranch: 'trunk',
      workflows: [{ name: 'Release', lastRunAt: 1_789_214_400, conclusion: 'success' }],
    });
    await expect(operations.dispatchRoomWorkflow(room, 'Release')).resolves.toBeUndefined();
    expect(app.installationToken).toHaveBeenNthCalledWith(1, 77, { repositoryIds: [101] });
    expect(app.installationToken).toHaveBeenNthCalledWith(2, 77, { repositoryIds: [101] });
    expect(app.listDispatchableWorkflows).toHaveBeenCalledWith(
      'room-token',
      'owner/widgets',
      'trunk',
    );
    expect(app.dispatchWorkflow).toHaveBeenCalledWith('room-token', 'owner/widgets', 12, 'trunk');
    // Reproduction release-dispatch-attribution: an anonymous production dispatch must be refused.
    vi.mocked(app.listDispatchableWorkflows).mockResolvedValue([
      { id: 13, name: 'Unified production release' },
    ]);
    await expect(operations.dispatchRoomWorkflow(room, 'Unified production release'))
      .rejects.toThrow(/agent identity/);

  });

  it("rejects the older overlapping webhook fetch and stores GitHub's latest rollup", async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const headSha = '1'.repeat(40);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(
         installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
       ) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(
         id,workspace_id,created_by,name,repository_key,repository_remote,
         repository_resolution,github_installation_id
       ) VALUES($1,$2,$3,'General','owner/widgets','https://github.com/owner/widgets.git','repository',77)`,
      [room, workspace, HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'Checks')`,
      [corner, workspace, room, HUMAN],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: JSON.stringify({
          lifecycle: 'in-review',
          branch: 'feature/corner-333333333333',
          checks: 'unknown',
          pr: {
            number: 1,
            url: 'https://github.com/owner/widgets/pull/1',
            title: 'Fix checks',
            targetBranch: 'main',
            headSha,
            mergeability: 'clean',
          },
        }) });
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Reviewer')`, [
      REVIEWER,
    ]);
    await scope1.database.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [room, REVIEWER]);
    for (const roomId of [room])
      await scope1.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'member')`,
        [workspace, roomId, REVIEWER],
      );
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readCommitCheckRollup = vi
      .fn()
      .mockImplementationOnce(async () => {
        started();
        await releaseFirst;
        return { state: 'pending', total: 2, failing: [], checks: [] };
      })
      .mockResolvedValueOnce({
        state: 'passed',
        total: 2,
        failing: [],
        checks: [
          { name: 'lint', status: 'passed' },
          { name: 'typecheck', status: 'passed' },
        ],
      });
    const app = {
      installationToken: vi.fn(async () => ({
        token: 'room-token',
        expiresAt: '2030-01-01T00:00:00Z',
      })),
      readCommitCheckRollup,
      readPullRequest: vi.fn(async () => ({
        number: 1,
        url: 'https://github.com/owner/widgets/pull/1',
        headSha,
        mergeability: 'unknown' as const,
      })),
      readBranchHead: vi.fn(async () => '4'.repeat(40)),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const payload = (name: string, status: 'in_progress' | 'completed') => ({
      action: status === 'completed' ? 'completed' : 'in_progress',
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      check_run: {
        name,
        status,
        ...(status === 'completed' ? { conclusion: 'success' } : {}),
        check_suite: { head_branch: 'feature/corner-333333333333', head_sha: headSha },
      },
    });
    const first = operations.processWebhook('check_run', payload('lint', 'completed'));
    await firstStarted;
    // The aggregate turns green on another delivery for the same check. The
    // first delivery already used its ordinary GitHub note's deterministic ID.
    // Local admission is serial; independent servers still overlap their fetches.
    const otherServer = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const second = otherServer.processWebhook('check_run', payload('lint', 'completed'));
    try {
      await second;
      expect(readCommitCheckRollup).toHaveBeenCalledTimes(2);
    } finally { release(); await first; }

    expect(
      (
        await scope1.database.query<{ lifecycle: { checks: string; checksSummary: { status: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle,
    ).toMatchObject({
      checks: 'passing',
      checksSummary: {
        status: 'passing',
        total: 2,
        checks: [{ name: 'lint' }, { name: 'typecheck' }],
      },
    });
    expect(
      (
        await scope1.database.query<{ source_kind: string; agent_id: string }>(
          `SELECT command.agent_id,message.system_event->>'kind' source_kind
           FROM agent_commands command JOIN messages message ON message.id=command.source_message_id
           WHERE command.room_id=$1`,
          [corner],
        )
      ).rows,
    ).toEqual([{ agent_id: REVIEWER, source_kind: 'check-passed' }]);
    // A re-run on the same head reopens checks, and its green dispatches the
    // reviewer again even though this head's green note was already written.
    await scope1.database.query(`DELETE FROM agent_commands WHERE room_id=$1`, [corner]);
    readCommitCheckRollup.mockResolvedValue({
      state: 'pending',
      total: 2,
      failing: [],
      checks: [{ name: 'lint', status: 'pending' }],
    });
    await operations.processWebhook('check_run', payload('lint', 'completed'));
    readCommitCheckRollup.mockResolvedValue({
      state: 'passed',
      total: 2,
      failing: [],
      checks: [{ name: 'lint', status: 'passed' }],
    });
    await operations.processWebhook('check_run', payload('lint', 'completed'));
    expect(
      (
        await scope1.database.query<{ agent_id: string }>(
          `SELECT agent_id FROM agent_commands WHERE room_id=$1`,
          [corner],
        )
      ).rows,
    ).toEqual([{ agent_id: REVIEWER }]);
    await scope1.database.query(`DELETE FROM agent_commands WHERE room_id=$1`, [corner]);
    // The reviewer opened this corner, so it is the one woken for the conflict.
    await seedCornerOpening(scope1.database, { cornerId: corner, agentId: REVIEWER });
    await scope1.database.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [corner, REVIEWER]);
    const dirty = {
      action: 'synchronize',
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      pull_request: {
        number: 1,
        title: 'Fix checks',
        html_url: 'https://github.com/owner/widgets/pull/1',
        head: { ref: 'feature/corner-333333333333', sha: headSha },
        base: { ref: 'main' },
        mergeable_state: 'dirty',
        merged: false,
      },
    };
    // A webhook alone never wakes; the live read confirms the conflict.
    const readPullRequest = app.readPullRequest as ReturnType<typeof vi.fn>;
    const confirmDirty = {
      number: 1,
      url: dirty.pull_request.html_url,
      headSha,
      mergeability: 'dirty' as const,
    };
    readPullRequest.mockResolvedValueOnce(confirmDirty);
    await operations.processWebhook('pull_request', dirty);
    expect(
      (
        await scope1.database.query<{ reason: string }>(
          `SELECT reason FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`,
          [corner],
        )
      ).rows,
    ).toEqual([{ reason: 'corner_merge_conflict' }]);
    readPullRequest.mockResolvedValueOnce(confirmDirty);
    await operations.processWebhook('pull_request', dirty);
    expect(
      (await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [corner])).rowCount,
    ).toBe(1);
    await scope1.database.query(`DELETE FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [corner]);
    readPullRequest.mockResolvedValueOnce(confirmDirty);
    await operations.processWebhook('pull_request', dirty);
    expect(
      (await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [corner])).rowCount,
    ).toBe(1);
    readCommitCheckRollup.mockResolvedValue({
      state: 'failed',
      total: 1,
      failing: ['lint'],
      checks: [{ name: 'lint', status: 'failed' }],
    });
    const failed = payload('lint', 'completed');
    failed.check_run.conclusion = 'failure';
    await operations.processWebhook('check_run', failed);
    expect(
      (
        await scope1.database.query<{ reason: string }>(
          `SELECT reason FROM agent_commands WHERE room_id=$1 AND reason='corner_check'`,
          [corner],
        )
      ).rows,
    ).toEqual([{ reason: 'corner_check' }]);
    // A redelivered failure moves nothing: the one wake already went out with
    // the transition to implement.
    await operations.processWebhook('check_run', failed);
    expect(
      (
        await scope1.database.query<{ reason: string }>(
          `SELECT reason FROM agent_commands WHERE room_id=$1 AND reason='corner_check'`,
          [corner],
        )
      ).rows,
    ).toEqual([{ reason: 'corner_check' }]);
    const nextHead = '2'.repeat(40);
    const unknown = {
      ...dirty,
      pull_request: {
        ...dirty.pull_request,
        head: { ...dirty.pull_request.head, sha: nextHead },
        mergeable_state: 'unknown',
      },
    };
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: nextHead,
      mergeability: 'unknown',
    });
    await operations.processWebhook('pull_request', unknown);
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr.mergeability,
    ).toBe('unknown');
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_merge_conflict'
      AND source_message_id<>$2`,
          [
            corner,
            (
              await scope1.database.query<{ source_message_id: string }>(
                `SELECT source_message_id FROM agent_commands WHERE room_id=$1 AND reason='corner_merge_conflict' LIMIT 1`,
                [corner],
              )
            ).rows[0]?.source_message_id,
          ],
        )
      ).rowCount,
    ).toBe(0);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: nextHead,
      mergeability: 'dirty',
    });
    await operations.refreshStaleMergeability(corner);
    expect(
      (
        await scope1.database.query<{ reason: string }>(
          `SELECT reason FROM agent_commands WHERE room_id=$1 AND reason='corner_merge_conflict'`,
          [corner],
        )
      ).rows,
    ).toEqual([{ reason: 'corner_merge_conflict' }, { reason: 'corner_merge_conflict' }]);
    await operations.processWebhook('pull_request', unknown);
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1
      AND reason='corner_merge_conflict'`,
          [corner],
        )
      ).rowCount,
    ).toBe(2);
    const newestHead = '3'.repeat(40);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: nextHead,
      mergeability: 'dirty',
    });
    await operations.processWebhook('pull_request', {
      ...unknown,
      pull_request: {
        ...unknown.pull_request,
        head: { ...unknown.pull_request.head, sha: newestHead },
      },
    });
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { headSha: string; mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr,
    ).toMatchObject({ headSha: newestHead, mergeability: 'unknown' });
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1
      AND reason='corner_merge_conflict'`,
          [corner],
        )
      ).rowCount,
    ).toBe(2);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: newestHead,
      mergeability: 'other',
    });
    await operations.refreshStaleMergeability(corner);
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr.mergeability,
    ).toBe('other');
    const readsAfterSettlement = readPullRequest.mock.calls.length;
    await operations.refreshStaleMergeability(corner);
    // An addressed refresh also rechecks a settled verdict against live GitHub.
    expect(readPullRequest).toHaveBeenCalledTimes(readsAfterSettlement + 1);
    await operations.processWebhook('pull_request', {
      ...unknown,
      pull_request: {
        ...unknown.pull_request,
        head: { ...unknown.pull_request.head, sha: newestHead },
        mergeable_state: 'behind',
      },
    });
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr.mergeability,
    ).toBe('other');
    // The synchronize webhook verifies its check verdict against the live PR
    // even though the mergeability verdict was already settled, in addition
    // to the explicit addressed refresh above.
    expect(readPullRequest).toHaveBeenCalledTimes(readsAfterSettlement + 2);
    const newBaseSha = '4'.repeat(40);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: newestHead,
      baseSha: newBaseSha,
      mergeability: 'unknown',
    });
    const basePush = {
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      ref: 'refs/heads/main',
      after: newBaseSha,
    };
    await operations.processWebhook('push', basePush);
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { baseSha: string; mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr,
    ).toMatchObject({ baseSha: newBaseSha, mergeability: 'unknown' });
    const readsBeforeLatePush = readPullRequest.mock.calls.length;
    const delayedOldBaseSha = '6'.repeat(40);
    await operations.processWebhook('push', { ...basePush, after: delayedOldBaseSha });
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { baseSha: string; mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr,
    ).toMatchObject({ baseSha: newBaseSha, mergeability: 'unknown' });
    expect(readPullRequest).toHaveBeenCalledTimes(readsBeforeLatePush);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: newestHead,
      baseSha: newBaseSha,
      mergeability: 'unknown',
    });
    await operations.processWebhook('pull_request', {
      ...unknown,
      pull_request: {
        ...unknown.pull_request,
        head: { ...unknown.pull_request.head, sha: newestHead },
        mergeable_state: 'clean',
      },
    });
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr.mergeability,
    ).toBe('unknown');
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: newestHead,
      baseSha: '5'.repeat(40),
      mergeability: 'clean',
    });
    await operations.refreshStaleMergeability(corner);
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr.mergeability,
    ).toBe('unknown');
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: newestHead,
      baseSha: newBaseSha,
      mergeability: 'dirty',
    });
    await operations.refreshStaleMergeability(corner);
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr.mergeability,
    ).toBe('dirty');
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1
      AND reason='corner_merge_conflict'`,
          [corner],
        )
      ).rowCount,
    ).toBe(3);
    const readsAfterRecovery = readPullRequest.mock.calls.length;
    await operations.processWebhook('push', basePush);
    expect(readPullRequest).toHaveBeenCalledTimes(readsAfterRecovery);

    const raceHead = '9'.repeat(40);
    await operations.processWebhook('pull_request', {
      ...unknown,
      pull_request: {
        ...unknown.pull_request,
        head: { ...unknown.pull_request.head, sha: raceHead },
        base: { ref: 'main', sha: newBaseSha },
        mergeable_state: 'clean',
      },
    });
    const readBranchHead = app.readBranchHead as ReturnType<typeof vi.fn>;
    const selectedBase = '7'.repeat(40);
    const advancedBase = '8'.repeat(40);
    readBranchHead.mockResolvedValueOnce(selectedBase).mockResolvedValueOnce(advancedBase);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: raceHead,
      baseSha: advancedBase,
      mergeability: 'dirty',
    });
    await operations.processWebhook('push', { ...basePush, after: selectedBase });
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { baseSha: string; mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr,
    ).toMatchObject({ baseSha: advancedBase, mergeability: 'dirty' });
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1
      AND reason='corner_merge_conflict'`,
          [corner],
        )
      ).rowCount,
    ).toBe(4);

    let releaseOlderRead!: () => void;
    let olderReadStarted!: () => void;
    const olderRead = new Promise<void>((resolve) => {
      olderReadStarted = resolve;
    });
    const releaseOlder = new Promise<void>((resolve) => {
      releaseOlderRead = resolve;
    });
    const olderCandidate = 'a'.repeat(40);
    const newerCandidate = 'b'.repeat(40);
    readBranchHead
      .mockImplementationOnce(async () => {
        olderReadStarted();
        await releaseOlder;
        return olderCandidate;
      })
      .mockResolvedValueOnce(newerCandidate);
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: raceHead,
      baseSha: newerCandidate,
      mergeability: 'unknown',
    });
    const firstPush = operations.processWebhook('push', { ...basePush, after: olderCandidate });
    await olderRead;
    await otherServer.processWebhook('push', { ...basePush, after: newerCandidate });
    releaseOlderRead();
    await firstPush;
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { baseSha: string; mergeability: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle.pr,
    ).toMatchObject({ baseSha: newerCandidate, mergeability: 'unknown' });
    readPullRequest.mockResolvedValueOnce({
      number: 1,
      url: dirty.pull_request.html_url,
      headSha: raceHead,
      baseSha: newerCandidate,
      mergeability: 'dirty',
    });
    await operations.refreshStaleMergeability(corner);
    // The same head is already woken; a later live read against a newer base
    // does not add a second conflict wake for it.
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1
      AND reason='corner_merge_conflict'`,
          [corner],
        )
      ).rowCount,
    ).toBe(4);
  });
});
