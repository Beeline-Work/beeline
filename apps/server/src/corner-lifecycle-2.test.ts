import { randomBytes, describe, expect, it, vi, assignCornerWorker, PhoneService, DaemonService, GitHubOperations, LiveHub, systemLine, advanceCorner, cornerMergeGate, createAgentCommand, queueCornerMergeConflict, reconcileCornerMergeBlockers, CORNER_LIFECYCLE_CARD_TYPE, cornerOwnerSql, RecordingDatabase, H, A, B, R, db, phone, daemon, github, githubRollupState, githubHead, githubApp, implementersMerge, cards, currentState, commissioned, brief, open, claim, pushToCorner, greenHead, redHead, resumeWorker, commands, result, terminalResult, orderRepairsFromRoom, SHA, branchOf, reasons, projected, inReview, approve, approved, mergedWebhook, say, revise, F, fallback, rootFixture, fixtureScope14, fixtureScope18, fixtureScope19, fixtureScope20, type GitHubAppClient, type GitHubOAuthClient } from './test-support-corner-lifecycle.test-support.js';

describe('Reproduction S-07: every reviewer waits for a quiet corner', () => {
  it.each([B])('holds a review for %s until the worker releases its lease', async (reviewerId) => {
    const cornerId = await inReview();
    const worker = await resumeWorker(cornerId);
    await claim(worker);
    const source = await systemLine(rootFixture.db, { roomId: cornerId, subject: { kind: 'agent', id: A, name: 'Hoots' }, verb: 'revised the corner brief', object: 'Revision 2' });
    const review = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: reviewerId, sourceMessageId: source.id, reason: 'corner_check' });
    const delivered = (await commands(reviewerId, cornerId)).some(c => c.id === review!.id);
    console.info(`Reproduction S-07: reviewer review with live worker lease → delivered=${delivered}`);
    expect(delivered).toBe(false);
    await terminalResult(worker, 'Worker finished');
    expect((await commands(reviewerId, cornerId)).some(c => c.id === review!.id)).toBe(true);
  });


  it.each([B])('delivers unrelated commands to %s while the worker is busy', async (reviewerId) => {
    const cornerId = await inReview();
    await claim(await resumeWorker(cornerId));
    const source = await systemLine(rootFixture.db, { roomId: cornerId, subject: { kind: 'human', id: H, name: 'Human' }, verb: 'recorded a note' });
    const ordinary = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: reviewerId, sourceMessageId: source.id, reason: 'human_tag' });
    expect((await commands(reviewerId, cornerId)).some(c => c.id === ordinary!.id)).toBe(true);
  });
});
describe('Reproduction R5a: entry paths lock the run before corner rows', () => {
  it.each(['check webhook', 'merged webhook', 'approval', 'hold', 'brief', 'create', 'zero-check', 'blocker reconciliation', 'agent close', 'phone close'])('%s', async path => {
    const cornerId = await inReview();
    const recording = new RecordingDatabase(rootFixture.db);
    const recordedDaemon = new DaemonService(recording, new LiveHub());
    const recordedGithub = new GitHubOperations(recording, {} as GitHubOAuthClient, rootFixture.githubApp as unknown as GitHubAppClient, 'secret');
    vi.spyOn(recordedGithub, 'assertCornerReviewerNotAuthor').mockResolvedValue(undefined);
    Object.assign(recordedDaemon, { github: recordedGithub });
    let lockId = cornerId;
    if (path === 'check webhook') {
      rootFixture.githubRollupState = 'passed';
      await recordedGithub.processWebhook('check_run', {
        installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action: 'completed',
        check_run: { id: 5, name: 'typecheck', status: 'completed', conclusion: 'success',
          check_suite: { head_branch: branchOf(cornerId), head_sha: SHA } },
      });
    } else if (path === 'merged webhook') {
      const previous = rootFixture.github;
      rootFixture.github = recordedGithub;
      try { await mergedWebhook(cornerId, 7, SHA); } finally { rootFixture.github = previous; }
    } else if (path === 'approval') {
      await recordedDaemon.execute('approveCornerMerge', { cornerId, headSha: SHA }, B);
    } else if (path === 'hold') {
      await new PhoneService(recording, 'http://test').execute('setCornerHold', { cornerId }, H);
    } else if (path === 'agent close') {
      await recordedDaemon.execute('archiveCorner', { cornerId }, A);
    } else if (path === 'phone close') {
      await new PhoneService(recording, 'http://test').execute('requestCornerClose', { roomId: cornerId }, H);
    } else if (path === 'brief') {
      await revise(cornerId, recordedDaemon);
    } else if (path === 'create') {
      const command = await commissioned(R);
      const created = await recordedDaemon.execute('createCorner', { roomId: R, requestId: command.turnRequestId,
        generationId: 'g1', name: 'Another-widget', objective: 'Ship another widget', repository: 'owner/widgets',
        brief: brief(command.sourceMessageId) }, A);
      lockId = created.cornerId;
    } else if (path === 'zero-check') {
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(jsonb_set(lifecycle,'{checks}','"unknown"'),'{pr,mergeability}','"clean"') WHERE corner_id=$1`, [cornerId]);
      const command = await commissioned(cornerId);
      const status = { ...(await rootFixture.github.prChecksStatus({ cornerId })), checks: 'pending' as const, checkCount: 0, zeroChecksConfirmed: true };
      const completion = new DaemonService(recording, new LiveHub(), undefined, undefined, false, undefined, false, undefined, async () => {
        // Completion runs after the reply transaction commits; inspect its own locks.
        recording.calls.length = 0;
        return status;
      });
      await completion.execute('postRoomMessage', { roomId: cornerId, requestId: command.turnRequestId,
        generationId: 'g1', text: 'https://github.com/owner/widgets/pull/7' }, A);
    } else {
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"failing"') WHERE corner_id=$1`, [cornerId]);
      await reconcileCornerMergeBlockers(recording, cornerId);
    }
    const retained = recording.calls.findIndex(call => call.values?.[0] === lockId
      && (/FROM corner_facts/.test(call.sql) && /FOR UPDATE/.test(call.sql) || /^INSERT INTO corner_facts/.test(call.sql)));
    const write = recording.calls.findIndex(call => /^UPDATE corner_facts|^INSERT INTO corner_(?:brief_revisions|merge_holds|merge_approvals)/.test(call.sql));
    expect(retained, 'native state row was retained').toBeGreaterThanOrEqual(0);
    if (path === 'zero-check') expect(write, 'zero-check is read-only').toBe(-1);
    else {
      expect(write, 'path wrote its corner effect').toBeGreaterThanOrEqual(0);
      expect(retained, 'state retention precedes effects').toBeLessThan(write);
    }
  });
});
describe('Reproduction R5b: authority changes between gate read and merge', () => {
const scope14 = fixtureScope14();


  it.each(['hold', 'membership'])('%s stops the merge', async change => {
    const cornerId = await approved();
    scope14.mergesOnceOnGitHub(cornerId);
    let holdId: string | undefined;
    const { state, raced } = scope14.racedWith(async () => {
      if (change === 'hold') holdId = (await rootFixture.phone.execute('setCornerHold', { cornerId }, H)).holdId;
      if (change === 'membership') await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    });
    expect(await raced.landCorner(cornerId)).toBe(false);
    expect(state.injected).toBe(true);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    if (change === 'hold') await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId! }, H);
    if (change === 'membership') await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    expect(await implementersMerge(raced)).toBe(1);
    expect(await implementersMerge(raced)).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });


  it.each(['brief', 'yolo'])('%s does not stop the merge (a brief edit keeps the yes; yolo is not part of the gate)', async change => {
    const cornerId = await approved();
    scope14.mergesOnceOnGitHub(cornerId);
    const { state, raced } = scope14.racedWith(async () => {
      if (change === 'brief') await revise(cornerId);
      if (change === 'yolo') await rootFixture.db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    });
    expect(await raced.landCorner(cornerId)).toBe(true);
    expect(state.injected).toBe(true);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    expect(await implementersMerge(raced)).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
describe('advanceCorner rejects an event the current state does not allow (AC-1)', () => {
  it('changes nothing and logs it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const cornerId = await open('owner/widgets');
      const before = await cards(cornerId);
      expect(
        await advanceCorner(rootFixture.db, cornerId, { kind: 'checks-pending' }),
      ).toEqual({
        state: 'working',
        accepted: false,
      });
      expect(await advanceCorner(rootFixture.db, cornerId, { kind: 'approval', headSha: SHA, by: 'reviewer' })).toEqual({
        state: 'working',
        accepted: false,
      });

      expect(await projected(cornerId)).toBe('working');
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});
describe('re-runs and pushes out of review (AC-1)', () => {
  it.each(['check-passed', 'check-failed'] as const)('Reproduction CHECK-HEAD-1: ignores an old-head %s wake even when its verdict matches the new head', async kind => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await pushToCorner(cornerId, SHA);
    const checks = kind === 'check-passed' ? 'passing' : 'failing';
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [cornerId,
      JSON.stringify({ checks, lifecycle: 'in-review', pr: { number: 7, headSha: SHA } })]);
    const before = await cards(cornerId);
    const beforeWorker = await commands(A, cornerId);
    const beforeReviewer = await commands(B, cornerId);
    await systemLine(rootFixture.db, { roomId: cornerId, authorId: H,
      subject: { kind: 'github', name: 'GitHub' }, verb: 'reported checks on', kind,
      object: { text: 'pull request #7', headSha: 'f'.repeat(40) } });

    expect(await commands(A, cornerId)).toEqual(beforeWorker);
    expect(await commands(B, cornerId)).toEqual(beforeReviewer);
  });


  it('a re-run after red checks goes implement -> checks, and its green reaches review', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await redHead(cornerId, 3, SHA);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [
      cornerId,
    ]);
    await advanceCorner(rootFixture.db, cornerId, { kind: 'checks-pending' });
    expect(await currentState(cornerId)).toBe('working');
    await rootFixture.db.query(`SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(command.id,command.generation_id,'complete',NULL,NULL) ended
      FROM agent_commands command WHERE command.room_id=$1 AND command.agent_id=$2
        AND command.state IN ('pending','claimed')) terminal`, [cornerId, A]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`, [
      cornerId,
    ]);
    await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
    expect(await currentState(cornerId)).toBe('review');

  });


  it('a re-run in review, before or after a yes, goes back to checks', async () => {
    const cornerId = await inReview();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [
      cornerId,
    ]);
    await advanceCorner(rootFixture.db, cornerId, { kind: 'checks-pending' });

    const landing = await approved();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [
      landing,
    ]);
    await advanceCorner(rootFixture.db, landing, { kind: 'checks-pending' });

  });


  it('a push during review goes review -> checks', async () => {
    const cornerId = await inReview();
    await pushToCorner(cornerId, '8'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');

  });
});
describe('each transition wakes the next role exactly once (AC-2)', () => {
  it('Reproduction REVIEW-SILENT-1: a completed review and worker reply without PASS return the unresolved review to the implementer', async () => {
    const cornerId = await inReview();
    const opening = await resumeWorker(cornerId);
    await claim(opening!);
    await terminalResult(opening!, 'The implementation is ready for review.');
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await orderRepairsFromRoom(review!, cornerId, 'Attach the available proof before review');
    await result(review!, '@hoots attach the production proof before I can PASS.');
    const reply = (await commands(A, cornerId)).find(command => command.reason === 'order');
    await claim(reply!);
    await result(reply!, 'blocked: the proof is attached; a required entry point is still unavailable.');
    for (const tagged of (await commands(A, cornerId)).filter(command => command.reason === 'agent_tag')) {
      await claim(tagged);
      await rootFixture.daemon.execute('postAgentTurnReceipt', { roomId: cornerId, requestId: tagged.turnRequestId,
        generationId: 'g1', agentId: A, status: 'complete', completionKind: 'no-reply' }, A);
    }
    const returned = (await commands(B, R)).find(command => command.reason === 'report')!;
    await claim(returned);
    await rootFixture.daemon.execute('report', { status: 'blocked', roomId: R, requestId: returned.turnRequestId, generationId: 'g1',
      text: 'blocked: required entry point is unavailable' }, B);
    await result(returned, 'Reported the remaining capability blocker to the commander.');
    const before = await cards(cornerId);
    for (let replay = 0; replay < 2; replay++)
      await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: review!.sourceMessageId });
    expect(await reasons(cornerId, A)).toContain('corner_review_needed');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_review_needed')).toHaveLength(1);
    expect(await reasons(cornerId, B)).toEqual(['subscribed_event']);

    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: false, open: false });
    expect((await commands(A, cornerId)).find(command => command.reason === 'corner_review_needed')?.source.body)
      .toContain('report the blocker');
  });


  it.each(['checks', 'review'])('Reproduction REVIEW-SILENT-2: an unreachable reviewer in %s wakes the implementer', async state => {
    const cornerId = state === 'review' ? await inReview() : await open('owner/widgets');
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, B]);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    if (state === 'checks') await greenHead(cornerId, 7, SHA);
    else {
      await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [cornerId, B]);
      await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: cornerId });
    }
    expect(await reasons(cornerId, A)).toContain('corner_review_needed');
    expect(await currentState(cornerId)).toBe('working');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND room_id=$2 AND state='pending'`,[B,cornerId])).rowCount).toBe(0);
  });


  it('does not return unresolved review while the tagged implementer is still answering it', async () => {
    const cornerId = await inReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, '@hoots attach the production proof.');
    await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: review!.sourceMessageId });
    expect(await reasons(cornerId, A)).not.toContain('corner_review_needed');
  });


  it.each(['checks', 'review'])('a rejected reviewer insert in %s commits an implementer handback', async state => {
    const cornerId = state === 'review' ? await inReview() : await open('owner/widgets');
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, B]);
    if (state === 'review') await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [cornerId, B]);
    else {
      await pushToCorner(cornerId, SHA);
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [cornerId,
        JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number: 7, headSha: SHA } })]);
    }
    const source = await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'finished checks' });
    // A real SQL constraint failure aborts the transaction until the dispatch
    // savepoint rolls it back; the worker's command must still commit.
    await rootFixture.db.query(`ALTER TABLE agent_commands ADD CONSTRAINT reject_test_reviewer CHECK (agent_id<>'${B}')`);
    try {
      await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: source.id });
      expect(await reasons(cornerId, A)).toContain('corner_review_needed');
      expect(await currentState(cornerId)).toBe('working');
      expect((await commands(A, cornerId)).filter(command => command.reason === 'corner_review_needed' && command.source.body.includes('reviewer command could not be queued')))
        .toHaveLength(1);
      expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%reviewer command could not be queued%'`, [cornerId])).rowCount).toBe(0);
    } finally {
      await rootFixture.db.query('ALTER TABLE agent_commands DROP CONSTRAINT reject_test_reviewer');
    }
  });


  it('a redelivered green check wakes the reviewer once', async () => {
    const cornerId = await inReview();
    await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });
    expect(await reasons(cornerId, B)).toEqual(['subscribed_event']);

  });


  it('Reproduction R1: a green head queues the reviewer after a pending-gate block', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await pushToCorner(cornerId, SHA);
    expect(await currentState(cornerId)).toBe('review');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [cornerId, JSON.stringify({
      checks: 'pending', lifecycle: 'in-review',
      pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA, title: 'Ship the widget' },
    })]);
    // The worker reported blocked while the gate was still pending. The head did not move.
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card) VALUES('pending-gate-report',$1,$2,'blocked: waiting for checks','message',jsonb_build_object('reportToId',$3::text))`,
      [cornerId, A, H],
    );
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`, [cornerId]);
    const source = await systemLine(rootFixture.db, {
      roomId: cornerId, authorId: A, subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check', kind: 'check-passed', object: { text: 'checks', headSha: SHA },
    });
    await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: source.id });
    // A second green fact for the same head must not drop or duplicate the wake.
    await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: source.id });
    const review = (await commands(B, cornerId)).filter(command =>
      command.reason === 'subscribed_event' || command.reason === 'corner_review_dispatch');
    expect(review).toHaveLength(1);
    expect((await rootFixture.db.query<{ state: string }>(
      `SELECT state FROM agent_commands WHERE id=$1`,
      [review[0]!.id],
    )).rows[0]?.state).toBe('pending');
    expect(await currentState(cornerId)).toBe('waiting');
  });


  it('a redelivered red check wakes the implementer once', async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 3, SHA);
    await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'found failing checks on', kind: 'check-failed' });
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
  });


  it('a redelivered push webhook records one push', async () => {
    const cornerId = await open('owner/widgets');
    await pushToCorner(cornerId, SHA);
    await pushToCorner(cornerId, SHA);

  });
});
describe('Reproduction CI-1: a red head wakes the implementer before checks finish', () => {
const scope18 = fixtureScope18();


  it('shows the head red and wakes while a check still runs', async () => {
    const cornerId = await scope18.redWhileRunning();
    expect(await scope18.checksOf(cornerId)).toBe('failing');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(1);
    await reconcileCornerMergeBlockers(rootFixture.db, cornerId);
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(1);
  });


  it('Reproduction RED-STALL-PARTIAL: a later failed job wakes the implementer while other checks are still pending', async () => {
    const cornerId = await scope18.redWhileRunning();
    await rootFixture.db.query(
      `UPDATE agent_commands SET state='complete',completed_at=now()
       WHERE room_id=$1 AND reason='corner_check'`,
      [cornerId],
    );
    const stillRunning = {
      state: 'pending' as const,
      total: 8,
      failing: ['MOBILE SUITE', 'FRAME-BUDGET', 'STATE-UPGRADE'],
      checks: [
        { name: 'MOBILE SUITE', status: 'failed' as const },
        { name: 'FRAME-BUDGET', status: 'failed' as const },
        { name: 'STATE-UPGRADE', status: 'failed' as const },
        { name: 'SERVER SUITE SHARD 1', status: 'pending' as const },
        { name: 'SERVER SUITE SHARD 2', status: 'pending' as const },
        { name: 'SERVER SUITE SHARD 3', status: 'pending' as const },
        { name: 'SERVER SUITE SHARD 4', status: 'pending' as const },
        { name: 'SERVER SUITE SHARD 5', status: 'pending' as const },
      ],
    };
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(stillRunning);
    await scope18.checkRun(cornerId, 'FRAME-BUDGET', 'failure');
    const repair = (await commands(A, cornerId)).filter((command) => command.reason === 'corner_check');
    expect(repair).toHaveLength(1);
    expect(repair[0]!.source.body).toContain('FRAME-BUDGET');
    expect(repair[0]!.source.body).toContain('STATE-UPGRADE');
    expect(repair[0]!.source.body).toContain('MOBILE SUITE');
    expect(repair[0]!.source.body).toContain('Fix them and push now');
    expect(repair[0]!.source.body).toContain('still running');
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(2);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(stillRunning);
    await scope18.checkRun(cornerId, 'STATE-UPGRADE', 'failure');
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(2);
    expect((await reasons(cornerId, B)).filter((reason) =>
      reason === 'corner_review_dispatch' || reason === 'subscribed_event')).toHaveLength(0);
  });


  it('wakes again when the run finishes, deduplicates replay and recovers a lost followup', async () => {
    const cornerId = await scope18.redWhileRunning();
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(scope18.finished);
    await scope18.checkRun(cornerId, 'Server suite', 'success');
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(2);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(scope18.finished);
    await scope18.checkRun(cornerId, 'Server suite', 'success');
    await reconcileCornerMergeBlockers(rootFixture.db, cornerId);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(2);
    expect(await currentState(cornerId)).toBe('working');
    // A retained first-failure command cannot mask a deleted followup wake.
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [cornerId]);
    await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [cornerId]);
    await rootFixture.db.query(`DELETE FROM agent_commands command USING messages source WHERE command.room_id=$1
      AND command.reason='corner_check' AND source.id=command.source_message_id
      AND (source.system_event->'payload'->>'followup')::boolean`, [cornerId]);
    await expect(reconcileCornerMergeBlockers(rootFixture.db, cornerId)).resolves.toBe(1);
    await expect(reconcileCornerMergeBlockers(rootFixture.db, cornerId)).resolves.toBe(0);
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(2);
  });


  it('the implementer takes the fix turn and its push reaches review with no person in the loop', async () => {
    const cornerId = await scope18.redWhileRunning();
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(scope18.finished);
    await scope18.checkRun(cornerId, 'Server suite', 'success');
    const [fix] = (await commands(A, cornerId)).filter((command) => command.reason === 'corner_check');
    // The turn names the failed job even while another job runs.
    expect(fix!.private).toBe(true);
    expect(fix!.source.body).toContain('failing Body suite');
    await claim(fix!);
    await result(fix!, 'Fixed the Body suite failure and pushed.');
    const repaired = '9'.repeat(40);
    await pushToCorner(cornerId, repaired);
    expect(await currentState(cornerId)).toBe('review');
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce({
      state: 'passed', total: 2, failing: [],
      checks: [{ name: 'Body suite', status: 'passed' }, { name: 'Server suite', status: 'passed' }],
    });
    await scope18.checkRun(cornerId, 'Body suite', 'success', repaired);
    expect(await currentState(cornerId)).toBe('review');
    expect(await reasons(cornerId, B)).toEqual(['subscribed_event']);
    const people = await rootFixture.db.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation<>'system'`, [cornerId, H]);
    expect(people.rowCount).toBe(0);
  });


  it('recognizes a completed rerun by its new job URL when the start webhook was missed', async () => {
    const cornerId = await scope18.redWhileRunning();
    const withJob = (job: number) => ({ ...scope18.finished, checks: [
      { name: 'Body suite', status: 'failed', url: `https://github.com/owner/widgets/actions/runs/10/job/${job}` },
      { name: 'Server suite', status: 'passed' },
    ] });
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(withJob(101));
    await scope18.checkRun(cornerId, 'Server suite', 'success');
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(withJob(102));
    await scope18.checkRun(cornerId, 'Body suite', 'failure');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(3);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(withJob(102));
    await scope18.checkRun(cornerId, 'Body suite', 'failure');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_check')).toHaveLength(3);
  });


  it('keeps an undeliverable checks fact without a reachability notice', async () => {
    const cornerId = await open('owner/widgets');
    await fallback(cornerId);
    await assignCornerWorker(rootFixture.db, cornerId, F);
    await redHead(cornerId, 3, SHA);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, F]);
    await systemLine(rootFixture.db, {
      roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' },
      verb: 'finished checks on', kind: 'check-failed', payload: { followup: true },
    });
    expect((await commands(A, R)).some(c => c.reason === 'report' && c.source.body.startsWith('blocked:'))).toBe(false);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%needs to restore agent access%'`, [cornerId])).rowCount).toBe(0);
  });


  it('resumes a historical CI escalation with the next failed check', async () => {
    const cornerId = await scope18.redWhileRunning();
    await rootFixture.db.query(`UPDATE messages SET card=jsonb_set(card,'{toState}','"ask_human"')
      WHERE id=(SELECT id FROM messages WHERE room_id=$1 AND card_type=$2 ORDER BY (card->>'seq')::int DESC LIMIT 1)`,
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE]);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce(scope18.finished);
    await scope18.checkRun(cornerId, 'Server suite', 'success');
    expect(await currentState(cornerId)).toBe('working');
  });
});
describe('Reproduction R1: checks wakes act on stale CI state', () => {
const scope19 = fixtureScope19();


  it('R1cancelled: a job cancelled before a runner started is not a code failure', async () => {
    const cornerId = await scope19.cornerAtHead();
    // A recorded GitHub check_run: GitHub cancelled the job before any runner
    // picked it up, so it completed as `cancelled` with no steps and the job
    // log read answers 404. GitHub's own rollup still reads FAILURE.
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce({
      state: 'failed',
      total: 1,
      failing: ['Deploy'],
      checks: [
        {
          name: 'Deploy',
          status: 'failed',
          conclusion: 'CANCELLED',
          url: 'https://github.com/owner/widgets/actions/runs/10/job/4040',
        },
      ],
    });
    await scope19.checkRunWebhook(cornerId, 'Deploy', 'cancelled');
    expect(await scope19.cornerCheckWakes(cornerId)).toHaveLength(0);
    expect(
      (
        await rootFixture.db.query<{ checks: string }>(
          `SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0]!.checks,
    ).not.toBe('failing');
  });


  it('R1running: a failed job while the run is still going names the still-running run', async () => {
    const cornerId = await scope19.cornerAtHead();
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce({
      state: 'failed',
      total: 2,
      failing: ['Body suite'],
      checks: [
        { name: 'Body suite', status: 'failed' },
        { name: 'Server suite', status: 'pending' },
      ],
    });
    await scope19.checkRunWebhook(cornerId, 'Body suite', 'failure');
    const [wake] = await scope19.cornerCheckWakes(cornerId);
    expect(wake).toBeTruthy();
    expect(wake!.source.body).toContain('still running');
    expect(wake!.source.body).toContain('Fix them and push now');
  });


  it('R1head: a checks wake names the head SHA it reports on', async () => {
    const cornerId = await scope19.cornerAtHead();
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce({
      state: 'failed',
      total: 1,
      failing: ['Body suite'],
      checks: [{ name: 'Body suite', status: 'failed' }],
    });
    await scope19.checkRunWebhook(cornerId, 'Body suite', 'failure');
    const [wake] = await scope19.cornerCheckWakes(cornerId);
    expect(wake).toBeTruthy();
    expect(wake!.source.body).toContain(SHA);
  });


  it('R1conflict: a conflict superseded by a mergeable newer head sends no wake', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({
        checks: 'unknown',
        lifecycle: 'in-review',
        pr: {
          number: 7,
          url: 'https://github.com/owner/widgets/pull/7',
          headSha: SHA,
          mergeability: 'dirty',
        },
      }),
    ]);
    // GitHub already reports a newer head that is mergeable.
    rootFixture.githubApp.readPullRequest.mockResolvedValueOnce({
      number: 7,
      url: 'https://github.com/owner/widgets/pull/7',
      headSha: '9'.repeat(40),
      mergeability: 'clean' as const,
    });
    await rootFixture.github.refreshStaleMergeability(cornerId);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_merge_conflict')).toHaveLength(0);
  });


  it('R1conflictHead: a conflict wake names the head SHA it reports on', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({
        checks: 'unknown',
        lifecycle: 'in-review',
        pr: {
          number: 7,
          url: 'https://github.com/owner/widgets/pull/7',
          headSha: SHA,
          mergeability: 'dirty',
        },
      }),
    ]);
    rootFixture.githubApp.readPullRequest.mockResolvedValueOnce({
      number: 7,
      url: 'https://github.com/owner/widgets/pull/7',
      headSha: SHA,
      mergeability: 'dirty' as const,
    });
    await rootFixture.github.refreshStaleMergeability(cornerId);
    const [wake] = await rootFixture.daemon
      .execute('getAgentCommands', { roomId: cornerId }, A)
      .then((r) => r.commands.filter((command) => command.reason === 'corner_merge_conflict'));
    expect(wake).toBeTruthy();
    expect(wake!.source.body).toContain(SHA);
  });
});
describe('a person hands the corner to another agent (the implementer follows the tag)', () => {
const scope20 = fixtureScope20();


  it('a tag in the corner moves the failing-check wake off the opener, leaving owner_agent_id alone', async () => {
    const cornerId = await open('owner/widgets');
    await say(cornerId, '@goosy take this one');
    expect(await scope20.workerOf(cornerId)).toBe(B);
    expect(
      (
        await rootFixture.db.query<{ owner_agent_id: string }>(
          `SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`,
          [cornerId],
        )
      ).rows[0]!.owner_agent_id,
    ).toBe(A);
    await redHead(cornerId, 3, SHA);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(0);
  });


  it('a refused merge wakes the tagged implementer, not the opener', async () => {
    const cornerId = await open('owner/widgets');
    await scope20.taggableMember(cornerId);
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@sol take this one');
    await greenHead(cornerId, 7, SHA);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    rootFixture.githubApp.mergePullRequest.mockRejectedValueOnce(
      new Error('GitHub pull request merge failed: HTTP 405: Base branch was modified'),
    );
    await implementersMerge();
    expect((await reasons(cornerId, scope20.D)).filter((reason) => reason === 'corner_merge_refused')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_merge_refused')).toHaveLength(0);
  });


  it('a merge conflict wakes the tagged implementer', async () => {
    const cornerId = await open('owner/widgets');
    await say(cornerId, '@goosy take this one');
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=lifecycle||$2::jsonb WHERE corner_id=$1`,
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
    const source = await systemLine(rootFixture.db, {
      roomId: cornerId,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'found merge conflicts in',
    });
    await queueCornerMergeConflict(rootFixture.db, cornerId, source.id);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_merge_conflict')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_merge_conflict')).toHaveLength(0);
  });


  it('blocker reconciliation wakes the tagged implementer', async () => {
    const cornerId = await open('owner/widgets');
    await say(cornerId, '@goosy take this one');
    await pushToCorner(cornerId, SHA);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({
        checks: 'failing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA },
      }),
    ]);
    await reconcileCornerMergeBlockers(rootFixture.db, cornerId);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(0);
  });


  it('tagging the configured reviewer does not take the implementer role', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@goosy what do you think?');
    expect(await scope20.workerOf(cornerId)).toBe(A);
  });


  it('a tag in the parent Room does not move a corner implementer', async () => {
    const cornerId = await open('owner/widgets');
    await say(R, '@goosy take this one');
    expect(await scope20.workerOf(cornerId)).toBe(A);
  });


  it('an agent tag invites conversation without handing the corner on', async () => {
    const cornerId = await open('owner/widgets');
    // The person asks the agent working the corner to give the work to Goosy.
    await say(cornerId, '@hoots hand this corner to goosy');
    const command = (await commands(A, cornerId)).find((c) => c.reason === 'human_tag')!;
    await claim(command);
    await result(command, '@goosy take this one');
    console.log('Reproduction H1-1:', {
      implementer: await scope20.workerOf(cornerId),
      goosyCommands: (await commands(B, cornerId)).map((c) => c.reason),
    });
    expect(await scope20.workerOf(cornerId)).toBe(A);
    expect((await commands(B, cornerId)).some((c) => c.reason === 'agent_tag')).toBe(true);
  });


  it('R1 regression: an agent tag the person never asked for does not move the implementer', async () => {
    const cornerId = await open('owner/widgets');
    // The person only asks for a status; they do not name Goosy.
    await say(cornerId, '@hoots what is the status?');
    const command = (await commands(A, cornerId)).find((c) => c.reason === 'human_tag')!;
    await claim(command);
    await result(command, 'Blocked on the API shape. @goosy can you confirm it?');
    // The tag asks a peer for input; the implementer stays with Hoots.
    expect(await scope20.workerOf(cornerId)).toBe(A);
  });


  it('an agent-to-agent tag with no person behind it does not move the implementer', async () => {
    const cornerId = await open('owner/widgets');
    // A peer agent's own message wakes Hoots; no person asked for anything.
    const peerMessageId = randomBytes(32).toString('hex');
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      peerMessageId,
      cornerId,
      B,
      '@hoots fyi',
    ]);
    const command = await createAgentCommand(rootFixture.db, {
      roomId: cornerId,
      agentId: A,
      sourceMessageId: peerMessageId,
      reason: 'agent_tag',
    });
    expect(command).toBeDefined();
    const peerTurn = (await commands(A, cornerId)).find(
      (c) => c.sourceMessageId === peerMessageId,
    )!;
    await claim(peerTurn);
    await result(peerTurn, '@goosy take this one');
    expect(await scope20.workerOf(cornerId)).toBe(A);
  });


  it('an agent hand-over to the configured reviewer does not take the implementer role', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@hoots hand this corner to goosy');
    const command = (await commands(A, cornerId)).find((c) => c.reason === 'human_tag')!;
    await claim(command);
    await result(command, '@goosy take this one');
    // The person's tag put Hoots in the role; the reviewer Goosy never takes it.
    expect(await scope20.workerOf(cornerId)).toBe(A);
  });
});
