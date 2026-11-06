import { cornerRunStateSql, assembleTurnPrompt, cornerReviewerInstruction, describe, expect, it, vi, DaemonService, LiveHub, systemLine, createAgentCommand, reconcileConfiguredCornerReviewers, advanceCorner, H, A, B, W, R, C, db, phone, daemon, commands, claim, result, greenHead, rootFixture, type AgentCommand } from './corner-review-dispatch.test-support.js';

describe('corner message attribution', () => {
  it('REVIEW-SOURCE-1 reads only current brief citations during an assigned review', async () => {
    const source = '44444444-4444-4444-8444-444444444444';
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Brief source')`, [source,W]);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,presentation,text) VALUES
      ('review-approval',$1,$2,'message','Approved scope'),
      ('review-intent',$1,$2,'message','Original intent'),
      ('review-private',$1,$2,'message','Unrelated private message')`, [source,H]);
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,
      source_room_id,source_message_id,approval_basis,intent_verbatim) VALUES
      ($1,1,'Review scope','Review scope',$2,$3,'review-approval',
      '{"sourceMessageId":"review-approval"}',
      '[{"sourceMessageId":"review-intent","snapshot":"Original intent"}]')`, [C,H,source]);
    await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R,B]);
    await greenHead(7, 'a'.repeat(40));
    const [review] = await commands(B,C);
    expect(review).toBeDefined();
    await claim(review!);
    const read = (messageId: string, agent = B) => rootFixture.daemon.execute('getRoomMessage', {roomId:C,messageId}, agent);
    await expect(read('review-approval')).resolves.toMatchObject({body:'Approved scope'});
    await expect(read('review-intent')).resolves.toMatchObject({body:'Original intent'});
    await expect(rootFixture.daemon.execute('getRoomMessage', {roomId:C,messageId:'review-intent',offset:9},B))
      .resolves.toMatchObject({body:'intent'});
    await expect(read('review-private')).rejects.toThrow('message access denied');
    await expect(read('review-approval',A)).rejects.toThrow('message access denied');
    await expect(rootFixture.daemon.execute('getRoomMessage', {roomId:source,messageId:'review-approval'},B))
      .resolves.toMatchObject({body:'Approved scope'});
    expect((await rootFixture.db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2`, [source,B])).rowCount).toBe(0);
    await rootFixture.daemon.execute('postAgentTurnReceipt', {roomId:C,requestId:review!.turnRequestId,
      generationId:'g1',status:'complete'}, B);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await rootFixture.db.query(`UPDATE agent_commands SET state='claimed',completed_at=NULL WHERE id=$1`, [review!.id]);
    await expect(read('review-approval')).resolves.toMatchObject({body:'Approved scope'});
    await rootFixture.db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [review!.id]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await rootFixture.db.query(`UPDATE agent_commands SET state='claimed' WHERE id=$1`, [review!.id]);
    await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [C]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await rootFixture.db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [C]);
    await rootFixture.db.query(`UPDATE corner_brief_revisions SET revision=2 WHERE corner_id=$1`, [C]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await rootFixture.db.query(`UPDATE corner_brief_revisions SET revision=1 WHERE corner_id=$1`, [C]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"') WHERE corner_id=$1`, [C]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await rootFixture.db.query(`DELETE FROM rooms WHERE id=$1`, [source]);
  });

  it.each([false, true])('REVIEW-SOURCE-2 reads the approval DM transcript during review (different owner: %s)', async differentOwner => {
    const source = '55555555-5555-4555-8555-555555555555';
    const sibling = '66666666-6666-4666-8666-666666666666';
    const otherOwner = 'd'.repeat(64);
    const briefRevision = differentOwner ? 4 : 1;
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other owner','other-owner')
      ON CONFLICT DO NOTHING`, [otherOwner]);
    await rootFixture.db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [B,differentOwner ? otherOwner : H]);
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
      VALUES($1,$2,'Approval DM','[]')`, [source,W]);
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id)
      VALUES($1,$2,'Source child',$3)`, [sibling,W,source]);
    const approval = '1'.repeat(64), surrounding = '2'.repeat(64), childMessage = '3'.repeat(64);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,presentation,text) VALUES
      ($1,$4,$6,'message','Approved scope'),
      ($2,$4,$6,'message','Prior human decision'),
      ($3,$5,$6,'message','Outside source Room')`, [approval,surrounding,childMessage,source,sibling,H]);
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,
      source_room_id,source_message_id,approval_basis) VALUES
      ($1,$5,'Review scope','Review scope',$2,$3,$4,jsonb_build_object('sourceMessageId',$4::text))`,
      [C,H,source,approval,briefRevision]);
    await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R,B]);
    await greenHead(7, 'a'.repeat(40));
    const [review] = await commands(B,C);
    const transcript = (agent = B) => rootFixture.daemon.execute('getRoomConversation', {roomId:source,limit:10},agent);
    await expect(transcript()).resolves.toMatchObject({items: expect.arrayContaining([
      expect.objectContaining({id:approval}),
    ])});
    await claim(review!);
    await expect(transcript()).resolves.toMatchObject({items: expect.arrayContaining([
      expect.objectContaining({id:approval,body:'Approved scope'}),
      expect.objectContaining({id:surrounding,body:'Prior human decision'}),
    ])});
    await expect(rootFixture.daemon.execute('getRoomMessage',{roomId:source,messageId:surrounding},B))
      .resolves.toMatchObject({body:'Prior human decision'});
    await expect(transcript(A)).rejects.toThrow();
    await expect(rootFixture.daemon.execute('getRoomInbox',{roomId:source},B)).rejects.toThrow();
    await expect(rootFixture.daemon.execute('postRoomMessage',{
      roomId:source,requestId:review!.turnRequestId,generationId:'g1',text:'Outside assignment',
    },B)).rejects.toThrow();
    await expect(rootFixture.daemon.execute('listRoomMembers',{roomId:source},B)).rejects.toThrow();
    await expect(rootFixture.daemon.execute('getRoomConversation',{roomId:sibling},B)).rejects.toThrow();
    await expect(rootFixture.daemon.execute('getRoomMessage',{roomId:source,messageId:childMessage},B)).rejects.toThrow();
    expect((await rootFixture.db.query('SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2',[source,B])).rowCount).toBe(0);
    for (const state of ['complete','cancelled']) {
      await rootFixture.db.query('UPDATE agent_commands SET state=$2 WHERE id=$1',[review!.id,state]);
      await expect(transcript()).rejects.toThrow();
    }
    await rootFixture.db.query("UPDATE agent_commands SET state='claimed' WHERE id=$1",[review!.id]);
    for (const purpose of ['repair','verdict']) {
      await rootFixture.db.query(`UPDATE agent_commands SET review_context=review_context || jsonb_build_object('purpose',$2::text) WHERE id=$1`,[review!.id,purpose]);
      await expect(transcript()).rejects.toThrow();
    }
    await rootFixture.db.query("UPDATE agent_commands SET review_context=review_context-'purpose' WHERE id=$1",[review!.id]);
    await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[R,B]);
    await expect(transcript()).rejects.toThrow();
    await rootFixture.db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2',[R,B]);
    const otherWorkspace = '77777777-7777-4777-8777-777777777777';
    await rootFixture.db.query("INSERT INTO workspaces(id,name) VALUES($1,'Other workspace')",[otherWorkspace]);
    await rootFixture.db.query('UPDATE rooms SET workspace_id=$2 WHERE id=$1',[source,otherWorkspace]);
    await expect(transcript()).rejects.toThrow();
    await rootFixture.db.query('UPDATE rooms SET workspace_id=$2 WHERE id=$1',[source,W]);
    await rootFixture.db.query('DELETE FROM workspaces WHERE id=$1',[otherWorkspace]);
    await rootFixture.db.query('UPDATE messages SET deleted_at=now() WHERE id=$1',[approval]);
    await expect(transcript()).rejects.toThrow();
    await rootFixture.db.query('UPDATE messages SET deleted_at=NULL WHERE id=$1',[approval]);
    await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[C]);
    await expect(transcript()).rejects.toThrow();
    await rootFixture.db.query('UPDATE rooms SET archived_at=NULL WHERE id=$1',[C]);
    await rootFixture.db.query('UPDATE corner_brief_revisions SET revision=revision+1 WHERE corner_id=$1',[C]);
    await expect(transcript()).rejects.toThrow();
    await rootFixture.db.query('UPDATE corner_brief_revisions SET revision=revision-1 WHERE corner_id=$1',[C]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"') WHERE corner_id=$1`,[C]);
    await expect(transcript()).rejects.toThrow();
    await rootFixture.db.query('DELETE FROM rooms WHERE id=$1',[source]);
    await rootFixture.db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1',[B,H]);
  });


  it('wakes the configured reviewer for a zero-check PR, privately asks the implementer to report when no reviewer is configured', async () => {
    let headSha = '1'.repeat(40);
    const checkGate = vi.fn(async () => ({
      checks: 'pending' as const,
      checkCount: 0,
      zeroChecksConfirmed: true,
      pullRequest: 'https://github.com/acme/repo/pull/7',
      headSha,
      approvalPending: true,
      reviewer: '@goosy',
      reviewerExists: true,
      reviewerWake: { status: 'waiting' as const, detail: 'No checks have reported.' },
      rule: 'Only the configured reviewer records PASS.',
    }));
    rootFixture.daemon = new DaemonService(
      rootFixture.db,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      checkGate,
    );
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      C,
      JSON.stringify({
        checks: 'unknown',
        lifecycle: 'in-review',
        pr: {
          number: 7,
          url: 'https://github.com/acme/repo/pull/7',
          headSha: '1'.repeat(40),
          mergeability: 'clean',
        },
      }),
    ]);
    const source = await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'requested work',
    });
    await createAgentCommand(rootFixture.db, {
      roomId: C,
      agentId: A,
      sourceMessageId: source.id,
      reason: 'corner_objective',
    });
    const [worker] = await commands(A, C);
    await claim(worker!);
    await result(worker!, 'https://github.com/acme/repo/pull/7');

    expect(checkGate).toHaveBeenCalledOnce();
    expect((await commands(B, C)).map((command) => command.reason)).toEqual(['subscribed_event']);
    expect(
      (
        await rootFixture.db.query<{ lifecycle: { checks: string; checksSummary: { total: number } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [C],
        )
      ).rows[0]?.lifecycle,
    ).toMatchObject({ checks: 'passing', checksSummary: { total: 0 } });

    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
    await rootFixture.db.query('DELETE FROM free_agents WHERE agent_id=$1', [B]);
  // Each case starts a fresh failure episode despite reusing the same corner.
  await rootFixture.db.query(`DELETE FROM agent_startup_backoff`);
  await rootFixture.db.query(`DELETE FROM agent_commands`);
    headSha = '2'.repeat(40);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(jsonb_set(lifecycle-'checksSummary','{checks}','"unknown"'),
       '{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`,
      [C, headSha],
    );
    const opening = await createAgentCommand(rootFixture.db, {
      roomId: C, agentId: A, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: B, fromRoomId: R, text: 'Finish the work' },
    });
    const noReviewerWorker = (await commands(A, C)).find(command => command.id === opening!.id);
    await claim(noReviewerWorker!, 'g2');
    await result(noReviewerWorker!, 'https://github.com/acme/repo/pull/7', 'g2');
    expect(checkGate).toHaveBeenCalledTimes(2);
    const notices = (await commands(A, C)).filter(command => command.reason === 'corner_review_needed');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ private: true, source: {
      body: expect.stringContaining('This pull request has no checks and no reviewer. Landing needs your commander\'s yes. Ask your commander using your normal report tool.'),
    } });
    expect((await commands(B, R)).filter(command => command.reason === 'report' && command.source.body.includes('pending your yes'))).toHaveLength(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text LIKE '%ready to land pending your yes%'
      OR text LIKE '%Landing needs your commander%'`)).rowCount).toBe(0);
    expect((await commands(A, C)).filter(command => command.reason === 'corner_land')).toHaveLength(0);
  });


  it.each(['final', 'post'] as const)('Reproduction REVIEW-HEAD-1: a late old-head %s verdict cannot wake the worker', async surface => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(81, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await greenHead(81, '2'.repeat(40));
    if (surface === 'final') await result(review!, '@hoots FAIL: repair the old head.');
    else await rootFixture.daemon.execute('postCornerMessage', { roomId: C, cornerId: C, requestId: review!.turnRequestId,
      generationId: 'g1', text: '@hoots FAIL: repair the old head.' }, B);
    expect(await commands(A, C)).toEqual([]);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%repair the old head%'`, [C])).rowCount).toBe(0);
  });


  it('Reproduction REVIEW-HEAD-1: a queued repair is dropped when its reviewed head moves', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(82, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@hoots FAIL: repair this head.');
    await greenHead(82, '2'.repeat(40));
    expect(await commands(A, C)).toEqual([]);
  });


  it('Reproduction REVIEW-HEAD-1: a queued reviewer report is dropped at its commander after a push', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(84, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await rootFixture.daemon.execute('report', { roomId: C, requestId: review!.turnRequestId,
      generationId: 'g1', status: 'done', text: 'done: FAIL on the reviewed head.' }, B);
    await greenHead(84, '2'.repeat(40));
    expect((await commands(A, R)).filter(c => c.reason === 'report' && c.source.body.includes('FAIL on the reviewed head'))).toEqual([]);
  });


  it('WAKE-STORM: repeated restores use committed PR state without reading GitHub', async () => {
    await greenHead(83, '1'.repeat(40));
    const refresh = vi.fn(async () => { throw new Error('GitHub rate limit'); });
    Object.assign(rootFixture.daemon, { github: { refreshCornerReviewHead: refresh } });
    for (let attempt = 0; attempt < 20; attempt++) {
      const restored = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: C }, A);
      expect(restored.lifecycle?.pr?.headSha).toBe('1'.repeat(40));
    }
    expect(refresh).not.toHaveBeenCalled();
  });


  it('Reproduction REVIEW-HEAD-1: a worker that pushes while repairing hands off the new head', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(83, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@hoots FAIL: repair this head.');
    const [repair] = await commands(A, C);
    await claim(repair!);
    // The committed push is the new handoff target. The machine adapter keeps
    // the ordinary reply's provider validation outside the command transaction.
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`, [C, '2'.repeat(40)]);
    const refreshed = vi.fn();
    Object.assign(rootFixture.daemon, { github: { refreshCornerReviewHead: refreshed } });
    await result(repair!, '@goosy The fix is pushed; please review.');
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledWith(C);
    const next = (await commands(B, C)).find(c => c.reason === 'agent_tag');
    expect(next?.source.body).toContain(`Current handoff target: PR #83 at ${'2'.repeat(40)}`);
    const target = (await rootFixture.db.query<{ context: { headSha: string } }>('SELECT review_context context FROM agent_commands WHERE id=$1', [next!.id])).rows[0]?.context;
    expect(target?.headSha).toBe('2'.repeat(40));
  });


  it('stores the REVIEWER as author when the reviewer posts the review into a corner it does not own', async () => {
    // Corner owned by Hoots (A); Goosy (B) is the configured reviewer on the
    // parent Room and a member of parent + corner with a check-passed
    // subscription — the production review flow.
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: '1'.repeat(40) },
        }),
      ],
    );
    await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const [review] = await commands(B, C);
    expect(review?.reason).toBe('subscribed_event');
    await claim(review!);
    await result(review!, 'Review complete: the race is fixed, approved.');
    const rows = (
      await rootFixture.db.query<{ author_id: string; text: string }>(
        `SELECT author_id,text FROM messages WHERE room_id=$1 AND text LIKE 'Review complete%'`,
        [C],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author_id).toBe(B);
  });


  // Only the reviewer's PASS moves review; a verdict that tags nobody (or a
  // person) is an ordinary message and wakes no agent.
  it('wakes nobody and stays in review when a review without a PASS tags no agent', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(11, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    // A check event is not a human assignment, even when its fixture author is human.
    await expect(result(review!, '@human the reproduction is missing. Fix that and push.'))
      .rejects.toThrow('not your direct commander');
    await result(review!, 'The reproduction is missing. Fix that and push.');
    expect(await commands(A, C)).toEqual([]);
    expect((await rootFixture.db.query<{ workflow_state: string }>(
      `SELECT ${cornerRunStateSql('$1::uuid')} workflow_state`, [C],
    )).rows[0]?.workflow_state).toBe('review');
  });


  it('leaves the reviewer a single turn when its verdict tags the worker itself', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(12, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@hoots approved, merge it.');
    // The typed tag routes first and keeps the row; the handoff must not add a
    // second turn for the same reply.
    const handoff = await commands(A, C);
    expect(handoff.map((command) => command.reason)).toEqual(['agent_tag']);
  });


  it('hands nothing back when the reviewer ends a turn on a head that is not green', async () => {
    // A reviewer that ends its turn to WAIT for CI has not finished reviewing.
    // Pushing the worker here would send it at a pull request still mid-run.
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(14, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [C],
    );
    // What the check webhook reports when a re-run starts on the same head.
    await advanceCorner(rootFixture.db, C, { kind: 'checks-pending' });
    await result(review!, 'Checks are still running on this head; I will look when they land.');
    expect(await commands(A, C)).toEqual([]);
    // The next green transition dispatches the reviewer again, unspent.
    await greenHead(14, '1'.repeat(40));
    expect((await commands(B, C)).map((command) => command.reason)).toEqual(['subscribed_event']);
  });


  it('Reproduction C3-1: a green re-report on the same head does not re-wake a reviewer that already reviewed it', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(21, '7'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    // The reviewer ends the turn without a PASS; nothing is handed back.
    await result(review!, 'Review complete: this head needs a fix.');
    expect(await commands(A, C)).toEqual([]);
    // The same head's green verdict is re-reported (a CI re-run or a redelivery).
    await greenHead(21, '7'.repeat(40));
    const reviewerWakes = (await commands(B, C)).filter(
      (command) => command.reason === 'subscribed_event',
    );
    console.info(
      `Reproduction C3-1: wrong=1 re-wake of a reviewed head; right=0; observed=${reviewerWakes.length}`,
    );
    expect(reviewerWakes).toHaveLength(0);
  });


  it.each(['FAIL: fix the demonstration.', '**FAIL**: A1 is unmet.', 'Verdict: FAIL: A1 is unmet.', 'PASS: reviewed all changed files.',
    'FAIL: the diff is empty; there is nothing to review.'])(
    'Reproduction REVIEW-QUIET-1: duplicate green deliveries retain %s', async verdict => {
      await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
      const head = '9'.repeat(40);
      await greenHead(71, head);
      const [review] = await commands(B, C);
      await claim(review!);
      await result(review!, verdict);
      // A pending/green cycle writes new lifecycle cards, losing the old
      // outstanding-command window. The source event has no head field.
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [C]);
      await advanceCorner(rootFixture.db, C, { kind: 'checks-pending' });
      await greenHead(71, head);
      for (let cycle = 0; cycle < 3; cycle++) await reconcileConfiguredCornerReviewers(rootFixture.db, R);
      expect(await commands(B, C)).toEqual([]);
      const handback = (await commands(A, C)).find(command => command.reason === 'corner_review_needed');
      expect(handback?.source.body).toContain(verdict);
      expect(handback?.source.body).not.toContain('ended without a PASS');
      // Finishing the handback permits the next review after a new push.
      await claim(handback!);
      await result(handback!, 'The next push contains the requested evidence.');
      await greenHead(71, '8'.repeat(40));
      const [continuation] = await commands(B, C);
      expect(continuation?.source.body).toContain('Prior reviewer verdict and evidence');
      expect(continuation?.source.body).toContain(verdict);
      console.info(`Demonstrated REVIEW-QUIET-1: repeated green deliveries suppressed; continuation carries ${verdict}`);
    });


  it('Reproduction REVIEW-HEAD-1: changed checks do not repeat a verdict on the same head', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(72, '9'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: required evidence is missing.');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary}',
      '{"checks":[{"name":"new-required-check","status":"passed"}]}') WHERE corner_id=$1`, [C]);
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect(await commands(B, C)).toEqual([]);
  });


  it.each(['pending', 'complete'] as const)(
    'Reproduction REVIEW-PR-1: a replacement PR on the same head supersedes a %s review', async state => {
      await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
      const head = '9'.repeat(40);
      await greenHead(73, head);
      const [old] = await commands(B, C);
      if (state === 'complete') {
        await claim(old!);
        await result(old!, 'FAIL: the diff is empty.');
      }
      await greenHead(74, head);
      const reviews = await commands(B, C);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.id).not.toBe(old?.id);
      const rows = await rootFixture.db.query<{ context: { pullRequest: number }; state: string }>(
        'SELECT review_context context,state FROM agent_commands WHERE id=$1', [old!.id]);
      expect(rows.rows[0]?.state).toBe(state === 'pending' ? 'cancelled' : 'complete');
    });


  it('Reproduction REVIEW-FAIL-HANDOFF-1: an explicit wait postpones handback without reporting a wake failure', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(82, 'a'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: demonstrate the missing user path.');
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card)
      VALUES('explicit-wait',$1,$2,'blocked: waiting for a decision','message',jsonb_build_object('reportToId',$3::text))`, [C, A, H]);
    for (let cycle = 0; cycle < 3; cycle++) await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect(await commands(B, C)).toHaveLength(0);
    expect(await commands(A, C)).toHaveLength(0);
    expect((await commands(A, R)).filter(c => c.reason === 'report')).toHaveLength(0);
    await rootFixture.db.query(`UPDATE messages SET card=jsonb_set(card,'{waitingAnswered}','true') WHERE room_id=$1 AND card->>'reportToId' IS NOT NULL`, [C]);
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect((await commands(A, C)).filter(c => c.reason === 'corner_review_needed')).toHaveLength(1);
  });


  it('Reproduction REVIEW-FAIL-HANDOFF-1: a consumed failed-review handback is not a failed wake or another reviewer assignment', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    // The reviewer previously ordered the implementer to repair this corner.
    // Lifecycle reports inherit that order and therefore return to the reviewer.
    const order = await createAgentCommand(rootFixture.db, { roomId: C, agentId: A, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Repair this corner', authorId: B, fromRoomId: C, kind: 'order' } });
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [order!.id]);
    await greenHead(81, 'a'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: demonstrate the missing user path.');
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    const [repair] = (await commands(A, C)).filter(c => c.reason === 'corner_review_needed');
    expect(repair?.source.body).toContain('FAIL: demonstrate the missing user path.');
    expect(await commands(B, C)).toHaveLength(0);
    await claim(repair!);
    await result(repair!, 'Waiting for the requested evidence before pushing.');
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card)
      VALUES('explicit-wait',$1,$2,'blocked: waiting for a decision','message',jsonb_build_object('reportToId',$3::text))`, [C, A, H]);
    for (let cycle = 0; cycle < 3; cycle++) await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    const failures = await rootFixture.db.query(`SELECT id FROM agent_commands WHERE reason='report'
      AND private_payload->>'text' LIKE '%implementer cannot be woken%'`);
    expect(failures.rowCount).toBe(0);
    expect(await commands(B, C)).toHaveLength(0);
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE room_id=$1
      AND reason='corner_review_needed'`, [C])).rowCount).toBe(1);
    await greenHead(81, 'b'.repeat(40));
    expect(await commands(B, C)).toHaveLength(1);
  });


  it.each(['pending', 'claimed'] as const)('Reproduction REVIEW-WORK-1: no repair wake or report while implementer is %s', async (state) => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(62, '5'.repeat(40));
    const [lost] = await commands(B, C);
    await rootFixture.db.query('DELETE FROM agent_commands WHERE id=$1', [lost!.id]);
    const worker = await createAgentCommand(rootFixture.db, { roomId: C, agentId: A, sourceMessageId: null,
      privatePayload: { text: 'Fix in progress', authorId: H, fromRoomId: R, kind: 'order' }, reason: 'order' });
    expect(worker).toBeDefined();
    if (state === 'claimed') await claim((await commands(A, C))[0]!);
    await reconcileConfiguredCornerReviewers(rootFixture.db);
    expect(await commands(B, C)).toHaveLength(0);
    expect((await commands(A, R)).filter(c => c.reason === 'report')).toHaveLength(0);
    expect((await commands(A, C)).filter(c => c.reason === 'corner_review_needed')).toHaveLength(0);
  });


  it('Reproduction REVIEW-READY-1: a green corner already in review recovers its missing reviewer wake', async () => {
    const head = '7'.repeat(40);
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(23, head);
    const [firstReview] = await commands(B, C);
    expect(firstReview).toBeDefined();
    // The state is still review with passing checks, but the command was
    // lost. Re-reporting the same green head used to refuse this wake.
    await rootFixture.db.query(`DELETE FROM agent_commands WHERE id=$1`, [firstReview!.id]);
    expect(await commands(B, C)).toHaveLength(0);
    const reconciled = await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    const rereviews = await commands(B, C);
    console.info(`Reproduction REVIEW-READY-1: wrong=0 reviewer commands; right=1; observed=${rereviews.length}`);
    expect(reconciled.commands).toBe(1);
    expect(rereviews).toHaveLength(1);
    expect(rereviews[0]?.agentId).toBe(B);
    expect((await rootFixture.db.query<{ lifecycle: { pr: { headSha: string }; checks: string } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [C],
    )).rows[0]?.lifecycle).toMatchObject({ pr: { headSha: head }, checks: 'passing' });
    expect((await reconcileConfiguredCornerReviewers(rootFixture.db, R)).commands).toBe(0);
  });


  it('Reproduction REVIEW-HEAD-1: a worker tag does not repeat a finished review on the unchanged head', async () => {
    const head = 'b'.repeat(40);
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(27, head);
    const [firstReview] = await commands(B, C);
    await claim(firstReview!);
    const findings = `@hoots FAIL on ${head}: the PR description lacks demonstration evidence.`;
    await result(firstReview!, findings);
    const [repair] = await commands(A, C);
    expect(repair?.reason).toBe('agent_tag');
    expect(repair?.source.body).toContain(findings);
    expect(repair?.source.body).toContain(`Current handoff target: PR #27 at ${head}`);
    await claim(repair!);
    const reply = '@goosy Added both demonstrations to the PR description; the code and head are unchanged.';
    await result(repair!, reply);
    // A new commit is needed before this head can be reviewed again.
    expect(await commands(B, C)).toEqual([]);
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect(await commands(B, C)).toEqual([]);
    expect((await rootFixture.db.query<{ workflow_state: string }>(
      `SELECT ${cornerRunStateSql('corner_id')} workflow_state FROM corner_facts WHERE corner_id=$1`, [C],
    )).rows[0]).toEqual({ workflow_state: 'review' });
  });


  it('returns a completed review without PASS to the implementer without re-waking the reviewer on that head', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(28, 'c'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: demonstration is missing.');
    expect((await reconcileConfiguredCornerReviewers(rootFixture.db, R)).commands).toBe(1);
    const handback = await commands(A, C);
    expect(handback.map(command => command.reason)).toEqual(['corner_review_needed']);
    expect(handback[0]?.source.body).toContain('the reviewer completed its review of the current head');
    expect(handback[0]?.source.body).toContain('report the blocker to its commander');
    for (let sweep = 2; sweep <= 3; sweep += 1)
      expect((await reconcileConfiguredCornerReviewers(rootFixture.db, R)).commands).toBe(0);
    expect((await commands(A, C)).map(command => command.id)).toEqual(handback.map(command => command.id));
    expect(await commands(B, C)).toEqual([]);
    // Completing the handback without a push must not automatically repeat
    // the rejected review on each background reconciliation.
    await claim(handback[0]!);
    await result(handback[0]!, 'The draft still needs its demonstration.');
    for (let sweep=0;sweep<3;sweep++) {
      await reconcileConfiguredCornerReviewers(rootFixture.db, R);
      expect(await commands(B, C)).toEqual([]);
    }
    // A new head is a new review.
    await greenHead(28, 'd'.repeat(40));
    expect((await commands(B, C)).map((command) => command.reason)).toEqual(['subscribed_event']);
  });


  it('names the brief revision current at dispatch in the review wake', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    for (const revision of [1, 2])
      await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
        VALUES($1,$2,'Brief','Brief',$3,$4)`, [C, revision, A, R]);
    await greenHead(29, 'e'.repeat(40));
    const [review] = await commands(B, C);
    expect(review?.source.body).toContain('Review against brief revision 2');
    expect(review?.source.body).not.toContain('revision 1');
  });


  it.each(['reviewer', 'worker'] as const)('Reproduction %s: delivered revision 2 instructions are replaced by current revision 3', async (role) => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,2,'Keep the PR open','Keep the PR open',$2,$3)`, [C, A, R]);
    const headSha = 'e'.repeat(40);
    let delivered: AgentCommand;
    if (role === 'reviewer') {
      await greenHead(29, headSha);
      delivered = (await commands(B, C))[0]!;
    } else {
      const order = await createAgentCommand(rootFixture.db, {
        roomId: C, agentId: A, sourceMessageId: null, reason: 'order',
        privatePayload: { kind: 'order', authorId: B, fromRoomId: R,
          text: 'Under brief revision 2, close the PR.' },
      });
      delivered = (await commands(A, C)).find(command => command.id === order!.id)!;
    }
    // Delivery precedes the revision: queued-wake cancellation cannot repair this copy.
    await claim(delivered);
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,3,'Keep the PR open','Keep the PR open and implement the fix.',$2,$3)`, [C, A, R]);
    const restore = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: C }, delivered.agentId);
    const prompt = assembleTurnPrompt({
      surface: 'code-corner',
      brief: { brief: restore.brief!, fileLines: [], missingRequiredFile: false },
      ...(role === 'reviewer' ? { reviewerTarget: cornerReviewerInstruction({
        isReviewer: true, pullRequestNumber: 29, headSha, briefRevision: 2,
      })! } : {}),
      task: { body: delivered.source.body, commandReason: delivered.reason },
    }).text;
    console.info(`Reproduction ${role === 'reviewer' ? 'R1' : 'R2'}: delivered revision 2; current revision 3; replacement notice=${prompt.includes('Replaced instructions')}`);
    expect(prompt).toContain('Replaced instructions');
    expect(prompt).toContain('Read the current brief revision 3 before acting');
    expect(prompt).toContain('Keep the PR open and implement the fix.');
    if (role === 'reviewer') {
      expect(prompt).toContain(`Review PR 29 at ${headSha} against brief revision 3`);
      expect(prompt).not.toContain(`Review PR 29 at ${headSha} against brief revision 2`);
    }
  });


  it.each(['delivery', 'claim'])('Reproduction STALE-CAUSE-1: same-timestamp brief wakes retain a successor at %s', async boundary => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const assignment = async (revision: number, queue = true) => {
        await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
          VALUES($1,$2,'Brief',$3,$4,$5)`, [C, revision, `Brief at ${revision}`, H, R]);
        if (!queue) return;
        const line = await systemLine(rootFixture.db, { roomId: C,
          subject: { kind: 'person', id: H, name: 'Ada' }, verb: 'revised the corner brief',
          object: { text: `Revision ${revision}`, id: C } });
        await createAgentCommand(rootFixture.db, { roomId: C, agentId: A, sourceMessageId: line.id,
          reason: 'corner_brief_revision' });
      };
      await assignment(1);
      const [old] = await commands(A, C);
      await assignment(2, false);
      // An incomplete producer cannot take away the only wake.
      expect((await commands(A, C)).map(c => c.id)).toContain(old!.id);
      const human = await rootFixture.phone.execute('sendRoomMessage', { roomId: C, text: '@hoots keep this instruction' }, H);
      const line = await systemLine(rootFixture.db, { roomId: C,
        subject: { kind: 'person', id: H, name: 'Ada' }, verb: 'revised the corner brief',
        object: { text: 'Revision 2', id: C } });
      const replacement = await createAgentCommand(rootFixture.db, { roomId: C, agentId: A,
        sourceMessageId: line.id, reason: 'corner_brief_revision' });
      // A timestamp comparison cannot distinguish these durable causes.
      await rootFixture.db.query(`UPDATE corner_brief_revisions SET created_at=now() WHERE corner_id=$1`, [C]);
      await rootFixture.db.query(`UPDATE agent_commands SET created_at=now() WHERE room_id=$1`, [C]);
      if (boundary === 'claim') await expect(claim(old!)).rejects.toThrow();
      const delivered = await commands(A, C);
      expect(delivered.map(c => c.id)).not.toContain(old!.id);
      expect(delivered.map(c => c.id)).toContain(replacement!.id);
      expect(delivered.some(c => c.sourceMessageId === human.messageId)).toBe(true);
      await expect(claim(old!)).rejects.toThrow();
      await commands(A, C);
      const drops = log.mock.calls.flatMap(args => args.filter(arg => typeof arg === 'string' && arg.startsWith('{')))
        .map(arg => JSON.parse(arg)).filter(entry => entry.event === 'wake_dropped_stale' && entry.commandId === old!.id);
      expect(drops).toHaveLength(1);
      expect(drops[0]).toMatchObject({ kind: 'corner_brief_revision',
        recorded: { brief: { briefRevision: 1 } }, current: { briefRevision: 2 } });
      await claim(delivered.find(c => c.id === replacement!.id)!);
    } finally {
      log.mockRestore();
      await rootFixture.db.query('DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2', [C, H]);
    }
  });


  it('Reproduction STALE-2: an implementer assignment wake shows the live brief revision, not the queued one', async () => {
    // Queue the implementer wake a brief revision writes: the revision row,
    // its system line, and the corner_brief_revision assignment command.
    const assignment = async (revision: number) => {
      await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
        VALUES($1,$2,'Brief',$3,$4,$5)`, [C, revision, `Brief at ${revision}`, H, R]);
      const line = await systemLine(rootFixture.db, {
        roomId: C,
        subject: { kind: 'person', id: H, name: 'Ada' },
        verb: 'revised the corner brief',
        object: { text: `Revision ${revision}`, id: C },
      });
      await createAgentCommand(rootFixture.db, {
        roomId: C, agentId: A, sourceMessageId: line.id, reason: 'corner_brief_revision',
      });
    };
    await assignment(2);
    const [queued] = await commands(A, C);
    expect(queued?.reason).toBe('corner_brief_revision');
    expect(queued?.source.body).toContain('Revision 2');
    // The brief advances before the implementer's turn starts.
    await assignment(3);
    const delivered = (await commands(A, C)).filter(
      (command) => command.reason === 'corner_brief_revision',
    );
    const queuedState = (
      await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])
    ).rows[0]?.state;
    console.info(
      `Reproduction STALE-2: wrong=1 assignment naming Revision 2; right=1; observed=${delivered.filter((command) => command.source.body.includes('Revision 2')).length}`,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.source.body).toContain('Revision 3');
    expect(delivered[0]?.source.body).not.toContain('Revision 2');
    expect(queuedState).toBe('cancelled');
    console.log(
      'Demonstrated Reproduction STALE-2: implementer assignment at revision 2 cancelled; live revision 3 assignment delivered',
    );
  });


  it('Reproduction STALE-3: drops a review wake whose head moved before the reviewer claims it', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    const headA = '3'.repeat(40), headB = '4'.repeat(40);
    const green = async (number: number, headSha: string) => {
      await rootFixture.db.query(
        `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
        [C, JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number, url: `https://github.com/acme/repo/pull/${number}`, headSha } })],
      );
      await systemLine(rootFixture.db, { roomId: C, authorId: H, subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check', kind: 'check-passed', object: { text: 'ci', headSha } });
    };
    await green(43, headA);
    const [queued] = await commands(B, C);
    expect(queued?.reason).toBe('subscribed_event');
    expect(queued?.source.body).toContain(headA);
    // A newer head lands before the reviewer's turn starts.
    await green(43, headB);
    const staleDelivered = (await commands(B, C)).filter(
      (command) => command.source.body.includes(headA),
    );
    const queuedState = (
      await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])
    ).rows[0]?.state;
    console.info(
      `Reproduction STALE-3: wrong=1 review naming ${headA.slice(0, 8)}; right=0; observed=${staleDelivered.length}`,
    );
    expect(staleDelivered).toHaveLength(0);
    expect(queuedState).toBe('cancelled');
    // The current head gets its review wake, naming that head.
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    const current = (await commands(B, C)).filter((command) =>
      command.source.body.includes(headB),
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.source.body).not.toContain(headA);
    console.log(
      'Demonstrated Reproduction STALE-3: review wake for moved head dropped; reviewer woken for current head',
    );
  });
});
