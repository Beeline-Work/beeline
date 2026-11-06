import { createHash, describe, expect, it, vi, cornerRunStateSql, generateKeyPair, exportPKCS8, GitHubAppClient, GitHubHttpError, GitHubOAuthClient, seedCornerOpening, setCornerOwner, GitHubOperations, readAgentCommands, DaemonService, LiveHub, PhoneService, readRoomView, checkStatusLine, HUMAN, REVIEWER, fixtureScope1, type SqlDatabase } from './github-operations.test-support.js';

describe('GitHub phone operations', () => {
const scope1 = fixtureScope1();


  it.each(['parent Room', 'corner override'] as const)(
    'REVIEW-DISPATCH-BOUNDARY: green checks wake the %s reviewer exactly once inside the corner', async assignment => {
      const { room, corners, headSha, app, payload } = await scope1.checksFixture();
      const corner = corners[0]!;
      const worker = 'c'.repeat(64), override = 'd'.repeat(64);
      await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES
        ($1,'agent','Implementer'),($2,'agent','Independent reviewer')`, [worker, override]);
      await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`,
        [worker, override, HUMAN]);
      await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        SELECT workspace_id,id,who,'member' FROM rooms CROSS JOIN unnest($2::text[]) who WHERE id=$1`,
        [room, [worker, override]]);
      await seedCornerOpening(scope1.database, { cornerId: corner, agentId: worker });
      if (assignment === 'corner override')
        await scope1.database.query('UPDATE corner_facts SET reviewer_agent_id=$2 WHERE corner_id=$1', [corner, override]);
      await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"')
        WHERE corner_id=$1`, [corner]);
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
        app as unknown as GitHubAppClient, 'secret');
      const rollup = vi.fn<GitHubAppClient['readCommitCheckRollup']>();
      Object.assign(app, { readCommitCheckRollup: rollup });
      const reviews = () => scope1.database.query(`SELECT room_id,agent_id,reason,review_context FROM agent_commands
        WHERE review_context->>'purpose' IS NULL AND review_context->>'headSha'=$1`, [headSha]);

      // A completed individual job is not a green head while another job is queued.
      rollup.mockResolvedValue({ state: 'pending', total: 2, failing: [],
        checks: [{ name: 'lint', status: 'passed' }, { name: 'tests', status: 'pending' }] });
      await operations.processWebhook('check_run', payload);
      expect((await reviews()).rows).toEqual([]);
      expect((await scope1.database.query(`SELECT 1 FROM messages WHERE room_id=$1
        AND system_event->>'kind'='check-passed'`, [corner])).rows).toEqual([]);

      rollup.mockResolvedValue({ state: 'passed', total: 2, failing: [],
        checks: [{ name: 'lint', status: 'passed' }, { name: 'tests', status: 'passed' }] });
      for (let delivery = 0; delivery < 2; delivery++) {
        await operations.processWebhook('check_run', payload);
        await operations.processWebhook('workflow_run', { action: 'completed', installation: { id: 77 },
          repository: { full_name: 'owner/widgets' }, workflow_run: {
            head_branch: 'feature/corner-333333330001', head_sha: headSha, status: 'completed', conclusion: 'success',
          } });
      }
      expect((await reviews()).rows).toEqual([expect.objectContaining({
        room_id: corner, agent_id: assignment === 'corner override' ? override : REVIEWER,
        review_context: expect.objectContaining({ headSha, cornerId: corner, pullRequest: 1 }),
      })]);
      expect((await scope1.database.query('SELECT 1 FROM agent_commands WHERE room_id=$1', [room])).rows).toEqual([]);
    });


  it('OBJECTIVE-BRIEF: GitHub events read the latest brief objective instead of corner facts', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    await scope1.database.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
      SELECT id,1,'Scope','Old navigation',$2,parent_id FROM rooms WHERE id=$1`,[corners[0],REVIEWER]);
    await scope1.database.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
      SELECT id,2,'Current scope','Current navigation',$2,parent_id FROM rooms WHERE id=$1`,[corners[0],REVIEWER]);
    const operations = new GitHubOperations(scope1.database,{} as GitHubOAuthClient,app as unknown as GitHubAppClient,'secret');
    const refresh = vi.spyOn(operations as unknown as {refreshCheckRollup(...args:unknown[]):Promise<void>},'refreshCheckRollup')
      .mockResolvedValue(undefined);
    await operations.processWebhook('check_run',payload);
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({summary:'Current navigation'});
  });


  it.each(['checks event', 'stale landing wake'] as const)('MERGE-HANDOFF-AFTER-MERGE: %s reconciles a provider-confirmed merge', async trigger => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    await scope1.database.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage)
      SELECT workspace_id,'live' FROM rooms WHERE id=$1`, [corner]);
    // GitHub merged the PR, but its pull_request/closed webhook has not arrived.
    Object.assign(app, { readPullRequest: vi.fn(async () => ({
      number: 1, headSha, headRef: 'feature/corner-333333330001', baseRef: 'main',
      url: 'https://github.com/owner/widgets/pull/1', merged: true,
      mergedAt: '2026-10-30T12:00:00Z', mergeCommitSha: 'f'.repeat(40),
      mergedBy: 'owner', state: 'closed', mergeability: 'unknown',
    })) });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    if (trigger === 'checks event') await operations.processWebhook('check_run', payload);
    else expect(await operations.prChecksStatus({cornerId: corner})).toMatchObject({stage:'merged',mergeAllowed:false});
    const state = (await scope1.database.query(`SELECT fact.lifecycle, ${cornerRunStateSql('fact.corner_id')} workflow_state,
      room.archived_at FROM corner_facts fact JOIN rooms room ON room.id=fact.corner_id
      WHERE fact.corner_id=$1`, [corner])).rows[0]!;
    expect(state.lifecycle).toMatchObject({ outcome: 'landed',
      pr: { mergeCommitSha: 'f'.repeat(40) } });
    expect(state.workflow_state).toBe('landed');
    expect(state.archived_at).not.toBeNull();
    const terminalCards = () => scope1.database.query(`SELECT id,card FROM messages WHERE room_id=$1
      AND card_type='corner-workflow-handoff' AND card->>'toState'='landed' ORDER BY id`, [corner]);
    const committedCards = (await terminalCards()).rows;
    expect(committedCards).toHaveLength(1);
    await operations.processWebhook('check_run', payload);
    expect((await terminalCards()).rows).toEqual(committedCards);
    expect((await scope1.database.query(`SELECT fact.lifecycle, ${cornerRunStateSql('fact.corner_id')} workflow_state,
      room.archived_at FROM corner_facts fact JOIN rooms room ON room.id=fact.corner_id
      WHERE fact.corner_id=$1`, [corner])).rows[0]).toEqual(state);
    expect((await scope1.database.query(`SELECT 1 FROM messages WHERE room_id=$1
      AND card_type='github-corner-note' AND id=$2`, [corner, createHash('sha256').update(`beeline:${corner}:github:pull-request:merged:https://github.com/owner/widgets/pull/1`).digest('hex')])).rows).toHaveLength(1);
    expect(app.deleteBranch).toHaveBeenCalledTimes(1);
    expect(app.mergePullRequest).not.toHaveBeenCalled();
    expect((await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND state IN ('pending','claimed')`, [corner])).rows).toHaveLength(0);
  });


  it.each(['40P01', '55P03'].flatMap(code =>
    ['before writes', 'after writes'].map(boundary => ({ code, boundary }))))(
    'CHECK-LOCK-1: rolls back $code $boundary and waits for a new event without duplicate wakes', async ({ code, boundary }) => {
      const { corners, app, payload } = await scope1.checksFixture();
      const corner = corners[0]!;
      app.readCommitCheckRollup.mockResolvedValue({ state: 'failed', total: 1,
        failing: ['lint'], checks: [{ name: 'lint', status: 'failed' }] });
      const changed = vi.fn();
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
        app as unknown as GitHubAppClient, 'secret', undefined, changed);
      const transaction = scope1.database.transaction.bind(scope1.database);
      let attempts = 0;
      vi.spyOn(scope1.database, 'transaction').mockImplementation(work => transaction(async tx => {
        const attempt = ++attempts;
        if (attempt === 2) {
          expect((await tx.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]?.checks).toBe('passing');
          expect((await tx.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [corner])).rows).toHaveLength(0);
          expect(changed).not.toHaveBeenCalled();
        }
        if (attempt === 1 && boundary === 'before writes')
          throw Object.assign(new Error('lock conflict'), { code });
        const result = await work(tx);
        if (attempt === 1) throw Object.assign(new Error('lock conflict'), { code });
        return result;
      }));
      await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ code });
      expect(attempts).toBe(1);
      expect(changed).not.toHaveBeenCalled();
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(1);
      await operations.processWebhook('check_run', payload);
      // A separate event owns the next refresh and mergeability transaction.
      expect(attempts).toBe(3);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(2);
      expect(app.readPullRequest).toHaveBeenCalledTimes(2);
      expect((await scope1.database.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]?.checks).toBe('failing');
      await operations.processWebhook('check_run', payload);
      expect((await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='corner_check'`, [corner])).rows).toHaveLength(1);
      expect((await scope1.database.query(`SELECT 1 FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-failed'`, [corner])).rows).toHaveLength(1);
    });


  it.each(['40P01', '55P03', '23514'])(
    'CHECK-LOCK-1: propagates %s failure immediately with no partial writes', async code => {
      const { corners, app, payload } = await scope1.checksFixture();
      const corner = corners[0]!;
      const changed = vi.fn();
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
        app as unknown as GitHubAppClient, 'secret', undefined, changed);
      const transaction = scope1.database.transaction.bind(scope1.database);
      const failure = Object.assign(new Error('transaction failed'), { code });
      const spy = vi.spyOn(scope1.database, 'transaction').mockImplementation(work => transaction(async tx => {
        await work(tx);
        throw failure;
      }));
      await expect(operations.processWebhook('check_run', payload)).rejects.toBe(failure);
      expect(spy).toHaveBeenCalledOnce();
      expect(changed).not.toHaveBeenCalled();
      expect((await scope1.database.query(`SELECT lifecycle->'checksSummary' summary FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]?.summary).toBeNull();
      expect((await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [corner])).rows).toHaveLength(0);
    });


  it.each(['40P01', '55P03'])('CHECK-LOCK-1: leaves %s rollback and replay to the supplied transaction owner', async code => {
    const { corners, headSha, app } = await scope1.checksFixture();
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const failure = Object.assign(new Error('lock conflict'), { code });
    let nestedCalls = 0;
    await expect(scope1.database.transaction(async tx => {
      const supplied: SqlDatabase = {
        query: tx.query.bind(tx),
        transaction: async work => {
          nestedCalls++;
          await work(tx);
          throw failure;
        },
      };
      await operations['refreshCheckRollup']({ corner_id: corners[0]!,
        parent_id: '22222222-2222-4222-8222-222222222222', author_id: REVIEWER,
        corner_name: 'Checks', summary: 'Fix checks', repository_id: '101', installation_id: '77',
        has_pr: true, pr_number: '1' }, 'owner/widgets',
      { name: 'lint', status: 'passed', headSha }, supplied);
    })).rejects.toBe(failure);
    expect(nestedCalls).toBe(1);
    expect((await scope1.database.query(`SELECT lifecycle->'checksSummary' summary FROM corner_facts WHERE corner_id=$1`, [corners[0]])).rows[0]?.summary).toBeNull();
  });


  it.each(['40P01', '55P03'].flatMap(code =>
    ['head', 'fetch'].map(guard => ({ code, guard }))))(
    'CHECK-LOCK-1: preserves a changed $guard after $code rollback without replay', async ({ code, guard }) => {
      const { corners, app, payload } = await scope1.checksFixture();
      const corner = corners[0]!;
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
        app as unknown as GitHubAppClient, 'secret');
      const transaction = scope1.database.transaction.bind(scope1.database);
      let attempts = 0;
      vi.spyOn(scope1.database, 'transaction').mockImplementation(async work => {
        const attempt = ++attempts;
        try {
          return await transaction(async tx => {
            const result = await work(tx);
            if (attempt === 1) throw Object.assign(new Error('lock conflict'), { code });
            return result;
          });
        } catch (error) {
          if (attempt === 1) await scope1.database.query(guard === 'head'
            ? `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"new-head"') WHERE corner_id=$1`
            : `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary}','{"fetchStartedAt":9000000000000,"total":99}') WHERE corner_id=$1`, [corner]);
          throw error;
        }
      });
      await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ code });
      expect(attempts).toBe(1);
      const lifecycle = (await scope1.database.query<{ lifecycle: { pr: { headSha: string }; checksSummary?: { total: number } } }>(
        `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]!.lifecycle;
      if (guard === 'head') expect(lifecycle.pr.headSha).toBe('new-head');
      else expect(lifecycle.checksSummary?.total).toBe(99);
      expect((await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [corner])).rows).toHaveLength(0);
    });


  it.each(['webhook', 'live checks read'] as const)('R-GH-SHUTDOWN: drains %s before closing the pool', async trigger => {
    const { app, payload } = await scope1.checksFixture();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const original = app.readCommitCheckRollup.getMockImplementation()!;
    app.readCommitCheckRollup.mockImplementationOnce(async () => {
      entered();
      await paused;
      return original();
    });
    let closed = false;
    const lateQueries: string[] = [];
    const guarded = {
      query: async (sql: string, values?: unknown[]) => {
        if (closed) {
          lateQueries.push(sql);
          throw new Error('Cannot use a pool after calling end on the pool');
        }
        return scope1.database.query(sql, values);
      },
      transaction: scope1.database.transaction.bind(scope1.database),
    } as SqlDatabase;
    const operations = new GitHubOperations(guarded, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const refresh = (trigger === 'webhook'
      ? operations.processWebhook('check_run', payload)
      : operations.prChecksStatus({ cornerId: '33333333-0001-4333-8333-333333333333' }))
      .catch(error => error);
    await started;
    const queued = trigger === 'webhook'
      ? operations.processWebhook('check_run', payload).catch(error => error)
      : Promise.resolve();
    // Simulate HTTP shutdown finishing while an asynchronous refresh remains alive.
    const shutdown = (async () => {
      await operations.stopCheckRefreshes();
      closed = true;
    })();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    resume();
    const result = await refresh;
    expect(await queued).not.toBeInstanceOf(Error);
    await shutdown;
    expect(lateQueries).toEqual([]);
    expect(result).not.toBeInstanceOf(Error);
    expect(closed).toBe(true);
    const readsBefore = app.readCommitCheckRollup.mock.calls.length;
    await expect(operations.processWebhook('check_run', payload)).rejects.toThrow('shutting down');
    await expect(operations.prChecksStatus({ cornerId: '33333333-0001-4333-8333-333333333333' }))
      .rejects.toThrow('shutting down');
    expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(readsBefore);
  });


  it('R-GH-SHUTDOWN: drain preserves a genuine refresh failure for its caller', async () => {
    const { app, payload } = await scope1.checksFixture();
    const error = new Error('provider check refresh failed');
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    app.readCommitCheckRollup.mockImplementationOnce(async () => {
      entered();
      await paused;
      throw error;
    });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const failure = expect(operations.processWebhook('check_run', payload)).rejects.toBe(error);
    await started;
    const shutdown = operations.stopCheckRefreshes();
    resume();
    await Promise.all([failure, shutdown]);
  });


  it('WAKE-STORM: persists installation cooldown across server clients and keeps restore readable', async () => {
    const { corners, headSha } = await scope1.checksFixture();
    const { privateKey } = await generateKeyPair('RS256');
    const config = { appId: '42', slug: 'test', privateKey: await exportPKCS8(privateKey) };
    const app = new GitHubAppClient(config);
    const first = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app, 'secret');
    const reset = Math.floor(Date.now() / 1000) + 600;
    const fetcher = vi.fn(async (input: string | URL) => String(input).endsWith('/access_tokens')
      ? Response.json({ token: 'installation-77', expires_at: new Date(Date.now() + 3600_000).toISOString() })
      : new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(first.refreshCornerReviewHead(corners[0]!)).rejects.toMatchObject({ rateLimited: true });
    expect((await scope1.database.query<{ reset: string }>(
      'SELECT api_retry_at::text reset FROM github_installations WHERE installation_id=77')).rows[0]?.reset)
      .toBeDefined();
    const requests = fetcher.mock.calls.length;
    const replica = new GitHubAppClient(config);
    const second = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, replica, 'secret');
    await expect(second.refreshCornerReviewHead(corners[0]!)).rejects.toMatchObject({ rateLimited: true });
    expect(fetcher).toHaveBeenCalledTimes(requests);
    const daemon = new DaemonService(scope1.database, new LiveHub(), id => second.roomToken(id));
    Object.assign(daemon, { github: second });
    for (let i = 0; i < 20; i++) {
      const restore = await daemon.execute('getCornerRestoreState', { cornerId: corners[0]! }, REVIEWER);
      expect(restore.lifecycle?.pr?.headSha).toBe(headSha);
    }
    expect(fetcher).toHaveBeenCalledTimes(requests);
    // Reset expiry permits fresh provider evidence; the stored deadline is
    // shared, while each client's in-memory deadline remains authoritative too.
    await scope1.database.query("UPDATE github_installations SET api_retry_at=now()-interval '1 second' WHERE installation_id=77");
    const recovered = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, new GitHubAppClient(config), 'secret');
    fetcher.mockImplementation(async input => String(input).endsWith('/access_tokens')
      ? Response.json({ token: 'recovered', expires_at: new Date(Date.now() + 3600_000).toISOString() })
      : Response.json({ head: { sha: headSha }, state: 'open' }));
    await recovered.refreshCornerReviewHead(corners[0]!);
    expect(fetcher).toHaveBeenCalledTimes(requests + 2);
  });


  it.each(['workflow completion', 'live checks read'])(
    'CHECK-HEADER-1: %s replaces the stale rerun summary seen by the phone', async trigger => {
      const { corners, app, payload, headSha } = await scope1.checksFixture();
      const corner = corners[0]!;
      await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(jsonb_set(lifecycle,
        '{pr,title}','"Fix checks"'),'{pr,targetBranch}','"main"') WHERE corner_id=$1`, [corner]);
      await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1`, [
        '22222222-2222-4222-8222-222222222222', HUMAN]);
      await scope1.database.query(`INSERT INTO memberships(workspace_id,identity_id,role)
        VALUES('11111111-1111-4111-8111-111111111111',$1,'owner')`, [HUMAN]);
      const pending = Array.from({ length: 16 }, (_, i) => ({
        name: i === 15 ? 'BODY SUITE' : `check ${i}`, status: i === 15 ? 'pending' : 'passed',
      }));
      app.readCommitCheckRollup.mockResolvedValue({ state: 'pending', total: 16, failing: [], checks: pending });
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
        app as unknown as GitHubAppClient, 'secret');
      const phone = new PhoneService(scope1.database, 'http://local.test');
      const line = async () => checkStatusLine(readRoomView(await phone.readRoom(corner, HUMAN))!.cornerLifecycle);
      await operations.processWebhook('check_run', payload);
      expect(await line()).toBe('PR #1 · 15/16 tests passed · running');
      const complete = [...pending.map(check => ({ ...check, status: 'passed' })),
        ...Array.from({ length: 18 }, (_, i) => ({ name: `later ${i}`, status: 'passed' }))];
      app.readCommitCheckRollup.mockResolvedValue({ state: 'passed', total: 34, failing: [], checks: complete });
      app.readCommitCheckRollup.mockClear();
      if (trigger === 'workflow completion') {
        await operations.processWebhook('workflow_run', { action: 'completed',
          installation: payload.installation, repository: payload.repository,
          workflow_run: { head_branch: 'feature/corner-333333330001', head_sha: headSha, conclusion: 'success' } });
      } else {
        expect(await operations.prChecksStatus({ cornerId: corner })).toMatchObject({ checks: 'passed', checkCount: 34 });
      }
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(1);
      expect(await line()).toBe('PR #1 · all 34 tests passed');
      expect(await operations.prChecksStatus({ cornerId: corner })).toMatchObject({ checks: 'passed', checkCount: 34 });
      console.info(`CHECK-HEADER-1 (${trigger}): phone Room read → ${await line()}; checks facet → 34 passed`);
    });


  it('IDLE-DERIVED: identical GitHub reads retain the check status timestamp', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const read = async () => (await scope1.database.query<{ stamp: number }>(
      `SELECT (lifecycle->'checksSummary'->>'statusChangedAt')::double precision stamp
       FROM corner_facts WHERE corner_id=$1`,[corner])).rows[0]!.stamp;
    await operations.processWebhook('check_run',payload);
    const stamp = await read();
    expect(stamp).toBeGreaterThan(0);
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,
      '{checksSummary,statusChangedAt}',to_jsonb($2::double precision)) WHERE corner_id=$1`,[corner,stamp-120]);
    await operations.prChecksStatus({cornerId:corner});
    expect(await read()).toBe(stamp-120);
    app.readCommitCheckRollup.mockResolvedValue({state:'passed',total:1,failing:[],checks:[{name:'tests',status:'passed'}]});
    await operations.prChecksStatus({cornerId:corner});
    expect(await read()).toBeGreaterThan(stamp-120);
  });


  it('REVIEW-HEAD-1: handoff refresh discovers a push before its webhook and clears predecessor checks', async () => {
    const { corners, app } = await scope1.checksFixture();
    const corner = corners[0]!;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const previous = await app.readPullRequest('room-token', 'owner/widgets', 1);
    app.readPullRequest.mockResolvedValue({ ...previous, headSha: '2'.repeat(40) });
    await operations.refreshCornerReviewHead(corner);
    const row = (await scope1.database.query<{ lifecycle: { checks: string; pr: { headSha: string } } }>(
      'SELECT lifecycle FROM corner_facts WHERE corner_id=$1', [corner])).rows[0];
    expect(row?.lifecycle).toMatchObject({ checks: 'pending', pr: { headSha: '2'.repeat(40) } });
    expect(app.readPullRequest).toHaveBeenLastCalledWith('room-token', 'owner/widgets', 1);
  });


  it('CHECK-HEADER-1: a live read cannot replace a newer snapshot or another PR association', async () => {
    const { corners, app } = await scope1.checksFixture();
    const corner = corners[0]!;
    const newer = { status: 'passing', total: 34, failing: [], checks: [], fetchStartedAt: 9e12 };
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary}',$2::jsonb)
      WHERE corner_id=$1`, [corner, JSON.stringify(newer)]);
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const lifecycle = async () => (await scope1.database.query<{ lifecycle: unknown }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0]!.lifecycle;
    const before = await lifecycle();
    await operations.prChecksStatus({ cornerId: corner });
    expect(await lifecycle()).toEqual(before);
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'checksSummary' WHERE corner_id=$1`, [corner]);
    const otherPr = await lifecycle();
    await operations.prChecksStatus({ cornerId: corner, pullRequest: 2 });
    expect(await lifecycle()).toEqual(otherPr);
  });


  it('CONFLICT-STATUS-1: check refresh projects a live conflict over a stored clean verdict and clears it when resolved', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1`, [
      '22222222-2222-4222-8222-222222222222', HUMAN]);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,identity_id,role)
      VALUES('11111111-1111-4111-8111-111111111111',$1,'owner')`, [HUMAN]);
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(jsonb_set(lifecycle,
      '{pr,title}','"Fix checks"'),'{pr,targetBranch}','"main"') WHERE corner_id=$1`, [corner]);
    const phone = new PhoneService(scope1.database, 'http://local.test');
    const readLine = async () => {
      const view = readRoomView(await phone.readRoom(corner, HUMAN));
      expect(view?.cornerLifecycle?.pr?.headSha).toBe(payload.check_run.head_sha);
      return checkStatusLine(view!.cornerLifecycle);
    };
    expect(await readLine()).toBe('PR #1 · no tests configured');
    const clean = await app.readPullRequest('room-token', 'owner/widgets', 1);
    app.readPullRequest.mockResolvedValue({ ...clean, mergeability: 'dirty' });
    await operations.processWebhook('check_run', payload);
    expect(await readLine()).toBe('PR #1 · merge conflict');
    app.readPullRequest.mockResolvedValue(clean);
    await operations.refreshStaleMergeability(corner);
    expect(await readLine()).toBe('PR #1 · all 1 test passed');
  });


  it('CLOSED-1: archived corners cannot merge even with passing checks and a current yes', async () => {
    const { corners, headSha, app } = await scope1.checksFixture();
    const cornerId = corners[0]!;
    const implementer = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Implementer')`, [implementer]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [implementer, HUMAN]);
    await setCornerOwner(scope1.database, cornerId, implementer);
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await scope1.database.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,head_sha,pull_request_number)
      VALUES($1,$2,$3,1)`, [cornerId, REVIEWER, headSha]);
    expect(await operations.prChecksStatus({ cornerId })).toMatchObject({ mergeAllowed: true });
    await scope1.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    expect(await operations.prChecksStatus({ cornerId })).toMatchObject({
      stage: 'closed', checks: 'passed', approved: true, held: false, mergeAllowed: false,
    });
  });


  it('Reproduction stale-green: a pending webhook that reads a green rollup sends a passing review wake', async () => {
    const {corners,app,payload}=await scope1.checksFixture();
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,[corners[0]]);
    app.readCommitCheckRollup.mockResolvedValue({state:'passed',total:1,failing:[],checks:[{name:'SERVER INTEGRATION',status:'passed'}]} as never);
    const operations=new GitHubOperations(scope1.database,{} as GitHubOAuthClient,app as unknown as GitHubAppClient,'secret');
    await operations.processWebhook('check_run',{...payload,action:'in_progress',check_run:{...payload.check_run,status:'in_progress',conclusion:null}});
    const note=(await scope1.database.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-passed'`,[corners[0]])).rows[0];
    expect(note?.text).toContain('passed');
    expect(note?.text).not.toContain('started');
  });


  it('Reproduction merged-1: archival during the provider read cannot leave a landing offer', async () => {
    const {corners,headSha,app}=await scope1.checksFixture();
    const cornerId=corners[0]!;
    await setCornerOwner(scope1.database, cornerId, HUMAN);
    await scope1.database.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,head_sha,pull_request_number) VALUES($1,$2,$3,1)`,[cornerId,REVIEWER,headSha]);
    const rollup=await app.readCommitCheckRollup();
    app.readCommitCheckRollup.mockImplementationOnce(async()=>{
      await scope1.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`,[cornerId]);
      return rollup;
    });
    const operations=new GitHubOperations(scope1.database,{} as GitHubOAuthClient,app as unknown as GitHubAppClient,'secret');
    expect(await operations.prChecksStatus({cornerId})).toMatchObject({stage:'closed',mergeAllowed:false});
  });


  it('Reproduction merged-1: live GitHub merged state closes the gate before archival reaches the read', async () => {
    const {corners,headSha,app}=await scope1.checksFixture();
    const cornerId=corners[0]!;
    await setCornerOwner(scope1.database, cornerId, HUMAN);
    await scope1.database.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,head_sha,pull_request_number) VALUES($1,$2,$3,1)`,[cornerId,REVIEWER,headSha]);
    const pr=await app.readPullRequest('room-token','owner/widgets',1);
    app.readPullRequest.mockResolvedValue({...pr,merged:true,state:'closed'});
    const operations=new GitHubOperations(scope1.database,{} as GitHubOAuthClient,app as unknown as GitHubAppClient,'secret');
    expect(await operations.prChecksStatus({cornerId})).toMatchObject({stage:'merged',mergeAllowed:false});
  });


  it.each([true, false])('CLOSED-1: merge explains a closed corner with recorded PR=%s', async hasPr => {
    const { corners } = await scope1.checksFixture();
    const cornerId = corners[0]!;
    await scope1.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    if (!hasPr) await scope1.database.query(`UPDATE corner_github_cache SET lifecycle='{}'::jsonb WHERE corner_id=$1`, [cornerId]);
    const daemon = new DaemonService(scope1.database, new LiveHub());
    expect(await daemon.execute('mergeCorner', { cornerId }, REVIEWER)).toEqual({
      status: 'blocked', blocker: 'the corner is closed',
    });
  });


  it('R-GH-403-WEBHOOK: rate-limited confirmation waits for a new event', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    app.readPullRequest.mockRejectedValueOnce(new GitHubHttpError('PR', 429, '120'));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ status: 429 });
    const stored = (await scope1.database.query<{ lifecycle: Record<string, unknown> }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!.lifecycle;
    expect(stored.checks).toBe('pending');
    expect(stored.checkRefreshRetry).toBeUndefined();
    expect(app.readPullRequest).toHaveBeenCalledOnce();
    await operations.processWebhook('check_run', payload);
    expect(app.readPullRequest).toHaveBeenCalledTimes(2);
    expect(app.mergePullRequest).not.toHaveBeenCalled();
  });


  it.each(['primary', 'secondary', 'plain'])('R-GH-403-DISCUSSION: corner PR discussion preserves %s classification', async kind => {
    const { corners, app } = await scope1.checksFixture();
    const reset = Math.floor(Date.now() / 1000) + 600;
    const headers: Record<string, string> = kind === 'primary'
      ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
      : kind === 'secondary' ? { 'retry-after': '120' } : {};
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403, headers })));
    const client = new GitHubAppClient({ appId: '42', privateKey: 'unused', slug: 'beeline' });
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, {
      ...app, readPullRequestDiscussion: client.readPullRequestDiscussion.bind(client),
    } as unknown as GitHubAppClient, 'secret');
    await expect(operations.readCornerPullRequest(corners[0]!)).rejects.toMatchObject({
      status: 403, rateLimited: kind !== 'plain',
      retryAfter: kind === 'primary' ? new Date(reset * 1000).toUTCString() : kind === 'secondary' ? '120' : null,
    });
    expect(app.mergePullRequest).not.toHaveBeenCalled();
  });


  it.each(['primary', 'secondary'])('R-GH-403: %s rate limit keeps the gate closed until an explicit read', async kind => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const reset = Math.floor(Date.now() / 1000) + 600;
    const headers = kind === 'primary'
      ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }
      : { 'retry-after': '120' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403, headers })));
    const client = new GitHubAppClient({ appId: '42', privateKey: 'unused', slug: 'beeline' });
    // Exercise the actual provider read, not an invented error shape.
    const error = await client.readPullRequest('fake', 'owner/widgets', 1).catch(error => error);
    app.readCommitCheckRollup.mockRejectedValue(error);
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toBe(error);
    const stored = (await scope1.database.query<{ lifecycle: { checks: string; checkRefreshRetry: { headSha: string; after: number } } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!.lifecycle;
    expect(stored.checks).toBe('pending');
    expect(stored.checkRefreshRetry).toBeUndefined();
    await expect(operations.prChecksStatus({ cornerId: corners[0]! })).rejects.toThrow('GitHub rate limit; checks readable again at');
    expect(app.mergePullRequest).not.toHaveBeenCalled();
    app.readCommitCheckRollup.mockResolvedValue({ state: 'passed', total: 1, failing: [], checks: [] });
    await operations.prChecksStatus({ cornerId: corners[0]! });
    const recovered = (await scope1.database.query<{ lifecycle: Record<string, unknown> }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!.lifecycle;
    expect(recovered.checks).toBe('passing');
    expect(recovered.checkRefreshRetry).toBeUndefined();
  });


  it('R-GH-RETRY: a failed webhook returns 502 and a new event updates the visible checks', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    app.readCommitCheckRollup.mockRejectedValueOnce(new GitHubHttpError('Checks', 502));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ status: 502 });
    expect(app.readCommitCheckRollup).toHaveBeenCalledOnce();
    await operations.processWebhook('check_run', payload);
    expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(2);
    const { lifecycle } = (await scope1.database.query<{ lifecycle: { checks: string; checksSummary: { total: number } } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!;
    expect(lifecycle).toMatchObject({ checks: 'passing', checksSummary: { total: 1 } });
    expect(checkStatusLine(lifecycle)).toBe('PR #1 · all 1 test passed');
  });


  it('R-GH-RETRY: one failed 5xx read blocks stale checks and restart waits for a new event', async () => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const error = new GitHubHttpError('Checks', 503);
    app.readCommitCheckRollup.mockRejectedValue(error);
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toBe(error);
    expect(app.readCommitCheckRollup).toHaveBeenCalledOnce();
    const stored = (await scope1.database.query<{ lifecycle: Record<string, unknown> }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!.lifecycle;
    expect(stored).toMatchObject({ checks: 'pending', checksSummary: { status: 'pending' } });
    expect(stored.checkRefreshRetry).toBeUndefined();
    expect(checkStatusLine(stored)).toBe('PR #1 · tests running');
    await expect(operations.prChecksStatus({ cornerId: corners[0]! })).rejects.toBe(error);
    expect(app.mergePullRequest).not.toHaveBeenCalled();
    app.readCommitCheckRollup.mockResolvedValue({ state: 'passed', total: 1, failing: [], checks: [] });
    const restarted = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(2);
    await restarted.processWebhook('check_run', payload);
    expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(3);
    const recovered = (await scope1.database.query<{ lifecycle: Record<string, unknown> }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!.lifecycle;
    expect(recovered.checks).toBe('passing');
    expect(recovered.checkRefreshRetry).toBeUndefined();
  }, 30_000);


  it.each([new TypeError('fetch failed'), Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), new GitHubHttpError('Checks', 504)])(
    'R-GH-RETRY: returns transient transport failure %s', async error => {
      const { app, payload } = await scope1.checksFixture();
      app.readCommitCheckRollup.mockRejectedValueOnce(error);
      const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
      await expect(operations.processWebhook('check_run', payload)).rejects.toBe(error);
      expect(app.readCommitCheckRollup).toHaveBeenCalledOnce();
      await operations.processWebhook('check_run', payload);
      expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(2);
    },
  );


  it('R-GH-RETRY: long Retry-After creates no durable retry obligation', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    app.readCommitCheckRollup.mockRejectedValue(new GitHubHttpError('Checks', 429, '120'));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ status: 429, retryAfter: '120' });
    const retry = (await scope1.database.query<{ retry: unknown }>(
      `SELECT lifecycle->'checkRefreshRetry' retry FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!.retry;
    expect(retry).toBeNull();
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); }
    finally { vi.useRealTimers(); }
    expect(app.readCommitCheckRollup).toHaveBeenCalledOnce();
  });


  it('R-GH-RETRY: a late failed-head event cannot read or restore its old check result', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    app.readCommitCheckRollup.mockRejectedValueOnce(new GitHubHttpError('Checks', 429, '120'));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ status: 429 });
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(
      lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`, [corners[0], '2'.repeat(40)]);
    await operations.processWebhook('check_run', payload);
    expect(app.readCommitCheckRollup).toHaveBeenCalledOnce();
  });


  it.each([401, 403, 404, 422])('R-GH-RETRY: HTTP %s fails once without queueing', async status => {
    const { corners, app, payload } = await scope1.checksFixture();
    app.readCommitCheckRollup.mockRejectedValue(new GitHubHttpError('Checks', status));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await expect(operations.processWebhook('check_run', payload)).rejects.toMatchObject({ status });
    expect(app.readCommitCheckRollup).toHaveBeenCalledTimes(1);
    const row = (await scope1.database.query<{ retry: unknown }>(
      `SELECT lifecycle->'checkRefreshRetry' retry FROM corner_facts WHERE corner_id=$1`, [corners[0]],
    )).rows[0]!;
    expect(row.retry).toBeNull();
  });


  it('Reproduction REVIEW-PR-1: a missed close cannot send green wakes to the replaced PR', async () => {
    const { corners, headSha, app, payload } = await scope1.checksFixture();
    const corner = corners[0]!;
    const implementer = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Implementer')`, [implementer]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [implementer, HUMAN]);
    await setCornerOwner(scope1.database, corner, implementer);
    app.readPullRequest.mockImplementation(async (_token, _repository, number) => ({
      number, headSha, url: `https://github.com/owner/widgets/pull/${number}`,
      mergeability: 'clean', state: number === 1 ? 'closed' : 'open', headRef: 'feature/corner-333333330001',
    }));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await operations.processWebhook('pull_request', { ...payload, action: 'opened', pull_request: {
      number: 2, title: 'Replacement', html_url: 'https://github.com/owner/widgets/pull/2',
      head: { ref: 'feature/corner-333333330001', sha: headSha }, base: { ref: 'main' }, mergeable_state: 'clean',
    } });
    const lifecycle = (await scope1.database.query<{ lifecycle: { pr?: { number: number }; checks: string } }>(
      'SELECT lifecycle FROM corner_facts WHERE corner_id=$1', [corner])).rows[0]!.lifecycle;
    expect(lifecycle.pr?.number).toBe(2);
    expect(lifecycle.checks).toBe('passing');
    const commands = (await readAgentCommands(scope1.database, corner, REVIEWER)).commands;
    expect(commands).toHaveLength(1);
    const target = (await scope1.database.query<{ pr: number }>(
      "SELECT (review_context->>'pullRequest')::int pr FROM agent_commands WHERE id=$1", [commands[0]!.id])).rows[0];
    expect(target?.pr).toBe(2);
    expect(commands.some(command => command.source.body.includes('pull/1'))).toBe(false);
    console.info('Demonstrated REVIEW-PR-1: missed close replaced by live open PR; no wake for closed PR');
  });


  it('Reproduction REVIEW-PR-1: a green check for a live closed PR clears the stale association', async () => {
    const { corners, app, payload } = await scope1.checksFixture();
    app.readPullRequest.mockImplementation(async (_token, _repository, number) => ({
      number, headSha: '1'.repeat(40), url: `https://github.com/owner/widgets/pull/${number}`,
      mergeability: 'clean', state: 'closed',
    }));
    const operations = new GitHubOperations(scope1.database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret');
    await operations.processWebhook('check_run', payload);
    expect((await scope1.database.query<{ pr: unknown }>(
      "SELECT lifecycle->'pr' pr FROM corner_facts WHERE corner_id=$1", [corners[0]])).rows[0]?.pr).toBeNull();
  });
});
