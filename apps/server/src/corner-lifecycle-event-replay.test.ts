import {
  describe, expect, it, A, B, H, R, SHA, rootFixture, open, pushToCorner,
  commands, claim, terminalResult, inReview, reasons, advanceCorner, fixtureScope18,
} from './test-support-corner-lifecycle.test-support.js';

const machine = async (cornerId: string) => (
  await rootFixture.db.query<{ machine: { state: string; phase?: string; reason?: string } }>(
    'SELECT machine FROM corner_facts WHERE corner_id=$1', [cornerId],
  )
).rows[0]!.machine;

describe('corner lifecycle recorded event sequences', () => {
  it('fresh head and four completed failed server groups wake only the implementer once', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId, JSON.stringify({ lifecycle: 'in-review', checks: 'unknown',
        pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA } }),
    ]);
    await pushToCorner(cornerId, SHA);
    expect(await machine(cornerId)).toMatchObject({ state: 'review', phase: 'checks' });
    const failing = [1, 2, 5, 8].map(n => `SERVER SUITE SHARD ${n}`);
    const rollup = { state: 'failed', total: 5, failing,
      checks: [...failing.map(name => ({ name, status: 'failed' })),
        { name: 'TYPECHECK', status: 'passed' }] };
    const events = fixtureScope18();
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(rollup);
    await events.checkRun(cornerId, failing[0]!, 'failure');
    expect(await machine(cornerId)).toMatchObject({ state: 'working' });
    const repairs = (await commands(A, cornerId)).filter(command => command.reason === 'corner_check');
    expect(repairs).toHaveLength(1);
    for (const name of failing) expect(repairs[0]!.source.body).toContain(name);
    // Other completed jobs and the repeated aggregate event cannot repeat the wake.
    for (const name of [...failing.slice(1), failing[0]!]) {
      rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(rollup);
      await events.checkRun(cornerId, name, 'failure');
    }
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(1);
    expect(await commands(B, cornerId)).toEqual([]);
    await claim(repairs[0]!);
    await terminalResult(repairs[0]!, 'The failed server tests need an upstream correction.');
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(rollup);
    await events.checkRun(cornerId, failing[0]!, 'failure');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(1);
    expect(await commands(B, cornerId)).toEqual([]);
  });

  it.each(['failed', 'blocked'] as const)(
    'terminal %s reviewer report hands missing phone proof back to the implementer', async status => {
      const cornerId = await inReview();
      const [review] = await commands(B, cornerId);
      expect(await machine(cornerId)).toMatchObject({ state: 'review', phase: 'reviewer' });
      await claim(review!);
      await rootFixture.daemon.execute('report', {
        roomId: cornerId, requestId: review!.turnRequestId, generationId: 'g1', status,
        text: 'FAIL: required native phone screenshots are missing. Capture the approved screens.',
      }, B);
      // PGlite has no production LISTEN bridge; deliver the committed report event.
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect(await machine(cornerId)).toMatchObject({ state: 'working' });
      await rootFixture.daemon.execute('postAgentTurnReceipt', {
        roomId: cornerId, requestId: review!.turnRequestId, generationId: 'g1', status: 'complete',
      }, B);
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect(await machine(cornerId)).toMatchObject({ state: 'working' });
      const repair = (await commands(A, cornerId)).find(command => command.reason === 'corner_review_needed');
      expect(repair).toBeDefined();
      expect(await commands(B, cornerId)).toEqual([]);
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect(await machine(cornerId)).toMatchObject({ state: 'working' });
      expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_review_needed')).toHaveLength(1);
    },
  );

  it('keeps an owner emulator ask visible after the failed-review handback ends', async () => {
    const cornerId = await inReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await rootFixture.daemon.execute('report', {
      roomId: cornerId, requestId: review!.turnRequestId, generationId: 'g1', status: 'blocked',
      text: 'FAIL: required native phone screenshots are missing.',
    }, B);
    await rootFixture.daemon.execute('postAgentTurnReceipt', {
      roomId: cornerId, requestId: review!.turnRequestId, generationId: 'g1', status: 'complete',
    }, B);
    await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
    const repair = (await commands(A, cornerId)).find(command => command.reason === 'corner_review_needed');
    await claim(repair!);
    const changes: string[] = [];
    const unlisten = await rootFixture.db.client.listen('beeline_live_v1', raw => {
      const event = JSON.parse(raw);
      if (event.table === 'corner_state') changes.push(event.roomId);
    });
    try {
      const ask = await rootFixture.daemon.execute('requestAgentGrant', {
        roomId: cornerId, requestId: repair!.turnRequestId, generationId: 'g1',
        kind: 'host', target: '127.0.0.1:5037', purpose: 'Capture required phone screenshots',
        reason: 'Use the owner emulator for the approved visual proof.',
      }, A);
      expect(ask).toMatchObject({ status: 'pending', auto: false });
      expect((await rootFixture.db.query('SELECT room_id FROM messages WHERE id=$1', [ask.messageId])).rows[0]!.room_id)
        .not.toBe(cornerId);
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect(await machine(cornerId)).toMatchObject({ state: 'waiting', reason: 'user_action' });
      await terminalResult(repair!, 'Awaiting the owner emulator approval to capture phone screenshots.');
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect(await machine(cornerId)).toMatchObject({ state: 'waiting', reason: 'user_action' });
      expect(await commands(B, cornerId)).toEqual([]);
      changes.length = 0;
      await rootFixture.phone.execute('decideAgentGrant', { grantId: ask.grantId, decision: 'always' }, H);
      expect(changes).toContain(cornerId);
      // Existing grant-decision delivery queues the requester's resume command;
      // its committed command event already advances the corner.
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect(await machine(cornerId)).toMatchObject({ state: 'working' });
      const resumes = (await commands(A, cornerId)).filter(command => command.action === 'resume');
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).toMatchObject({ agentId: A, source: { systemEvent: { kind: 'grant-decided' } } });
      await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
      expect((await commands(A, cornerId)).filter(command => command.action === 'resume').map(command => command.id))
        .toEqual(resumes.map(command => command.id));
      expect(await commands(B, cornerId)).toEqual([]);
    } finally { await unlisten(); }
  });
});
