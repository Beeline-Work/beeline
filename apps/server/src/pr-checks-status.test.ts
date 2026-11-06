import { readFileSync, runInNewContext, transformSync, cornerFeatureBranch, spawn, createServer, createInterface, fileURLToPath, describe, expect, it, vi, assignCornerWorker, recordCornerRun, seedCornerOpening, PhoneService, W, R, C, AUTHOR, H, A, REVIEWER, URL, SHA, db, operations, daemon, app, head, rollupState, rollupContexts, mergeableState, pullBaseSha, mainHead, workflowCount, actionsEnabled, workflowStatus, suiteStatus, suiteRuns, associatedPulls, requiredContexts, protectionForbidden, requests, registrationForbidden, server, gate, graphqlRequests, ownPr, rootFixture, fixtureScope2, type DaemonOperationMap } from './test-support-pr-checks-status.test-support.js';



it('Reproduction SENTRY-1D: checks command exposes the workflow refusal instead of a merge verdict', async () => {
  rootFixture.registrationForbidden = true;
  rootFixture.rollupState = 'SUCCESS';
  await expect(gate()).rejects.toThrow(/GitHub PR checks GET .*actions\/runs.*HTTP 403: Resource not accessible by integration/);
  expect(rootFixture.app.installationToken).toHaveBeenCalledWith(77, { repositoryIds: [101] });
  expect(rootFixture.requests.filter(url => url.includes('/actions/runs?'))).toHaveLength(1);
});
describe('PR-scoped check gate', () => {
  it.each(['Upgrade to GitHub Pro', 'make this repository public'])(
    'Reproduction PROTECTION-403: plan refusal (%s) lets real checks decide the gate', async message => {
      rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
      rootFixture.protectionForbidden = message;
      expect(await gate()).toMatchObject({ checks: 'passed', stage: 'waiting_for_yes', mergeAllowed: false });
      rootFixture.rollupState = 'FAILURE';
      expect(await gate()).toMatchObject({ checks: 'failed', mergeAllowed: false });
      rootFixture.rollupState = 'PENDING';
      expect(await gate()).toMatchObject({ checks: 'pending', mergeAllowed: false });
    },
  );


  it('Reproduction PROTECTION-403: permission refusals still fail the checks command', async () => {
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.protectionForbidden = 'Resource not accessible by integration';
    await expect(gate()).rejects.toThrow(/required_status_checks.*HTTP 403: Resource not accessible by integration/);
  });


  it('Reproduction PROTECTION-403: green checks wake review and an approved head can merge', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [AUTHOR],
    );
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.protectionForbidden = 'Upgrade to GitHub Pro or make this repository public to enable this feature.';
    await rootFixture.operations.processWebhook('check_run', {
      action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      check_run: {
        name: 'test', status: 'completed', conclusion: 'success', head_sha: SHA,
        check_suite: { head_branch: cornerFeatureBranch(AUTHOR), head_sha: SHA },
      },
    });
    expect((await rootFixture.daemon.execute('getAgentCommands', { roomId: AUTHOR }, REVIEWER)).commands).toHaveLength(1);
    expect(await gate(AUTHOR)).toMatchObject({ checks: 'passed', mergeAllowed: false });
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, REVIEWER);
    expect(await gate(AUTHOR)).toMatchObject({ checks: 'passed', approved: true, mergeAllowed: true });
  });


  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])('Reproduction CHECK-HEAD-1: a %s workflow keeps the live gate pending after existing jobs pass', async status => {
    rootFixture.workflowStatus = status;
    expect(await gate()).toMatchObject({ checks: 'pending', stage: 'checking', mergeAllowed: false });
    rootFixture.workflowStatus = 'completed';
    expect(await gate()).toMatchObject({ checks: 'passed', stage: 'waiting_for_yes' });
  });


  it('Reproduction CHECK-HEAD-1: a queued suite with a check run keeps the live gate pending', async () => {
    rootFixture.suiteStatus = 'queued';
    rootFixture.suiteRuns = 1;
    expect(await gate()).toMatchObject({ checks: 'pending', stage: 'checking', mergeAllowed: false });
    rootFixture.suiteStatus = 'completed';
    expect(await gate()).toMatchObject({ checks: 'passed' });
  });


  it('Reproduction EMPTY-SUITE-1: empty queued third-party suites let a green head pass and wake the reviewer', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [AUTHOR],
    );
    rootFixture.suiteStatus = 'queued';
    rootFixture.suiteRuns = 0;
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.requiredContexts = ['TYPECHECK', 'test'];
    rootFixture.rollupContexts = {
      totalCount: 2,
      nodes: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { databaseId: 15368 } } },
        { __typename: 'CheckRun', name: 'TYPECHECK', status: 'COMPLETED', conclusion: 'SKIPPED', checkSuite: { app: { databaseId: 15368 } } },
      ],
    };
    await rootFixture.operations.processWebhook('check_run', {
      action: 'completed',
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      check_run: {
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        head_sha: SHA,
        check_suite: { head_branch: cornerFeatureBranch(AUTHOR), head_sha: SHA },
      },
    });
    const stored = (await rootFixture.db.query<{ checks: string }>(
      `SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`,
      [AUTHOR],
    )).rows[0]?.checks;
    const commands = (await rootFixture.daemon.execute('getAgentCommands', { roomId: AUTHOR }, REVIEWER)).commands;
    console.info(
      `Reproduction EMPTY-SUITE-1: wrong=checks pending and no reviewer wake; observed checks=${stored} reviewerCommands=${commands.length}`,
    );
    expect(stored).toBe('passing');
    expect(commands).toHaveLength(1);
    expect(await gate(AUTHOR)).toMatchObject({ checks: 'passed', stage: 'waiting_for_yes' });
  });


  it('Reproduction EMPTY-SUITE-1: an explicit check read wakes the reviewer when only empty suites were queued', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [AUTHOR],
    );
    rootFixture.suiteStatus = 'queued';
    rootFixture.suiteRuns = 0;
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.requiredContexts = ['TYPECHECK'];
    rootFixture.rollupContexts = {
      totalCount: 1,
      nodes: [
        { __typename: 'CheckRun', name: 'TYPECHECK', status: 'COMPLETED', conclusion: 'SKIPPED', checkSuite: { app: { databaseId: 15368 } } },
      ],
    };
    await rootFixture.operations.prChecksStatus({ cornerId: AUTHOR });
    expect((await rootFixture.db.query<{ checks: string }>(
      `SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`,
      [AUTHOR],
    )).rows[0]?.checks).toBe('passing');
    expect((await rootFixture.daemon.execute('getAgentCommands', { roomId: AUTHOR }, REVIEWER)).commands).toHaveLength(1);
  });


  it('Reproduction R1: an explicit green check read posts the passing result, not a pending check', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [AUTHOR],
    );
    rootFixture.suiteStatus = 'queued';
    rootFixture.suiteRuns = 0;
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.requiredContexts = ['TYPECHECK'];
    rootFixture.rollupContexts = {
      totalCount: 1,
      nodes: [
        { __typename: 'CheckRun', name: 'TYPECHECK', status: 'COMPLETED', conclusion: 'SKIPPED', checkSuite: { app: { databaseId: 15368 } } },
      ],
    };
    await rootFixture.operations.prChecksStatus({ cornerId: AUTHOR });
    const note = (await rootFixture.db.query<{ text: string; event: unknown }>(
      `SELECT text, system_event event FROM messages
       WHERE room_id=$1 AND system_event->>'kind'='check-passed'`,
      [AUTHOR],
    )).rows[0];
    expect(note).toBeTruthy();
    const posted = JSON.stringify({ text: note!.text, event: note!.event });
    expect(posted).not.toMatch(/started/i);
    expect(posted).not.toMatch(/"status"\s*:\s*"pending"/);
    expect(posted).not.toContain('Pull request checks');
    expect(note!.text).toContain('passed a check');
  });


  it('Reproduction EMPTY-SUITE-1: a same-name success from another app leaves the required check pending', async () => {
    rootFixture.suiteStatus = 'queued';
    rootFixture.suiteRuns = 0;
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.requiredContexts = ['lint'];
    rootFixture.rollupContexts = {
      totalCount: 1,
      nodes: [{
        __typename: 'CheckRun',
        name: 'lint',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        checkSuite: { app: { databaseId: 999 } },
      }],
    };
    expect(await gate()).toMatchObject({ checks: 'pending', stage: 'checking', mergeAllowed: false });
  });


  it.each([0, 25])('Reproduction R1: counts missing required checks after %i reported successes', async count => {
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.requiredContexts = ['PRODUCTION-CORPUS REPLAY', 'FRAME-BUDGET', 'STATE-UPGRADE'];
    rootFixture.rollupContexts = {
      totalCount: count,
      nodes: Array.from({ length: count }, (_, i) => ({
        __typename: 'CheckRun', name: `check-${i}`, status: 'COMPLETED', conclusion: 'SUCCESS',
      })),
    };
    const rollup = await rootFixture.app.readCommitCheckRollup('room-token', 'owner/widgets', SHA);
    expect(rollup).toMatchObject({ state: 'pending', total: count + 3 });
    expect(await gate()).toMatchObject({
      checks: 'pending', checkCount: count + 3, mergeAllowed: false,
      checkStates: { passed: count, pending: 3 },
    });
    const formatter = transformSync(readFileSync(new globalThis.URL('../../mobile/sources/buzz/corner-status-line.ts', import.meta.url), 'utf8'), {
      loader: 'ts', format: 'cjs', tsconfigRaw: {},
    });
    const module = { exports: {} };
    runInNewContext(formatter.code, { module, exports: module.exports });
    const { cornerStatusLine } = module.exports as typeof import('../../mobile/sources/buzz/corner-status-line.js');
    const line = cornerStatusLine({
      checks: 'pending',
      pr: { number: 3958, url: URL, headSha: SHA },
      checksSummary: { status: 'pending', total: rollup.total, checks: rollup.checks, failing: [] },
    } as import('@beeline/api-contract/phone').CornerLifecycleView, false);
    console.info(`Reproduction R1: ${line}`);
    expect(line).toBe(`PR #3958 · ${count}/${count + 3} tests passed · running`);
  });


  it.each(['workflow', 'suite'])('CHECK-HEAD-1: a completed job webhook cannot dispatch review with a queued %s', async registration => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    if (registration === 'workflow') rootFixture.workflowStatus = 'queued';
    else { rootFixture.suiteStatus = 'queued'; rootFixture.suiteRuns = 1; }
    await rootFixture.operations.processWebhook('check_run', { action: 'completed', installation: { id: 77 },
      repository: { full_name: 'owner/widgets' }, check_run: { name: 'test', status: 'completed',
        conclusion: 'success', head_sha: SHA, check_suite: { head_branch: cornerFeatureBranch(AUTHOR), head_sha: SHA } } });
    expect((await rootFixture.db.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [AUTHOR])).rows[0]?.checks).toBe('pending');
    expect((await rootFixture.daemon.execute('getAgentCommands', { roomId: AUTHOR }, REVIEWER)).commands).toHaveLength(0);
  });


  it('keeps a formerly zero-check head pending when a workflow registers later', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary}','{"total":0}') WHERE corner_id=$1`, [AUTHOR]);
    rootFixture.rollupContexts = { totalCount: 0, nodes: [] };
    rootFixture.workflowStatus = 'queued';
    expect(await gate(AUTHOR)).toMatchObject({ checks: 'pending', mergeAllowed: false });
  });


  it('uses GitHub statusCheckRollup as the verdict', async () => {
    await expect(gate()).resolves.toMatchObject({
      stage: 'waiting_for_yes',
      checks: 'passed',
      pullRequest: URL,
      headSha: SHA,
      approved: false,
      mergeAllowed: false,
      reviewer: null,
      reviewerExists: false,
    });
    expect(graphqlRequests()).toHaveLength(1);
    expect(
      (
        await rootFixture.db.query<{ name: string }>(
          `SELECT table_name name FROM information_schema.tables
           WHERE table_name IN ('corner_check_facts','github_head_checks')`,
        )
      ).rows,
    ).toEqual([]);
  });


  it('reads the current head and current GitHub verdict every time', async () => {
    expect(await gate()).toMatchObject({ checks: 'passed', headSha: SHA });
    rootFixture.head = '2'.repeat(40);
    rootFixture.rollupState = 'PENDING';
    expect(await gate()).toMatchObject({ checks: 'pending', headSha: rootFixture.head });
    expect(graphqlRequests()).toHaveLength(2);
  });


  it('cannot be made stale by a synthetic check-suite webhook', async () => {
    await rootFixture.operations.processWebhook('check_suite', {
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      action: 'in_progress',
      check_suite: {
        id: 1,
        head_sha: SHA,
        head_branch: 'not-a-corner',
        status: 'in_progress',
        app: { name: 'GitHub Actions' },
      },
    });
    expect(await gate()).toMatchObject({ checks: 'passed' });
  });


  it('Reproduction CI-STATUS-1: counts passed, pending and failed checks and names the unfinished ones', async () => {
    rootFixture.rollupState = 'PENDING';
    const run = (name: string, status: string, conclusion: string | null) => ({
      __typename: 'CheckRun',
      name,
      status,
      conclusion,
    });
    rootFixture.rollupContexts = {
      totalCount: 104,
      nodes: [
        run('Detect changes', 'COMPLETED', 'SUCCESS'),
        run('Mobile', 'COMPLETED', 'SKIPPED'),
        { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS' },
        run('SERVER SUITE', 'IN_PROGRESS', null),
        run('DESKTOP BUILD (macos-universal)', 'QUEUED', null),
        run('LINT', 'COMPLETED', 'FAILURE'),
        ...Array.from({ length: 11 }, (_, index) => run(`shard ${index}`, 'IN_PROGRESS', null)),
      ],
    };
    const status = await gate();
    expect(status).toMatchObject({
      checks: 'pending',
      checkCount: 104,
      checkStates: {
        passed: 3,
        pending: 13,
        failed: 1,
        unlisted: 87,
        failedNames: ['LINT'],
      },
    });
    expect(status.checkStates.pendingNames).toEqual([
      'SERVER SUITE',
      'DESKTOP BUILD (macos-universal)',
      ...Array.from({ length: 8 }, (_, index) => `shard ${index}`),
    ]);
  });


  it('does not promote a head with no rollup', async () => {
    rootFixture.rollupState = null;
    expect(await gate()).toMatchObject({
      checks: 'pending',
      checkCount: 0,
      checkStates: { passed: 0, pending: 0, failed: 0, unlisted: 0, pendingNames: [], failedNames: [] },
    });
  });


  it('treats a zero-check head as complete after the worker handoff records it', async () => {
    rootFixture.rollupState = null;
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      C,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'passing',
        checksSummary: { status: 'passing', total: 0, failing: [], checks: [], updatedAt: 1 },
        pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main' },
      }),
    ]);
    expect(await gate()).toMatchObject({ checks: 'passed', checkCount: 0 });
  });


  it('does not single out a configured reviewer that opened the corner', async () => {
    await ownPr();
    // The reviewer opened this corner: its opening order and creator are A.
    await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND reason IN ('corner_objective','human_tag')`, [AUTHOR]);
    await seedCornerOpening(rootFixture.db, { cornerId: AUTHOR, agentId: A });
    await rootFixture.db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [AUTHOR, A]);
    await rootFixture.db.query(`UPDATE identities SET handle='reviewer' WHERE id=$1`, [A]);
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
    // An opener with no separate worker is the effective implementer.
    expect(await gate(AUTHOR)).toMatchObject({
      checks: 'passed',
      approved: false,
      mergeAllowed: false,
      reviewer: '@reviewer',
      reviewerExists: true,
      reviewerWake: { status: 'waiting' },
    });
    await expect(
      rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, A),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('the corner implementer cannot review its own work') });
    expect(await gate(AUTHOR)).toMatchObject({ approved: false, mergeAllowed: false });

    // Opening the corner is allowed when another agent implements the work.
    await assignCornerWorker(rootFixture.db, AUTHOR, REVIEWER);
    await expect(
      rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, A),
    ).resolves.toEqual({ status: 'approved', pullRequestNumber: 614, headSha: SHA });
    expect(await gate(AUTHOR)).toMatchObject({ approved: true, mergeAllowed: true });
  });


  it('keeps configured reviewer approval bound to the requested PR and exact head', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    expect(await gate(AUTHOR)).toMatchObject({
      approved: false,
      reviewer: '@reviewer',
      reviewerExists: true,
    });
    await expect(
      rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, REVIEWER),
    ).resolves.toEqual({ status: 'approved', pullRequestNumber: 614, headSha: SHA });
    expect(await gate(AUTHOR)).toMatchObject({ approved: true, mergeAllowed: true });
    rootFixture.head = '9'.repeat(40);
    expect(await gate(AUTHOR)).toMatchObject({ approved: false, mergeAllowed: false, headSha: rootFixture.head });
  });


  it('keeps the yes across a brief edit; only a new commit cancels it', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,1,'A1: change the button label',$2,$3)`,
      [AUTHOR, A, R],
    );
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, REVIEWER);
    expect(await gate(AUTHOR)).toMatchObject({ approved: true, mergeAllowed: true });
    await rootFixture.db.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,change,author_id,source_room_id)
       VALUES($1,2,'A1: use a different label','The requester changed the label',$2,$3)`,
      [AUTHOR, A, R],
    );
    expect(await gate(AUTHOR)).toMatchObject({ approved: true, mergeAllowed: true });
    rootFixture.head = '9'.repeat(40);
    expect(await gate(AUTHOR)).toMatchObject({ checks: 'passed', approved: false, mergeAllowed: false });
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`,
      [AUTHOR, rootFixture.head],
    );
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: rootFixture.head }, REVIEWER);
    expect(await gate(AUTHOR)).toMatchObject({ approved: true, mergeAllowed: true });
  });


  it('never transfers approval across whitespace, line-ending, metadata, or binary edits', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, REVIEWER);
    const collisionClasses = [
      'string whitespace',
      'indentation',
      'CRLF',
      'rename only',
      'mode only',
      'binary',
    ];
    for (const [index, collisionClass] of collisionClasses.entries()) {
      rootFixture.head = (index + 1).toString(16).repeat(40);
      expect(await gate(AUTHOR), collisionClass).toMatchObject({ approved: false });
    }
    expect(rootFixture.requests.some((request) => request.includes('.diff'))).toBe(false);
  });


  it('names a configured reviewer who is not a parent member and does not drop the gate', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      R,
      REVIEWER,
    ]);
    expect(await gate(AUTHOR)).toMatchObject({
      checks: 'passed',
      approved: false,
      reviewer: '@reviewer',
      reviewerExists: true,
      reviewerWake: {
        status: 'unreachable',
        detail:
          '@reviewer is configured as reviewer but is not a current member of the parent Room, so the checks-passed transition cannot wake them.',
      },
    });
  });


  it('reports waiting while checks are still pending so the author does not invent a missed wake', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [
        AUTHOR,
        JSON.stringify({
          lifecycle: 'in-review',
          checks: 'pending',
          pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main' },
        }),
      ],
    );
    rootFixture.rollupState = 'PENDING';
    expect(await gate(AUTHOR)).toMatchObject({
      checks: 'pending',
      reviewer: '@reviewer',
      reviewerWake: {
        status: 'waiting',
        detail: 'Checks are still pending, so @reviewer has not been woken yet.',
      },
    });
  });


  it('reports dispatched after the green transition consumed the reviewer wake', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await recordCornerRun(rootFixture.db, AUTHOR, 'review', 'passing');
    expect(await gate(AUTHOR)).toMatchObject({
      reviewerWake: {
        status: 'dispatched',
        detail: 'The checks-passed transition woke @reviewer.',
      },
    });
  });


  it('Reproduction REVIEWERWAKE-1: repairs the stored snapshot and reports the resulting green transition', async () => {
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [
        AUTHOR,
        JSON.stringify({
          lifecycle: 'working',
          checks: 'unknown',
          pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main' },
        }),
      ],
    );
    const status = await gate(AUTHOR);
    console.info(
      `Reproduction REVIEWERWAKE-1: stored checks=unknown live checks=${status.checks} reviewerWake=${status.reviewerWake.status} "${status.reviewerWake.detail}"`,
    );
    expect(status).toMatchObject({
      checks: 'passed',
      reviewer: '@reviewer',
      reviewerWake: {
        status: 'dispatched',
        detail: 'The checks-passed transition woke @reviewer.',
      },
    });
  });


  it('Reproduction REVIEWERWAKE-2: never reports a live re-run as green just because the lifecycle was passing', async () => {
    await ownPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    rootFixture.rollupState = 'PENDING';
    const status = await gate(AUTHOR);
    console.info(
      `Reproduction REVIEWERWAKE-2: stored checks=passing live checks=${status.checks} reviewerWake=${status.reviewerWake.status} "${status.reviewerWake.detail}"`,
    );
    expect(status).toMatchObject({
      checks: 'pending',
      reviewerWake: {
        status: 'waiting',
        detail: 'Checks are still pending, so @reviewer has not been woken yet.',
      },
    });
  });


  it('refuses other repositories and nonmembers before accessing PR data', async () => {
    await expect(gate(C, 'https://github.com/other/private/pull/614')).rejects.toThrow(
      'Room repository',
    );
    await expect(
      rootFixture.daemon.execute('getPrChecksStatus', { cornerId: C, pullRequest: 614 }, 'e'.repeat(64)),
    ).rejects.toThrow('access denied');
    expect(rootFixture.requests).toHaveLength(0);
  });


  it('composes a reviewer yes, a person yes, and a hold through the real helper', async () => {
    rootFixture.server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const operation = request.url!.split('/').pop() as keyof DaemonOperationMap;
        const output = await rootFixture.daemon.execute(
          operation,
          JSON.parse(Buffer.concat(chunks).toString()),
          A,
        );
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(output));
      } catch (error) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => rootFixture.server!.listen(0, '127.0.0.1', resolve));
    const address = rootFixture.server.address() as { port: number };
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new globalThis.URL('../../body/dist/read-only-mcp.js', import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          BEELINE_MCP_SURFACE: 'agent',
          BEELINE_AGENT_DM: '0',
          BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${address.port}`,
          BEELINE_DAEMON_TOKEN: 'local-test',
          BEELINE_DAEMON_ROOM_ID: R,
          BEELINE_DAEMON_CORNER_ID: C,
          BEELINE_DAEMON_WORKSPACE_ID: W,
          BEELINE_DAEMON_AGENT_ID: A,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines = createInterface({ input: child.stdout });
    const replies: string[] = [];
    lines.on('line', (line) => replies.push(line));
    const callGate = async (id: number) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read', arguments: { facet:'checks', address:C, pullRequest:614 } } })}\n`,
      );
      // Includes cold Node/tsx startup and the first server read on a busy CI runner.
      await vi.waitFor(() => expect(replies).toHaveLength(id), { timeout: 10_000 });
      const response = JSON.parse(replies[id - 1]!) as {
        result: { content: Array<{ text: string }> };
      };
      return JSON.parse(response.result.content[0]!.text) as Record<string, unknown>;
    };

    const gate1 = await callGate(1);
    expect(gate1).toMatchObject({
      stage: 'waiting_for_yes',
      checks: 'passed',
      approved: false,
      held: false,
      mergeAllowed: false,
      reviewerExists: false,
    });
    expect(gate1).not.toHaveProperty('rule');
    expect(gate1).not.toHaveProperty('isWorkerYolo');

    // A configured reviewer's PASS on this head is a yes. Yolo plays no part.
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(
      `INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha)
       VALUES($1,$2,614,$3)`,
      [C, REVIEWER, SHA],
    );
    await rootFixture.db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    await expect(callGate(2)).resolves.toMatchObject({
      approved: true,
      held: false,
      mergeAllowed: true,
      reviewerExists: true,
    });

    // A hold is the only veto.
    const { holdId } = await new PhoneService(rootFixture.db, 'http://test').execute('setCornerHold', { cornerId: C }, H);
    await expect(callGate(3)).resolves.toMatchObject({
      approved: true,
      held: true,
      mergeAllowed: false,
      holds: [{ id: holdId, actorId: H, standing: 'owner', setAt: expect.any(String) }],
    });

    // A Workspace owner's yes is the same yes: with no reviewer it opens the
    // gate, and the standing hold still vetoes it.
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
    await rootFixture.db.query(
      `UPDATE corner_merge_approvals SET approved_by=$2,approved_at=now() WHERE corner_id=$1`,
      [C, H],
    );
    const gate4 = await callGate(4);
    expect(gate4).toMatchObject({
      reviewerExists: false,
      approved: true,
      held: true,
      mergeAllowed: false,
    });
    await new PhoneService(rootFixture.db, 'http://test').execute(
      'setCornerHold',
      { cornerId: C, releaseHoldId: holdId },
      H,
    );
    const gate5 = await callGate(5);
    expect(gate5).toMatchObject({ approved: true, held: false, mergeAllowed: true });
    // CHECK-HEAD-1: the shipped helper's checks read follows registration and
    // live verdicts even when restore state still says pending.
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
      JSON.stringify({ checks: 'pending', pr: { number: 614, url: URL, headSha: SHA } })]);
    rootFixture.workflowStatus = 'queued';
    expect(await callGate(6)).toMatchObject({ checks: 'pending', mergeAllowed: false,
      reason: expect.stringContaining('queued or running workflows or suites') });
    rootFixture.workflowStatus = 'completed'; rootFixture.suiteStatus = 'queued';
    expect(await callGate(7)).toMatchObject({ checks: 'pending', mergeAllowed: false });
    rootFixture.suiteStatus = 'completed';
    expect(await callGate(8)).toMatchObject({ checks: 'passed', mergeAllowed: true, reason: 'all recorded checks passed' });
    console.info('Reproduction CHECK-HEAD-1: built helper read -> queued workflow/suite pending -> completed passed, stale restore text cleared');
    child.kill();
  });
});
describe('zero-check worker completion', () => {
const scope2 = fixtureScope2();


  it('does not pass or send to review a conflicting PR that GitHub ran no checks for', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'dirty';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.pr.mergeability).toBe('dirty');
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.lifecycle.checksSummary).toBeUndefined();
    expect(after.reviewer).toEqual([]);
    expect(after.worker).toEqual(['corner_merge_conflict']);
  });


  // Reproduction R1: PR #1957 conflicted with main, GitHub left pull.base.sha
  // behind main's head and started no workflows; the corner read
  // "no tests configured", checks passed, and the reviewer was woken.
  it('records the conflict when GitHub lags the base sha behind the branch head (R1)', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'dirty';
    rootFixture.pullBaseSha = 'e'.repeat(40);
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.pr).toMatchObject({ mergeability: 'dirty', baseSha: rootFixture.mainHead });
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.reviewer).toEqual([]);
    expect(after.worker).toEqual(['corner_merge_conflict']);
  });


  it('still resolves a clean PR with no checks as passing and wakes the reviewer', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle).toMatchObject({
      checks: 'passing',
      checksSummary: { status: 'passing', total: 0 },
      pr: { mergeability: 'clean' },
    });
    expect(after.reviewer).toEqual(['subscribed_event']);
    expect(after.worker).toEqual([]);
  });


  it('Reproduction ACTIONS-OFF: disabled Actions with workflow files reaches review and merge approval', async () => {
    rootFixture.rollupState = null;
    rootFixture.workflowCount = 2;
    rootFixture.actionsEnabled = false;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle).toMatchObject({ checks: 'passing', checksSummary: { total: 0 } });
    expect(after.reviewer).toEqual(['subscribed_event']);
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId: C, headSha: SHA }, REVIEWER);
    expect(await gate()).toMatchObject({ checkCount: 0, approved: true, mergeAllowed: true });
    rootFixture.rollupState = 'SUCCESS';
    rootFixture.rollupContexts = { totalCount: 0, nodes: [] };
    rootFixture.associatedPulls = [{ state: 'open', base: { ref: 'main' } }];
    rootFixture.requiredContexts = ['external-ci'];
    expect(await gate()).toMatchObject({ checks: 'pending', mergeAllowed: false });
    console.info('ACTIONS-OFF: worker handoff reaches review; approved zero-check head mergeable; missing external CI blocks');
  }, 20_000);


  it('Reproduction ZC-REGISTRATION: does not wake review before delayed checks register', async () => {
    rootFixture.rollupState = null;
    rootFixture.workflowCount = 2;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.reviewer).toEqual([]);
    rootFixture.rollupState = 'PENDING';
    expect(await gate()).toMatchObject({ checks: 'pending', checkCount: 1, mergeAllowed: false });
    console.info('Reproduction ZC-REGISTRATION: worker completion with empty rollup; delayed checks pending; no passing verdict or reviewer wake');
  }, 20_000);


  it('replaces a zero-check verdict when a later check webhook registers checks on the same head', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    expect((await scope2.finishPrTurn(rootFixture.mainHead)).lifecycle.checks).toBe('passing');
    rootFixture.rollupState = 'PENDING';
    await rootFixture.operations.processWebhook('check_run', {
      installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action: 'created',
      check_run: { id: 1, name: 'test', status: 'in_progress', conclusion: null,
        check_suite: { head_branch: cornerFeatureBranch(C), head_sha: SHA } },
    });
    const lifecycle = (await rootFixture.db.query<{ lifecycle: Record<string, unknown> }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [C],
    )).rows[0]!.lifecycle;
    expect(lifecycle).toMatchObject({ checks: 'pending', checksSummary: { total: 1 } });
    expect(await gate()).toMatchObject({ checks: 'pending', mergeAllowed: false });
  });
});
