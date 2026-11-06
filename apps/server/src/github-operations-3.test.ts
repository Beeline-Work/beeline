import { describe, expect, it, vi, generateKeyPair, exportPKCS8, GitHubAppClient, GitHubOAuthClient, seedCornerOpening, PgliteDatabase, insertCornerFacts, GitHubOperations, DaemonService, LiveHub, createServer, HUMAN, REVIEWER, fixtureScope1, type QueryResult, type QueryResultRow, type AddressInfo } from './test-support-github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();

  it('Reproduction MERGE-WEBHOOK-2: an edited event for another pull request cannot re-point the corner before its merge', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const branch = 'feature/corner-333333333333';
    const headSha = '3'.repeat(40);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,repository_remote,github_installation_id)
       VALUES($1,$2,$3,'General','https://github.com/owner/widgets.git',77)`,
      [room, workspace, HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'Two PRs')`,
      [corner, workspace, room, HUMAN],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: JSON.stringify({
          checks: 'passing',
          pr: {
            number: 100,
            url: 'https://github.com/owner/widgets/pull/100',
            headSha,
          },
        }) });
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readCommitCheckRollup: vi.fn(async () => ({
        state: 'passed',
        total: 1,
        failing: [],
        checks: [{ name: 'build', status: 'passed' }],
      })),
      branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false })),
      openPullRequestsForBranch: vi.fn(async () => []),
      deleteBranch: vi.fn(async () => undefined),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    // The corner's own PR #100 is still open; #200 merely shares its head branch.
    // An edit to #200 arrives first and must not replace the recorded #100.
    await operations.processWebhook('pull_request', {
      action: 'edited',
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      pull_request: {
        number: 200,
        title: 'Another PR',
        html_url: 'https://github.com/owner/widgets/pull/200',
        head: { ref: branch, sha: '2'.repeat(40) },
        base: { ref: 'main', sha: '4'.repeat(40) },
        mergeable_state: 'clean',
      },
    });
    await operations.processWebhook('pull_request', {
      action: 'closed',
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      pull_request: {
        number: 200,
        title: 'Another PR',
        html_url: 'https://github.com/owner/widgets/pull/200',
        head: { ref: branch, sha: '2'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-09-30T14:00:00Z',
        merge_commit_sha: 'f'.repeat(40),
        merged_by: { login: 'owner' },
      },
    });
    const cornerRow = (
      await scope1.database.query<{ archived_at: string | null }>(
        `SELECT archived_at FROM rooms WHERE id=$1`,
        [corner],
      )
    ).rows[0];
    const recorded = (
      await scope1.database.query<{ number: string | null }>(
        `SELECT lifecycle->'pr'->>'number' number FROM corner_facts WHERE corner_id=$1`,
        [corner],
      )
    ).rows[0];
    const mergedNotes = await scope1.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'verb'='merged'`,
      [corner],
    );
    console.info(
      `Reproduction MERGE-WEBHOOK-2: corner PR=#100 edited+merged webhook=#200 recorded=#${recorded?.number} archived=${cornerRow?.archived_at ?? 'no'} mergedNotes=${mergedNotes.rowCount}`,
    );
    expect(recorded).toMatchObject({ number: '100' });
    expect(cornerRow).toMatchObject({ archived_at: null });
    expect(mergedNotes.rowCount).toBe(0);
    expect(app.deleteBranch).not.toHaveBeenCalled();
  });

  it('Reproduction MERGE-WEBHOOK-3: a merge event cannot archive for a number recorded after its branch lookup', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const branch = 'feature/corner-333333333333';
    const headSha = '3'.repeat(40);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,repository_remote,github_installation_id)
       VALUES($1,$2,$3,'General','https://github.com/owner/widgets.git',77)`,
      [room, workspace, HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'Two PRs')`,
      [corner, workspace, room, HUMAN],
    );
    // The corner starts with a branch but no pull association, so #200's
    // branch lookup matches it with no recorded number.
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: JSON.stringify({ checks: 'passing' }) });
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readCommitCheckRollup: vi.fn(async () => ({
        state: 'passed',
        total: 1,
        failing: [],
        checks: [{ name: 'build', status: 'passed' }],
      })),
      branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false })),
      openPullRequestsForBranch: vi.fn(async () => []),
      deleteBranch: vi.fn(async () => undefined),
    } as unknown as GitHubAppClient;
    // #100 is recorded after #200's branch lookup returns, but before
    // mergeCorner's locked transaction reads the association.
    const real = scope1.database as PgliteDatabase;
    let recorded = false;
    class RaceDatabase extends PgliteDatabase {
      override async query<Row extends QueryResultRow = QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ): Promise<QueryResult<Row>> {
        const result = await super.query<Row>(sql, values);
        if (!recorded && sql.includes(`fact.lifecycle->'pr'->>'number' pr_number`)) {
          recorded = true;
          await super.query(
            `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr}',$2::jsonb)
             WHERE corner_id=$1`,
            [
              corner,
              JSON.stringify({
                number: 100,
                url: 'https://github.com/owner/widgets/pull/100',
                headSha,
              }),
            ],
          );
        }
        return result;
      }
    }
    const raced = new RaceDatabase(real.client);
    const operations = new GitHubOperations(raced, {} as GitHubOAuthClient, app, 'secret');
    await operations.processWebhook('pull_request', {
      action: 'closed',
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      pull_request: {
        number: 200,
        title: 'Another PR',
        html_url: 'https://github.com/owner/widgets/pull/200',
        head: { ref: branch, sha: '2'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-09-30T14:00:00Z',
        merge_commit_sha: 'f'.repeat(40),
        merged_by: { login: 'owner' },
      },
    });
    const cornerRow = (
      await scope1.database.query<{ archived_at: string | null }>(
        `SELECT archived_at FROM rooms WHERE id=$1`,
        [corner],
      )
    ).rows[0];
    const recordedNumber = (
      await scope1.database.query<{ number: string | null }>(
        `SELECT lifecycle->'pr'->>'number' number FROM corner_facts WHERE corner_id=$1`,
        [corner],
      )
    ).rows[0];
    const mergedNotes = await scope1.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'verb'='merged'`,
      [corner],
    );
    console.info(
      `Reproduction MERGE-WEBHOOK-3: lookup-miss then recorded#100 merged webhook=#200 recorded=#${recordedNumber?.number} archived=${cornerRow?.archived_at ?? 'no'} mergedNotes=${mergedNotes.rowCount}`,
    );
    expect(recordedNumber).toMatchObject({ number: '100' });
    expect(cornerRow).toMatchObject({ archived_at: null });
    expect(mergedNotes.rowCount).toBe(0);
    expect(app.deleteBranch).not.toHaveBeenCalled();
  });

  it('matches checks on the derived branch when a PR is already associated', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const branch = 'feature/corner-333333333333';
    const headSha = '3'.repeat(40);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,repository_remote,github_installation_id)
       VALUES($1,$2,$3,'General','https://github.com/owner/widgets.git',77)`,
      [room, workspace, HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'Promoted')`,
      [corner, workspace, room, HUMAN],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: JSON.stringify({
          checks: 'unknown',
          pr: {
            number: 9,
            url: 'https://github.com/owner/widgets/pull/9',
            headSha,
          },
        }) });
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readCommitCheckRollup: vi.fn(async () => ({
        state: 'passed',
        total: 1,
        failing: [],
        checks: [{ name: 'build', status: 'passed' }],
      })),
      readPullRequest: vi.fn(async () => ({ number: 9, headSha })),
      openPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');

    await operations.processWebhook('check_run', {
      action: 'completed',
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      check_run: {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        head_sha: headSha,
        check_suite: { head_branch: branch, head_sha: headSha },
      },
    });

    expect(
      (
        await scope1.database.query<{ lifecycle: object }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0],
    ).toMatchObject({
      lifecycle: { checks: 'passing' },
    });
    // Checks on an associated PR need no branch-to-PR discovery.
    expect(app.openPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it('an explicit check command recovers a missed merge webhook and ignores branch deletion pushes', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const headSha = '1'.repeat(40);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`,
      [workspace],
    );
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,repository_remote,github_installation_id)
       VALUES($1,$2,$3,'General','https://github.com/owner/widgets.git',77)`,
      [room, workspace, HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'Recovery')`,
      [corner, workspace, room, HUMAN],
    );
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [workspace, HUMAN, room],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: JSON.stringify({
          lifecycle: 'in-review',
          checks: 'failing',
          pr: {
            number: 42,
            url: 'https://github.com/owner/widgets/pull/42',
            title: 'Recover missed merge',
            targetBranch: 'main',
            headSha,
            mergeability: 'clean',
          },
        }) });
    await seedCornerOpening(scope1.database, { cornerId: corner, commissionedBy: HUMAN });
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readPullRequest: vi.fn(async () => ({
        number: 42,
        url: 'https://github.com/owner/widgets/pull/42',
        headSha,
        headRef: 'feature/corner-333333333333',
        baseRef: 'main',
        title: 'Recover missed merge',
        merged: false,
        mergeability: 'clean',
      })),
      readCommitCheckRollup: vi.fn(async () => ({ state: 'failed', total: 1, failing: ['lint'], checks: [{ name: 'lint', status: 'failed' }] })),
      branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false })),
      openPullRequestsForBranch: vi.fn(async () => []),
      deleteBranch: vi.fn(async () => undefined),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(
      scope1.database,
      {} as GitHubOAuthClient,
      app,
      'secret',
    );
    // A reviewer approved an earlier head; the merged head is a different one.
    await scope1.database.query(
      `INSERT INTO corner_merge_approvals(corner_id,approved_by,head_sha,pull_request_number)
       VALUES($1,$2,$3,42)`,
      [corner, HUMAN, '9'.repeat(40)],
    );
    const deletedPush = {
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      ref: 'refs/heads/feature/corner-333333333333',
      after: '0'.repeat(40),
      deleted: true,
    };
    await operations.processWebhook('push', deletedPush);
    expect(
      (
        await scope1.database.query<{ lifecycle: { pr: { headSha: string }; checks: string } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle,
    ).toMatchObject({ checks: 'failing', pr: { headSha } });
    expect(
      (await scope1.database.query(`SELECT 1 FROM messages WHERE room_id=$1`, [corner])).rowCount,
    ).toBe(0);

    await operations.prChecksStatus({ cornerId: corner, pullRequest: 42 });
    expect(
      (await scope1.database.query(`SELECT archived_at FROM rooms WHERE id=$1`, [corner])).rows[0],
    ).toMatchObject({ archived_at: null });
    (app.readPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 42,
      url: 'https://github.com/owner/widgets/pull/42',
      headSha,
      headRef: 'feature/corner-333333333333',
      baseRef: 'main',
      title: 'Recover missed merge',
      merged: true,
      mergedAt: '2026-09-24T12:00:00Z',
      mergeCommitSha: 'f'.repeat(40),
      mergedBy: 'owner',
      mergeability: 'unknown',
    });
    await operations.prChecksStatus({ cornerId: corner, pullRequest: 42 });
    await operations.prChecksStatus({ cornerId: corner, pullRequest: 42 });
    expect(
      (
        await scope1.database.query<{ lifecycle: { outcome: string; pr: { mergeCommitSha: string } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner],
        )
      ).rows[0]?.lifecycle,
    ).toMatchObject({ outcome: 'landed', pr: { mergeCommitSha: 'f'.repeat(40) } });
    expect(
      (
        await scope1.database.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [
          corner,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await scope1.database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='daemon-fact'`,
          [room],
        )
      ).rowCount,
    ).toBe(0);
    expect((await scope1.database.query(`SELECT card FROM messages WHERE room_id=$1 AND card_type='github-event'`, [room])).rows)
      .toEqual([expect.objectContaining({ card: expect.objectContaining({ action: 'merged', cornerId: corner }) })]);
    expect(app.deleteBranch).toHaveBeenCalledTimes(1);
    // A merge no longer queues a hidden memory-review job.
    expect(
      (await scope1.database.query(`SELECT 1 FROM institutional_memory_jobs`)).rowCount,
    ).toBe(0);
  });

  it('mints a token only for the exact active repository bound to a top-level Room', async () => {
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
       VALUES(101,77,'owner/widgets','main'),(102,77,'owner/other','main')`,
    );
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,github_installation_id)
       VALUES($1,$2,'General','owner/widgets','https://github.com/owner/widgets.git','repository',77)`,
      [room, workspace],
    );
    const app = {
      installationToken: vi.fn(async () => ({
        token: 'scoped-token',
        expiresAt: '2030-01-01T00:00:00Z',
      })),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    await expect(operations.roomToken(room)).resolves.toMatchObject({ token: 'scoped-token' });
    expect(app.installationToken).toHaveBeenCalledWith(77, { repositoryIds: [101] });
    await scope1.database.query(
      `UPDATE rooms SET repository_remote='https://github.com/owner/missing.git' WHERE id=$1`,
      [room],
    );
    await expect(operations.roomToken(room)).rejects.toThrow(
      'GitHub repository installation not found',
    );
    expect(app.installationToken).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed room token mints and shares concurrent failures', async () => {
    const { room } = await scope1.checksFixture();
    let fail!: (error: Error) => void;
    const mint = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ token: 'recovered', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      { installationToken: mint } as unknown as GitHubAppClient, 'secret');
    const requests = Array.from({ length: 5 }, () => operations.roomToken(room));
    const results = Promise.allSettled(requests);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    // Let all database lookups reach the pending mint before rejecting it.
    await scope1.database.query('SELECT 1');
    fail(new Error('mint failed'));
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(mint).toHaveBeenCalledTimes(1);
    await expect(operations.roomToken(room)).resolves.toMatchObject({ token: 'recovered' });
    expect(mint).toHaveBeenCalledTimes(2);
  });


  it('keys room token reuse by installation and repository and evicts stale entries', async () => {
    const { room } = await scope1.checksFixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const mint = vi.fn(async () => ({ token: 'scoped', expiresAt: new Date(now + 3_600_000).toISOString() }));
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
        { installationToken: mint } as unknown as GitHubAppClient, 'secret');
      await operations.roomToken(room);
      await scope1.database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
        VALUES(102,77,'owner/other','main')`);
      await scope1.database.query(`UPDATE rooms SET repository_remote='https://github.com/owner/other.git' WHERE id=$1`, [room]);
      await operations.roomToken(room);
      expect(mint).toHaveBeenLastCalledWith(77, { repositoryIds: [102] });
      await scope1.database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
        VALUES(78,$1,'43','other','User','selected','active')`, [HUMAN]);
      await scope1.database.query(`UPDATE github_repositories SET installation_id=78 WHERE repository_id=102`);
      await scope1.database.query(`UPDATE rooms SET github_installation_id=78 WHERE id=$1`, [room]);
      await operations.roomToken(room);
      expect(mint).toHaveBeenLastCalledWith(78, { repositoryIds: [102] });
      expect(mint).toHaveBeenCalledTimes(3);
      now += 3_600_000;
      await operations.roomToken(room);
      await scope1.database.query(`UPDATE github_repositories SET installation_id=77 WHERE repository_id=102`);
      await scope1.database.query(`UPDATE rooms SET github_installation_id=77 WHERE id=$1`, [room]);
      await operations.roomToken(room);
      expect(mint).toHaveBeenCalledTimes(5);
    } finally {
      clock.mockRestore();
    }
  });


  it.each([
    `UPDATE github_installations SET status='suspended' WHERE installation_id=77`,
    `UPDATE rooms SET archived_at=now() WHERE parent_id IS NULL`,
    `UPDATE github_repositories SET active=false WHERE repository_id=101`,
  ])('rechecks access before returning a cached room token: %s', async (revoke) => {
    const { room } = await scope1.checksFixture();
    const mint = vi.fn(async () => ({ token: 'scoped', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      { installationToken: mint } as unknown as GitHubAppClient, 'secret');
    await operations.roomToken(room);
    await scope1.database.query(revoke);
    await expect(operations.roomToken(room)).rejects.toThrow('GitHub repository installation not found');
    expect(mint).toHaveBeenCalledTimes(1);
  });


  it.each([
    ['installation', { action: 'new_permissions_accepted', installation: { id: 77 } }],
    ['installation_repositories', { action: 'added', installation: { id: 77 } }],
  ] as const)('TOKEN-PERM-1: a %s webhook mints the next room token and leaves another installation cached', async (event, payload) => {
    const { room } = await scope1.checksFixture();
    const otherRoom = '44444444-4444-4444-8444-444444444444';
    await scope1.database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(78,$1,'43','other','User','selected','active')`, [HUMAN]);
    await scope1.database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(201,78,'other/widgets','main')`);
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,
      repository_resolution,github_installation_id,reviewer_agent_id)
      VALUES($1,'11111111-1111-4111-8111-111111111111',$2,'Other','other/widgets','https://github.com/other/widgets.git','repository',78,$3)`,
    [otherRoom, HUMAN, REVIEWER]);
    let n = 0;
    const mint = vi.fn(async (installationId: number, scope: { repositoryIds: number[] }) => ({
      token: `token-${installationId}-${scope.repositoryIds[0]}-${++n}`,
      expiresAt: '2030-01-01T00:00:00Z',
    }));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, {
      installationToken: mint,
      installationAccount: async () => ({
        id: '42', login: 'owner', type: 'User' as const, repositorySelection: 'selected' as const,
      }),
      listRepositories: async () => [{
        id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch: 'main',
        private: false, allowAutoMerge: false,
      }],
    } as unknown as GitHubAppClient, 'secret');

    const first = await operations.roomToken(room);
    expect(await operations.roomToken(room)).toEqual(first);
    const other = await operations.roomToken(otherRoom);
    expect(mint).toHaveBeenCalledTimes(2);
    await operations.processWebhook(event, payload);
    await expect(operations.roomToken(room)).resolves.toMatchObject({ token: 'token-77-101-3' });
    expect(await operations.roomToken(otherRoom)).toEqual(other);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(mint).toHaveBeenNthCalledWith(1, 77, { repositoryIds: [101] });
    expect(mint).toHaveBeenNthCalledWith(2, 78, { repositoryIds: [201] });
    expect(mint).toHaveBeenNthCalledWith(3, 77, { repositoryIds: [101] });
  });


  it('TOKEN-PERM-1: a room token minted before new permissions were accepted is not cached', async () => {
    const { room } = await scope1.checksFixture();
    let releaseFirst!: (value: { token: string; expiresAt: string }) => void;
    let releaseSecond!: (value: { token: string; expiresAt: string }) => void;
    const mint = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }))
      .mockResolvedValue({ token: 'unexpected', expiresAt: '2030-01-01T00:00:00Z' });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, {
      installationToken: mint,
      installationAccount: async () => ({
        id: '42', login: 'owner', type: 'User' as const, repositorySelection: 'selected' as const,
      }),
      listRepositories: async () => [{
        id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch: 'main',
        private: false, allowAutoMerge: false,
      }],
    } as unknown as GitHubAppClient, 'secret');

    const first = operations.roomToken(room);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    await operations.processWebhook('installation', {
      action: 'new_permissions_accepted', installation: { id: 77 },
    });
    const second = operations.roomToken(room);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    releaseSecond({ token: 'fresh', expiresAt: '2030-01-01T00:00:00Z' });
    await expect(second).resolves.toMatchObject({ token: 'fresh' });
    releaseFirst({ token: 'stale', expiresAt: '2030-01-01T00:00:00Z' });
    await expect(first).resolves.toMatchObject({ token: 'stale' });
    await expect(operations.roomToken(room)).resolves.toMatchObject({ token: 'fresh' });
    expect(mint).toHaveBeenCalledTimes(2);
  });


  it('TOKEN-PERM-1: an older mint resolving does not drop the replacement mint still in flight', async () => {
    const { room } = await scope1.checksFixture();
    let releaseFirst!: (value: { token: string; expiresAt: string }) => void;
    let releaseSecond!: (value: { token: string; expiresAt: string }) => void;
    const mint = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseSecond = resolve; }))
      .mockResolvedValue({ token: 'unexpected', expiresAt: '2030-01-01T00:00:00Z' });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, {
      installationToken: mint,
      installationAccount: async () => ({
        id: '42', login: 'owner', type: 'User' as const, repositorySelection: 'selected' as const,
      }),
      listRepositories: async () => [{
        id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch: 'main',
        private: false, allowAutoMerge: false,
      }],
    } as unknown as GitHubAppClient, 'secret');

    const first = operations.roomToken(room);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    await operations.processWebhook('installation', {
      action: 'new_permissions_accepted', installation: { id: 77 },
    });
    const second = operations.roomToken(room);
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    releaseFirst({ token: 'stale', expiresAt: '2030-01-01T00:00:00Z' });
    await expect(first).resolves.toMatchObject({ token: 'stale' });
    const query = scope1.database.query.bind(scope1.database);
    let roomLookups = 0;
    const spy = vi.spyOn(scope1.database, 'query').mockImplementation(async (sql, values) => {
      const result = await query(sql, values);
      if (typeof sql === 'string' && sql.includes('github_installation_id,g.repository_id')) roomLookups++;
      return result;
    });
    try {
      const third = operations.roomToken(room);
      await vi.waitFor(() => expect(roomLookups).toBe(1));
      expect(mint).toHaveBeenCalledTimes(2);
      releaseSecond({ token: 'fresh', expiresAt: '2030-01-01T00:00:00Z' });
      await expect(second).resolves.toMatchObject({ token: 'fresh' });
      await expect(third).resolves.toMatchObject({ token: 'fresh' });
    } finally {
      spy.mockRestore();
    }
    await expect(operations.roomToken(room)).resolves.toMatchObject({ token: 'fresh' });
    expect(mint).toHaveBeenCalledTimes(2);
  });


  it('reuse-room-token: reuses scoped tokens through the daemon and refreshes at five minutes', async () => {
    const { room } = await scope1.checksFixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let mints = 0;
    const scopes: unknown[] = [];
    const endpoint = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      scopes.push(JSON.parse(body));
      mints++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ token: `fake-token-${mints}`, expires_at: new Date(now + 3_600_000).toISOString() }));
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    try {
      const { privateKey } = await generateKeyPair('RS256');
      const app = new GitHubAppClient({ appId: '1', slug: 'test', privateKey: await exportPKCS8(privateKey),
        apiBaseUrl: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}` });
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
      const daemon = new DaemonService(scope1.database, new LiveHub(), (id) => operations.roomToken(id));
      const request = () => daemon.execute('getRoomGitHubToken', { roomId: room }, REVIEWER);
      for (let index = 0; index < 10; index++) await request();
      await Promise.all(Array.from({ length: 5 }, request));
      expect(mints).toBe(1);
      now += 55 * 60_000 - 1;
      await request();
      expect(mints).toBe(1);
      now++;
      await Promise.all(Array.from({ length: 5 }, request));
      expect(mints).toBe(2);
      expect(scopes).toEqual([{ repository_ids: [101] }, { repository_ids: [101] }]);
      await scope1.database.query(`UPDATE github_repositories SET active=false WHERE repository_id=101`);
      await expect(request()).rejects.toThrow('Room repository access needs the Beeline GitHub App');
      expect(mints).toBe(2);
    } finally {
      clock.mockRestore();
      await new Promise<void>((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve()));
    }
  });


  it.each(['installation', 'repository', 'removal'])('INSTALL-SYNC-1: returns a deadlock at %s and completes sync only on a new event', async boundary => {
    await scope1.database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN]);
    await scope1.database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(102,77,'owner/removed','main')`);
    const app = {
      installationAccount: vi.fn(async () => ({ id: '42', login: 'owner', type: 'User', repositorySelection: 'selected' })),
      listRepositories: vi.fn(async () => [{ id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch: 'main', private: false, allowAutoMerge: false }]),
    };
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const query = scope1.database.query.bind(scope1.database);
    let attempts = 0;
    vi.spyOn(scope1.database, 'query').mockImplementation(async (sql, values) => {
      const target = boundary === 'installation' ? sql.startsWith('INSERT INTO github_installations(')
        : boundary === 'repository' ? sql.startsWith('INSERT INTO github_repositories(')
        : sql.includes('NOT (repository_id=ANY');
      if (target && ++attempts === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return query(sql, values);
    });
    await expect(operations.processWebhook('installation', { action: 'created', installation: { id: 77 } })).rejects.toMatchObject({ code: '40P01' });
    expect(attempts).toBe(1);
    await operations.processWebhook('installation', { action: 'created', installation: { id: 77 } });
    expect(attempts).toBe(2);
    expect(app.listRepositories).toHaveBeenCalledTimes(boundary === 'installation' ? 1 : 2);
    expect((await query(`SELECT repository_id,active FROM github_repositories ORDER BY repository_id`)).rows)
      .toEqual([{ repository_id: 101, active: true }, { repository_id: 102, active: false }]);
  });


  it.each([['40P01', 1], ['23505', 1]] as const)('INSTALL-SYNC-1: surfaces %s after one attempt', async (code, expected) => {
    await scope1.database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN]);
    const app = { installationAccount: async () => ({ id: '42', login: 'owner', type: 'User', repositorySelection: 'selected' }), listRepositories: vi.fn() };
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const query = scope1.database.query.bind(scope1.database);
    const failure = Object.assign(new Error('database failure'), { code });
    let attempts = 0;
    vi.spyOn(scope1.database, 'query').mockImplementation(async (sql, values) => {
      if (sql.startsWith('INSERT INTO github_installations(')) { attempts++; throw failure; }
      return query(sql, values);
    });
    await expect(operations.processWebhook('installation', { action: 'created', installation: { id: 77 } })).rejects.toBe(failure);
    expect(attempts).toBe(expected);
    expect(app.listRepositories).not.toHaveBeenCalled();
  });


  it.each(['installation', 'repository', 'removal'])('INSTALL-SYNC-1: propagates %s deadlock out of the installation callback transaction', async boundary => {
    const { operations, installState } = await scope1.boundInstallationOperations(scope1.orgInstallationApp('allow'));
    const transaction = scope1.database.transaction.bind(scope1.database);
    const failure = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    let attempts = 0;
    vi.spyOn(scope1.database, 'transaction').mockImplementation(work => transaction(async tx => {
      const query = tx.query.bind(tx);
      tx.query = async (sql, values) => {
        const target = boundary === 'installation' ? sql.startsWith('INSERT INTO github_installations(')
          : boundary === 'repository' ? sql.startsWith('INSERT INTO github_repositories(')
          : sql.includes('NOT (repository_id=ANY');
        if (target) { attempts++; throw failure; }
        return query(sql, values);
      };
      return work(tx);
    }));
    await expect(operations.completeInstallation(installState, 78)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect((await scope1.database.query(`SELECT * FROM github_installations`)).rows).toEqual([]);
    expect((await scope1.database.query(`SELECT * FROM github_repositories`)).rows).toEqual([]);
    expect((await scope1.database.query(`SELECT consumed_at FROM github_auth_flows WHERE purpose='installation'`)).rows)
      .toEqual([{ consumed_at: null }]);
  });
});
