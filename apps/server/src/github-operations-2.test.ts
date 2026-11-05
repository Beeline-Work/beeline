import { describe, expect, it, vi, GitHubAppClient, GitHubOAuthClient, insertCornerFacts, setCornerOwner, GitHubOperations, cornerFactsSql, cornerRowState, HUMAN, fixtureScope1, type SqlDatabase, type CornerStateRow } from './github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();


  it('shows a pushed PR head as Review until GitHub reports its checks', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    const newHead = '2'.repeat(40);
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const rowState = async () => {
      const facts = cornerFactsSql('NULL::text');
      const row = (await scope1.database.query<CornerStateRow>(
        `SELECT c.id,c.archived_at,${facts.columns} FROM rooms c ${facts.joins} WHERE c.id=$1`, [corner],
      )).rows[0]!;
      return cornerRowState(row).state;
    };
    expect(await rowState()).toBe('idle');
    await operations.processWebhook('push', {
      installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      ref: 'refs/heads/feature/corner-333333330001', after: newHead, size: 1,
    });
    expect(await rowState()).toBe('review');

    // A completed fetch that finds no checks keeps the corner idle.
    app.readPullRequest.mockResolvedValue({ number: 1, headSha: newHead,
      url: 'https://github.com/owner/widgets/pull/1', mergeability: 'clean' });
    app.readCommitCheckRollup.mockResolvedValueOnce({ state: 'passed', total: 0, failing: [], checks: [] });
    const check = { ...payload.check_run, head_sha: newHead,
      check_suite: { head_branch: 'feature/corner-333333330001', head_sha: newHead } };
    await operations.processWebhook('check_run', { ...payload, check_run: check });
    expect((await scope1.database.query<{ lifecycle: { checksSummary: unknown } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner],
    )).rows[0]!.lifecycle.checksSummary).toMatchObject({ status: 'unknown', total: 0 });
    expect(await rowState()).toBe('idle');
  });


  it('does not wake on a superseded head when its completed suite arrives before push and synchronize', async () => {
    const { corners, headSha: oldHead, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    const newHead = '2'.repeat(40);
    // GitHub has accepted the push, but its push/synchronize webhooks are still queued.
    app.readPullRequest.mockResolvedValue({
      number: 1, headSha: newHead, url: 'https://github.com/owner/widgets/pull/1',
      mergeability: 'clean',
    });
    app.readCommitCheckRollup.mockImplementation(async (_token, _repository, sha) =>
      sha === oldHead
        ? { state: 'pending', total: 2, failing: ['typecheck'], checks: [
          { name: 'typecheck', status: 'failed' }, { name: 'desktop', status: 'pending' },
        ] }
        : { state: 'passed', total: 1, failing: [], checks: [{ name: 'typecheck', status: 'passed' }] },
    );
    const operations = new GitHubOperations(
      scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret',
    );
    const oldSuite = {
      ...payload,
      check_suite: {
        head_branch: 'feature/corner-333333330001', head_sha: oldHead,
        status: 'completed', conclusion: 'failure',
      },
    };
    await operations.processWebhook('check_suite', oldSuite);
    expect((await scope1.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-failed'`,
      [corner],
    )).rowCount).toBe(0);
    expect((await scope1.database.query(
      `SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_check'`,
      [corner],
    )).rowCount).toBe(0);

    await operations.processWebhook('push', {
      installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      ref: 'refs/heads/feature/corner-333333330001', after: newHead,
    });
    await operations.processWebhook('pull_request', {
      action: 'synchronize', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      pull_request: {
        number: 1, title: 'Fix checks', html_url: 'https://github.com/owner/widgets/pull/1',
        head: { ref: 'feature/corner-333333330001', sha: newHead }, base: { ref: 'main' },
        mergeable_state: 'clean', merged: false,
      },
    });
    await operations.processWebhook('check_suite', oldSuite);
    expect((await scope1.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-failed'`,
      [corner],
    )).rowCount).toBe(0);
    expect((await scope1.database.query<{ lifecycle: { pr: { headSha: string }; checks: string } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner],
    )).rows[0]?.lifecycle).toMatchObject({ pr: { headSha: newHead }, checks: 'passing' });
    expect((await scope1.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-passed'`,
      [corner],
    )).rowCount).toBe(1);
  });


  it('B3: records no started or individual passed notes while retaining the green rollup', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    app.readCommitCheckRollup.mockResolvedValue({ state: 'pending', total: 2, failing: [], checks: [
      { name: 'tests', status: 'passed' }, { name: 'lint', status: 'pending' },
    ] });
    await operations.processWebhook('check_run', { ...payload, action: 'in_progress',
      check_run: { ...payload.check_run, status: 'in_progress', conclusion: null } });
    await operations.processWebhook('check_run', payload);
    expect((await scope1.database.query(`SELECT text FROM messages WHERE room_id=$1 AND card_type='github-corner-note'`, [corners[0]])).rows).toHaveLength(0);
    app.readCommitCheckRollup.mockResolvedValue({ state: 'passed', total: 2, failing: [], checks: [
      { name: 'tests', status: 'passed' }, { name: 'lint', status: 'passed' },
    ] });
    await operations.processWebhook('check_run', payload);
    expect((await scope1.database.query(`SELECT card,system_event->>'kind' kind FROM messages WHERE room_id=$1 AND card_type='github-corner-note'`, [corners[0]])).rows)
      .toEqual([{ card: null, kind: 'check-passed' }]);
  });


  it('gives a check suite a browser card URL even when GitHub sends only its API URL', async () => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"unknown"') WHERE corner_id=$1`, [corners[0]]);
    await operations.processWebhook('check_suite', {
      ...payload,
      check_suite: {
        id: 42, status: 'completed', conclusion: 'success', head_branch: 'feature/corner-333333330001',
        head_sha: headSha, app: { name: 'GitHub Actions' },
        url: 'https://api.github.com/repos/owner/widgets/check-suites/42',
      },
    });
    const row = (await scope1.database.query<{ card_type: string; card: { source: string }; system_event: { object: { url: string } } }>(
      `SELECT card_type,card,system_event FROM messages WHERE room_id=$1 AND text='@GitHub passed a check GitHub Actions check suite'`,
      [corners[0]],
    )).rows[0];
    expect(row).toMatchObject({
      card_type: 'github-corner-note',
      card: null,
      system_event: { object: { url: `https://github.com/owner/widgets/commit/${headSha}/checks` } },
    });
  });


  it.each([4, 5])('Reproduction F1-%s: push/open records checks without another event', async n => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"unknown"') WHERE corner_id=$1`, [corners[0]]);
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (new Error().stack?.includes('@electric-sql/pglite') ? 0 : 86_400_000));
    try {
      if (n === 4) {
        await operations.processWebhook('push', { ...payload, ref: 'refs/heads/feature/corner-333333330001', after: headSha, size: 1 });
        await operations.processWebhook('check_run', payload);
      } else {
        for (const action of ['opened', 'synchronize']) {
          await operations.processWebhook('pull_request', { ...payload, action, pull_request: {
            number: 1, html_url: 'https://github.com/owner/widgets/pull/1', title: 'Checks',
            head: { ref: 'feature/corner-333333330001', sha: headSha }, base: { ref: 'main' }, mergeable_state: 'clean',
          } });
        }
      }
      const state = (await scope1.database.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [corners[0]])).rows[0]!.checks;
      console.info(`Reproduction F1-${n}: wrong=unknown; right=passing; observed=${state}`);
      expect(state).toBe('passing');
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(n === 4 ? 1 : 2);
      if (n === 5) {
        app.readCommitCheckRollup.mockResolvedValueOnce({ state: 'pending', total: 0, failing: [], checks: [] });
        await operations.processWebhook('pull_request', { ...payload, action: 'opened', pull_request: { number: 1, html_url: 'https://github.com/owner/widgets/pull/1', title: 'Checks', head: { ref: 'feature/corner-333333330001', sha: headSha }, base: { ref: 'main' }, mergeable_state: 'clean' } });
        const opened = (await scope1.database.query<{ checks: string; status: string }>(`SELECT lifecycle->>'checks' checks,lifecycle->'checksSummary'->>'status' status FROM corner_facts WHERE corner_id=$1`, [corners[0]])).rows[0]!;
        console.info(`Reproduction CI-1: wrong=unknown (no tests configured); right=pending (tests running); observed=${opened.checks}`);
        expect(opened).toEqual({ checks: 'pending', status: 'pending' });
        await operations.processWebhook('check_run', payload);
        expect((await scope1.database.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [corners[0]])).rows[0]!.checks).toBe('passing');
      }
    } finally { clock.mockRestore(); }
  });


  it('Reproduction REVIEW-LOOP: checks expose an ended review without claiming a verdict', async () => {
    const {corners,app}=await scope1.checksFixture();
    const operations=new GitHubOperations(scope1.database,{} as GitHubOAuthClient,app as unknown as GitHubAppClient,'secret');
    await setCornerOwner(scope1.database, corners[0]!, null);
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"unknown"') WHERE corner_id=$1`,[corners[0]]);
    expect((await operations.prChecksStatus({cornerId:corners[0]!})).reviewerWake.status).toBe('dispatched');
    await scope1.database.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1`,[corners[0]]);
    await scope1.database.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`,[corners[0]]);
    expect((await operations.prChecksStatus({cornerId:corners[0]!})).reviewerWake).toMatchObject({
      status:'waiting',detail:expect.stringContaining('without a verdict'),
    });
  });


  it('Reproduction F1-6: live verdict and dispatch remain separate, with no self-review special case', async () => {
    const { corners, app } = await scope1.checksFixture();
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const self = await operations.prChecksStatus({ cornerId: corners[0]! });
    // The server no longer treats a reviewer that is also this corner's
    // opener as a special case: it waits for dispatch exactly like any
    // other configured reviewer, with no replacement gate.
    console.info(`Reproduction F1-6: wrong=not_required self-review special case; right=waiting; observed=${self.reviewerWake.status}`);
    expect(self.reviewerWake.status).toBe('waiting');
    expect(self).not.toHaveProperty('rule');
    expect(self).not.toHaveProperty('reviewerIsAuthor');
    await setCornerOwner(scope1.database, corners[0]!, null);
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"unknown"') WHERE corner_id=$1`, [corners[0]]);
    const result = await operations.prChecksStatus({ cornerId: corners[0]! });
    // Repairing the unknown snapshot commits the green transition; the wake
    // reports the resulting dispatch, without a self-review special case.
    expect(result).toMatchObject({ stage: 'waiting_for_yes', checks: 'passed', reviewerWake: { status: 'dispatched' } });
    expect(result).not.toHaveProperty('recordedChecks');
  });


  it('Reproduction S08-1: check webhook fetches without an open transaction', async () => {
    const { app, payload } = await scope1.checksFixture();
    let depth = 0;
    const depths: number[] = [];
    const guarded: SqlDatabase = {
      query: scope1.database.query.bind(scope1.database),
      transaction: work => scope1.database.transaction(async tx => {
        depth++;
        try { return await work(tx); } finally { depth--; }
      }),
    };
    let started!: () => void, release!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    app.installationToken.mockImplementation(async () => {
      depths.push(depth);
      return { token: 'room-token', expiresAt: '2030-01-01T00:00:00Z' };
    });
    app.readCommitCheckRollup.mockImplementation(async () => {
      depths.push(depth); started(); await pending;
      return { state: 'passed', total: 1, failing: [], checks: [] };
    });
    const operations = new GitHubOperations(guarded, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const delivery = operations.processWebhook('check_run', payload);
    await fetching;
    try { expect(depths).toEqual([0, 0]); }
    finally { release(); await delivery; }
    console.log('Demonstrated S08-1: check_run webhook => token and held rollup fetch at transaction depth 0.');
  });


  it.each(['moved', 'missing'])('discards a check fetch when the recorded head is %s', async kind => {
    const { app, payload, corners } = await scope1.checksFixture();
    let started!: () => void, release!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    app.readCommitCheckRollup.mockImplementation(async () => {
      started(); await pending;
      return { state: 'failed', total: 1, failing: ['lint'], checks: [] };
    });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    // Another server can move the head while this instance awaits GitHub.
    const otherServer = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    const delivery = operations.processWebhook('check_run', payload);
    await fetching;
    try {
      if (kind === 'moved') await otherServer.processWebhook('push', {
        installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
        ref: 'refs/heads/feature/corner-333333330001', after: '2'.repeat(40), commits: [],
      });
      else await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'pr' WHERE corner_id=$1`, [corners[0]]);
      const before = await scope1.database.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]]);
      const messages = await scope1.database.query(`SELECT id FROM messages WHERE room_id=$1 ORDER BY id`, [corners[0]]);
      release(); await delivery;
      expect((await scope1.database.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]])).rows).toEqual(before.rows);
      expect((await scope1.database.query(`SELECT id FROM messages WHERE room_id=$1 ORDER BY id`, [corners[0]])).rows).toEqual(messages.rows);
    } finally { release(); await delivery; }
  });


  it('BRANCH-DERIVED: routes PR, push and checks with NULL stored branch and refuses an ambiguous prefix', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const branch = 'feature/corner-' + corner.replaceAll('-', '').slice(0, 12);
    const headSha = '1'.repeat(40);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN],
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
       VALUES($1,$2,$3,$4,'Promoted')`, [corner, workspace, room, HUMAN],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: '{"checks":"unknown"}' });
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readCommitCheckRollup: vi.fn(async () => ({
        state: 'passed', total: 1, failing: [], checks: [{ name: 'build', status: 'passed' }],
      })),
      readPullRequest: vi.fn(async () => ({
        number: 4, url: 'https://github.com/owner/widgets/pull/4', headSha,
        headRef: branch, baseRef: 'main', mergeability: 'clean', merged: false,
      })),
      readBranchHead: vi.fn(async () => headSha),
      openPullRequestsForBranch: vi.fn(async () => [4]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    await operations.processWebhook('pull_request', {
      action: 'opened', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      pull_request: {
        number: 4, title: 'Promoted work', html_url: 'https://github.com/owner/widgets/pull/4',
        head: { ref: branch, sha: headSha }, base: { ref: 'main', sha: '2'.repeat(40) },
        mergeable_state: 'clean',
      },
    });
    await operations.processWebhook('check_run', {
      action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      check_run: {
        name: 'build', status: 'completed', conclusion: 'success', head_sha: headSha,
        check_suite: { head_branch: branch, head_sha: headSha },
      },
    });
    const fact = (await scope1.database.query<{ lifecycle: object }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner],
    )).rows[0]!;
    expect(fact.lifecycle).not.toHaveProperty('branch');
    expect(fact.lifecycle).toMatchObject({ checks: 'passing', pr: { number: 4, headSha } });
    expect((await scope1.database.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='github-event'`, [room])).rowCount).toBe(1);
    await operations.processWebhook('push', {
      installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      ref: `refs/heads/${branch}`, after: '2'.repeat(40), commits: [{}],
    });
    expect((await scope1.database.query(`SELECT lifecycle->'pr'->>'headSha' head FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]?.head).toBe('2'.repeat(40));
    const collision = '33333333-3333-4333-8333-444444444444';
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,$3,$4,'Collision')`, [collision, workspace, room, HUMAN],
    );
    await insertCornerFacts(scope1.database, { cornerId: collision, lifecycle: '{"checks":"unknown"}' });
    await scope1.database.query(
      `UPDATE corner_github_cache SET lifecycle='{"checks":"unknown"}'::jsonb WHERE corner_id=$1`,
      [corner],
    );
    await operations.processWebhook('pull_request', {
      action: 'opened', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      pull_request: {
        number: 5, title: 'Fork work', html_url: 'https://github.com/owner/widgets/pull/5',
        head: { ref: branch, sha: headSha, repo: { full_name: 'outsider/widgets' } },
        base: { ref: 'main' }, mergeable_state: 'clean',
      },
    });
    await operations.processWebhook('push', {
      installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      ref: `refs/heads/${branch}`, after: headSha,
    });
    expect((await scope1.database.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=ANY($1::uuid[])`, [[corner, collision]])).rows).toEqual([{ lifecycle: { checks: 'unknown' } }, { lifecycle: { checks: 'unknown' } }]);
    await operations.processWebhook('pull_request', {
      action: 'opened', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      pull_request: { number: 6, title: 'Ambiguous work', html_url: 'https://github.com/owner/widgets/pull/6',
        head: { ref: branch, sha: headSha }, base: { ref: 'main' }, mergeable_state: 'clean' },
    });
    expect((await scope1.database.query(`SELECT card FROM messages WHERE room_id=$1 AND card->>'url' LIKE '%/pull/6'`, [room])).rows)
      .toEqual([expect.objectContaining({ card: expect.not.objectContaining({ cornerId: expect.anything() }) })]);
    // An archived collision still makes the prefix ambiguous in this repository.
    await scope1.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [collision]);
    await operations.processWebhook('push', {
      installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      ref: `refs/heads/${branch}`, after: headSha,
    });
    expect((await scope1.database.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]?.lifecycle)
      .toEqual({ checks: 'unknown' });
    // A collision in another repository does not block this one.
    const otherRoom = '44444444-4444-4444-8444-444444444444';
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name,repository_remote,github_installation_id)
      VALUES($1,$2,'Other','https://github.com/owner/other.git',77)`, [otherRoom, workspace]);
    await scope1.database.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [collision, otherRoom]);
    await operations.processWebhook('push', {
      installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      ref: `refs/heads/${branch}`, after: headSha,
    });
    expect((await scope1.database.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]?.lifecycle)
      .toHaveProperty('checksSummary');
    expect(app.openPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it('Reproduction R10-1: records pre-PR checks as the corner opener', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const branch = 'feature/corner-333333333333';
    const headSha = '1'.repeat(40);
    const candy = 'c'.repeat(64);
    const opener = 'd'.repeat(64);
    await scope1.database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Candy'),($2,'agent','Niglet')`,
      [candy, opener],
    );
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN],
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
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [workspace, room, candy],
    );
    // Opening a corner copies the parent's memberships, roles included, then
    // adds the opener as owner in the same transaction, so both owners share
    // one joined_at.
    await scope1.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Convo chains')`,
        [corner, workspace, room, opener],
      );
      await tx.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [workspace,room,opener],
      );
      await insertCornerFacts(tx, { cornerId: corner, ownerAgentId: opener, lifecycle: JSON.stringify({ checks: 'unknown' }) });
    });
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readCommitCheckRollup: vi.fn(async () => ({
        state: 'passed', total: 1, failing: [], checks: [{ name: 'build', status: 'passed' }],
      })),
      readPullRequest: vi.fn(async () => ({
        number: 4, url: 'https://github.com/owner/widgets/pull/4', headSha,
        headRef: branch, baseRef: 'main', mergeability: 'clean', merged: false,
      })),
      readBranchHead: vi.fn(async () => headSha),
      openPullRequestsForBranch: vi.fn(async () => [4]),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    await operations.processWebhook('check_run', {
      action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      check_run: {
        name: 'build', status: 'completed', conclusion: 'success', head_sha: headSha,
        check_suite: { head_branch: branch, head_sha: headSha },
      },
    });
    const checks = (await scope1.database.query<{ lifecycle: { checks?: string } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner],
    )).rows[0]?.lifecycle.checks;
    console.log(`Reproduction R10-1: checks=${checks}`);
    expect(checks).toBe('passing');
    const authors = (await scope1.database.query<{ author_id: string }>(
      `SELECT DISTINCT author_id FROM messages WHERE room_id=$1 AND card_type='github-corner-note'`,
      [corner],
    )).rows.map((row) => row.author_id);
    expect(authors).toEqual([opener]);
    expect((await scope1.database.query<{ kind: string }>(
      `SELECT system_event->>'kind' kind FROM messages WHERE room_id=$1 AND card_type='github-corner-note'`,
      [corner],
    )).rows).toEqual([{ kind: 'check-passed' }]);
  });

  it('credits the first agent to speak in an ownerless corner on merge, not a copied parent owner', async () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const branch = 'feature/corner-333333333333';
    const candy = 'c'.repeat(64);
    const worker = 'd'.repeat(64);
    await scope1.database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Candy'),($2,'agent','Niglet')`,
      [candy, worker],
    );
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
    await scope1.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN],
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
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [workspace, room, candy, worker],
    );
    // A person opens the corner: parent memberships are copied with their
    // roles, and no owner agent is recorded.
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Hidden river')`,
      [corner, workspace, room, HUMAN],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, lifecycle: '{"checks":"unknown"}' });
    // An earlier system note carries the old fallback's author; it must not count.
    await scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,system_event,created_at)
       VALUES($1,$2,$3,'@GitHub pushed','system','{"verb":"pushed"}'::jsonb,now()-interval '2 minutes'),
             ($4,$2,$5,'On it','message',NULL,now()-interval '1 minute')`,
      ['1'.repeat(64), corner, candy, '2'.repeat(64), worker],
    );
    const app = {
      installationToken: vi.fn(async () => ({ token: 'room-token' })),
      readCommitCheckRollup: vi.fn(async () => ({ state: 'passed', total: 0, failing: [], checks: [] })),
      branchDeletionSafety: vi.fn(async () => ({ defaultBranch: 'main', aheadBy: 0, protected: false })),
      openPullRequestsForBranch: vi.fn(async () => []),
      deleteBranch: vi.fn(async () => undefined),
    } as unknown as GitHubAppClient;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    await operations.processWebhook('pull_request', {
      action: 'closed', installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' },
      pull_request: {
        number: 1, title: 'Hidden river', html_url: 'https://github.com/owner/widgets/pull/1',
        head: { ref: branch, sha: '1'.repeat(40) }, base: { ref: 'main' },
        merged: true, merged_at: '2026-09-30T14:00:00Z', merge_commit_sha: 'f'.repeat(40),
        merged_by: { login: 'owner' },
      },
    });
    expect((await scope1.database.query<{ card_type: string; author_id: string }>(
      `SELECT card_type,author_id FROM messages
       WHERE (room_id=$1 AND card->>'type'='corner-complete')
          OR (room_id=$2 AND card_type='github-corner-note' AND system_event->>'verb'='merged')
       ORDER BY card_type`,
      [room, corner],
    )).rows).toEqual([
      { card_type: 'github-corner-note', author_id: worker },
    ]);
  });

  it('Reproduction MERGE-WEBHOOK-1: a merge event for another pull request never archives the corner', async () => {
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
    const mergedNotes = await scope1.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'verb'='merged'`,
      [corner],
    );
    console.info(
      `Reproduction MERGE-WEBHOOK-1: corner PR=#100 merged webhook=#200 archived=${cornerRow?.archived_at ?? 'no'} mergedNotes=${mergedNotes.rowCount}`,
    );
    expect(cornerRow).toMatchObject({ archived_at: null });
    expect(mergedNotes.rowCount).toBe(0);
    expect(app.deleteBranch).not.toHaveBeenCalled();
  });

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
});
