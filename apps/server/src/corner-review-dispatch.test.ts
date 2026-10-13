import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PushDeliveryLoop } from './background.js';
import { systemLine } from './system-line.js';
import { createAgentCommand, noteBlockedCornerChecks, reconcileConfiguredCornerReviewers } from './agent-command.js';
import { advanceCorner } from './corner-lifecycle.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { AgentCommand } from '@beeline/api-contract/daemon';
const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
const commands = (agentId = A, roomId = R) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);
async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute(
    'claimAgentCommand',
    { roomId: c.roomId, commandId: c.id, generationId },
    c.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: c.roomId,
      agentId: c.agentId,
      requestId: c.turnRequestId,
      generationId,
      status: 'working',
    },
    c.agentId,
  );
}
const result = (c: AgentCommand, text: string, generationId = 'g1', extra = {}) =>
  daemon.execute(
    'postRoomMessage',
    {
      roomId: c.roomId,
      requestId: c.turnRequestId,
      generationId,
      text,
      ...extra,
    },
    c.agentId,
  );
beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy')`,
    [H, A, B],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Attribution')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1,created_by=$3 WHERE id=$2`, [R, C, A]);
  // A repository Room: its corners have a pull request path.
  await db.query(
    `UPDATE rooms SET repository_key='owner/widgets',repository_resolution='repository' WHERE id=$1`,
    [R],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Do work','{"checks":"unknown"}')`,
    [C, A],
  );
  for (const who of [H, A, B])
    for (const room of [null, R, C])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM messages WHERE room_id=$1`, [C]);
  await db.query(`DELETE FROM corner_brief_revisions WHERE corner_id=$1`, [C]);
  await db.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`UPDATE memberships SET event_subscriptions='[]'::jsonb`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL,reviewer_fallback_ids='{}'::text[]`);
  await db.query(
    `UPDATE corner_facts SET lifecycle='{"checks":"unknown"}'::jsonb,command_check_state=NULL,
       review_handback_head=NULL,review_handback_count=0,commissioned_by=$1,worker_agent_id=NULL`,
    [H],
  );
});

/** Put the corner in the state a green transition leaves it in. */
async function greenHead(number: number, headSha: string, checks = 'passing') {
  await db.query(
    `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks,
        lifecycle: 'in-review',
        pr: { number, url: `https://github.com/acme/repo/pull/${number}`, headSha },
      }),
    ],
  );
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
}

describe('corner message attribution', () => {
  // Reproduction ZC-1: GitHub reports no rollup for a PR with no checks, so no
  // check webhook exists to create the configured reviewer's command.
  it('wakes the configured reviewer for a zero-check PR, privately asks the implementer to report when no reviewer is configured', async () => {
    let headSha = '1'.repeat(40);
    const checkGate = vi.fn(async () => ({
      checks: 'pending' as const,
      checkCount: 0,
      pullRequest: 'https://github.com/acme/repo/pull/7',
      headSha,
      approvalPending: true,
      reviewer: '@goosy',
      reviewerExists: true,
      reviewerWake: { status: 'waiting' as const, detail: 'No checks have reported.' },
      rule: 'Only the configured reviewer records PASS.',
    }));
    daemon = new DaemonService(
      db,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      checkGate,
    );
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
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
    const source = await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'requested work',
    });
    await createAgentCommand(db, {
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
        await db.query<{ lifecycle: { checks: string; checksSummary: { total: number } } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [C],
        )
      ).rows[0]?.lifecycle,
    ).toMatchObject({ checks: 'passing', checksSummary: { total: 0 } });

    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
    await db.query(`DELETE FROM agent_commands`);
    headSha = '2'.repeat(40);
    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(jsonb_set(lifecycle-'checksSummary','{checks}','"unknown"'),
       '{pr,headSha}',to_jsonb($2::text)),command_check_state=NULL WHERE corner_id=$1`,
      [C, headSha],
    );
    const opening = await createAgentCommand(db, {
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
      body: 'This pull request has no checks and no reviewer. Landing needs your commander\'s yes. Ask your commander using your normal report tool.',
    } });
    expect((await commands(B, R)).filter(command => command.reason === 'report' && command.source.body.includes('pending your yes'))).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM messages WHERE text LIKE '%ready to land pending your yes%'
      OR text LIKE '%Landing needs your commander%'`)).rowCount).toBe(0);
    expect((await commands(A, C)).filter(command => command.reason === 'corner_land')).toHaveLength(0);
  });

  it('stores the REVIEWER as author when the reviewer posts the review into a corner it does not own', async () => {
    // Corner owned by Hoots (A); Goosy (B) is the configured reviewer on the
    // parent Room and a member of parent + corner with a check-passed
    // subscription — the production review flow.
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: '1'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
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
      await db.query<{ author_id: string; text: string }>(
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
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(11, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@human the reproduction is missing. Fix that and push.');
    expect(await commands(A, C)).toEqual([]);
    expect((await db.query<{ workflow_state: string }>(
      `SELECT workflow_state FROM corner_facts WHERE corner_id=$1`, [C],
    )).rows[0]?.workflow_state).toBe('review');
  });

  it('leaves the reviewer a single turn when its verdict tags the worker itself', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
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
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(14, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [C],
    );
    // What the check webhook reports when a re-run starts on the same head.
    await advanceCorner(db, C, { kind: 'checks-pending' });
    await result(review!, 'Checks are still running on this head; I will look when they land.');
    expect(await commands(A, C)).toEqual([]);
    // The next green transition dispatches the reviewer again, unspent.
    await greenHead(14, '1'.repeat(40));
    expect((await commands(B, C)).map((command) => command.reason)).toEqual(['subscribed_event']);
  });

  it('Reproduction C3-1: a green re-report on the same head does not re-wake a reviewer that already reviewed it', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
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

  it('Reproduction REVIEW-READY-1: a green corner already in review recovers its missing reviewer wake', async () => {
    const head = '7'.repeat(40);
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(23, head);
    const [firstReview] = await commands(B, C);
    expect(firstReview).toBeDefined();
    // The state is still review with passing checks, but the command was
    // lost. Re-reporting the same green head used to refuse this wake.
    await db.query(`DELETE FROM agent_commands WHERE id=$1`, [firstReview!.id]);
    expect(await commands(B, C)).toHaveLength(0);
    const reconciled = await reconcileConfiguredCornerReviewers(db, R);
    const rereviews = await commands(B, C);
    console.info(`Reproduction REVIEW-READY-1: wrong=0 reviewer commands; right=1; observed=${rereviews.length}`);
    expect(reconciled.commands).toBe(1);
    expect(rereviews).toHaveLength(1);
    expect(rereviews[0]?.agentId).toBe(B);
    expect((await db.query<{ lifecycle: { pr: { headSha: string }; checks: string } }>(
      `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [C],
    )).rows[0]?.lifecycle).toMatchObject({ pr: { headSha: head }, checks: 'passing' });
    expect((await reconcileConfiguredCornerReviewers(db, R)).commands).toBe(0);
  });

  it('Reproduction REVIEW-READY-2: a FAIL and the worker reply trade tags on the unchanged green head without a server handback', async () => {
    const head = 'b'.repeat(40);
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(27, head);
    const [firstReview] = await commands(B, C);
    await claim(firstReview!);
    const findings = `@hoots FAIL on ${head}: the PR description lacks demonstration evidence.`;
    await result(firstReview!, findings);
    const [repair] = await commands(A, C);
    expect(repair?.reason).toBe('agent_tag');
    expect(repair?.source.body).toBe(findings);
    await claim(repair!);
    const reply = '@goosy Added both demonstrations to the PR description; the code and head are unchanged.';
    await result(repair!, reply);
    // The worker's tag wakes the reviewer; the sweep adds no second wake.
    const [rereview] = await commands(B, C);
    expect(rereview?.reason).toBe('agent_tag');
    expect((await reconcileConfiguredCornerReviewers(db, R)).commands).toBe(0);
    expect((await db.query<{ workflow_state: string; review_handback_count: number }>(
      `SELECT workflow_state,review_handback_count FROM corner_facts WHERE corner_id=$1`, [C],
    )).rows[0]).toEqual({ workflow_state: 'review', review_handback_count: 0 });
  });

  it('returns a completed review without PASS to the implementer without re-waking the reviewer on that head', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(28, 'c'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: demonstration is missing.');
    expect((await reconcileConfiguredCornerReviewers(db, R)).commands).toBe(1);
    const handback = await commands(A, C);
    expect(handback.map(command => command.reason)).toEqual(['corner_review_needed']);
    expect(handback[0]?.source.body).toContain('the review ended without a PASS on the current head');
    expect(handback[0]?.source.body).toContain('report the blocker to its commander');
    for (let sweep = 2; sweep <= 3; sweep += 1)
      expect((await reconcileConfiguredCornerReviewers(db, R)).commands).toBe(0);
    expect((await commands(A, C)).map(command => command.id)).toEqual(handback.map(command => command.id));
    expect(await commands(B, C)).toEqual([]);
    // A new head is a new review.
    await greenHead(28, 'd'.repeat(40));
    expect((await commands(B, C)).map((command) => command.reason)).toEqual(['subscribed_event']);
  });

  it('returns missing review configuration to the implementer', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(24, '8'.repeat(40));
    await db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, B]);
    await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
    await reconcileConfiguredCornerReviewers(db, R);
    expect(await commands(B, C)).toHaveLength(0);
    expect((await commands(A, C)).map(command => command.reason)).toContain('corner_review_needed');
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='corner-merge-yes'`, [C])).rowCount).toBe(0);
  });

  it('reports an unavailable reviewer list privately to its commander', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B, reviewerFallbackIds: [A] }, H);
    await greenHead(25, '9'.repeat(40));
    expect(await commands(B, C)).toHaveLength(0);
    expect((await commands(A, R)).filter(command => command.reason === 'report')
      .some(command => command.private && command.source.body.startsWith('blocked: no reviewer on the configured list'))).toBe(true);
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%healthy enough to review%'`, [C])).rowCount).toBe(0);
  });

  it('reports the failure privately and wakes the implementer when reviewer command insertion cannot queue', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(26, 'a'.repeat(40));
    await db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, B]);
    await db.query(`
      CREATE FUNCTION refuse_review_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.room_id='${C}' AND NEW.agent_id='${B}' THEN
          RAISE EXCEPTION 'review queue denied by trigger';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_review_command BEFORE INSERT ON agent_commands
        FOR EACH ROW EXECUTE FUNCTION refuse_review_command();
    `);
    try {
      await reconcileConfiguredCornerReviewers(db, R);
      expect(await commands(B, C)).toHaveLength(0);
      expect((await commands(A, R)).filter(command => command.reason === 'report')
        .some(command => command.private && command.source.body.includes('reviewer command could not be queued'))).toBe(true);
      expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%review queue denied by trigger%'`, [C])).rowCount).toBe(0);
      const handback = await commands(A, C);
      expect(handback.map(command => command.reason)).toEqual(['corner_review_needed']);
      expect(handback[0]?.source.body).toContain('review queue denied by trigger');
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS refuse_review_command ON agent_commands; DROP FUNCTION IF EXISTS refuse_review_command();`);
    }
  });

  it('hands a brief mismatch to the author, then reviews the repaired head', async () => {
    await db.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,1,'A1: preserve the agreed label',$2,$3)`,
      [C, A, R],
    );
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(19, '1'.repeat(40));
    const [firstReview] = await commands(B, C);
    await claim(firstReview!);
    await result(
      firstReview!,
      '@hoots F1: A1 is unmet; the agreed label is missing. Repair it and rerun affected checks.',
    );
    const [repair] = await commands(A, C);
    expect(repair).toBeDefined();
    await claim(repair!);
    await result(repair!, 'Fixed F1; the agreed label is present and the affected check passed.');
    expect(
      (await db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [C])).rowCount,
    ).toBe(0);

    await greenHead(19, '2'.repeat(40));
    const [secondReview] = await commands(B, C);
    expect(secondReview).toBeDefined();
    await claim(secondReview!);
    await expect(
      daemon.execute(
        'approveCornerMerge',
        {
          cornerId: C,
          headSha: '2'.repeat(40),
        },
        B,
      ),
    ).resolves.toMatchObject({ status: 'approved', headSha: '2'.repeat(40) });
    expect(
      (
        await db.query<{ head_sha: string }>(
          `SELECT head_sha FROM corner_merge_approvals WHERE corner_id=$1`,
          [C],
        )
      ).rows,
    ).toEqual([{ head_sha: '2'.repeat(40) }]);
  });

  it('wakes the implementer without a person push when failing checks outlast a fix with no push', async () => {
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('human-device-token-123456789012345678902',$1,'android','physical')`,
      [H],
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const push = new PushDeliveryLoop(db, { send });
    await push.runOnce();
    const head = '7'.repeat(40);
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      C,
      JSON.stringify({
        checks: 'failing',
        lifecycle: 'in-review',
        pr: {
          number: 21,
          title: 'Fix widget',
          url: 'https://github.com/acme/repo/pull/21',
          headSha: head,
        },
      }),
    ]);
    await systemLine(db, {
      roomId: C,
      authorId: A,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'found failing checks on',
      kind: 'check-failed',
      object: { text: 'Fix widget', url: 'https://github.com/acme/repo/pull/21', headSha: head },
    });
    const [fix] = (await commands(A, C)).filter((command) => command.reason === 'corner_check');
    expect(fix).toBeDefined();
    await claim(fix!);
    // While the fix turn runs, nothing is blocked.
    expect(await noteBlockedCornerChecks(db)).toBe(0);
    await result(fix!, 'I could not fix the failing test.');
    // The turn just ended; a pushed fix may still be on its way from GitHub.
    expect(await noteBlockedCornerChecks(db)).toBe(0);
    await db.query(
      `UPDATE agent_commands SET completed_at=now()-interval '3 minutes' WHERE id=$1`,
      [fix!.id],
    );
    expect(await noteBlockedCornerChecks(db)).toBe(1);
    expect(await noteBlockedCornerChecks(db)).toBe(0);
    const retry = (await commands(A, C)).find(command => command.reason === 'corner_check');
    expect(retry?.source.body).toContain('checks still fail on Fix widget and the fix turn ended with nothing new pushed');
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='corner-checks-blocked'`, [C])).rowCount).toBe(0);
    await push.runOnce();
    expect(send).not.toHaveBeenCalled();
    await claim(retry!);
    await result(retry!, '@human please decide whether this check can be removed?');
    await push.runOnce();
    expect(send.mock.calls.map(([, message]) => message.text)).toEqual([
      'Hoots: @human please decide whether this check can be removed?',
    ]);
    await db.query(`DELETE FROM push_devices WHERE identity_id=$1`, [H]);
  });

  it.each([false, true])('notifies an Attention requester about a non-repository deliverable only when tagged (tagged=%s)', async (tagged) => {
    await db.query(
      `UPDATE rooms SET repository_key=NULL,repository_resolution='none' WHERE id=$1`,
      [R],
    );
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('human-device-token-123456789012345678903',$1,'android','physical')`,
      [H],
    );
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const push = new PushDeliveryLoop(db, { send });
      await push.runOnce();
      const source = await systemLine(db, {
        roomId: C,
        authorId: H,
        subject: { kind: 'person', id: H, name: 'Human' },
        verb: 'requested work',
      });
      await createAgentCommand(db, {
        roomId: C,
        agentId: A,
        sourceMessageId: source.id,
        reason: 'corner_objective',
      });
      const [worker] = await commands(A, C);
      await claim(worker!);
      // What post_artifact queues for the turn's final reply.
      await db.query(
        `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id,generation_id)
         VALUES($1,$2,'https://example.test/media/report','report.pdf','application/pdf',10,$3,'g1')`,
        [C, A, worker!.turnRequestId],
      );
      const text = tagged ? '@human The report is attached.' : 'The report is attached.';
      await result(worker!, text);
      await push.runOnce();
      expect(send.mock.calls.map(([, message]) => message.text)).toEqual(
        tagged ? [`Hoots: ${text}`] : [],
      );
    } finally {
      await db.query(
        `UPDATE rooms SET repository_key='owner/widgets',repository_resolution='repository' WHERE id=$1`,
        [R],
      );
      await db.query(`DELETE FROM push_devices WHERE identity_id=$1`, [H]);
    }
  });

  it('does not call a corner blocked once a new head replaces the failing one', async () => {
    const head = '8'.repeat(40);
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      C,
      JSON.stringify({ checks: 'failing', pr: { number: 22, headSha: head } }),
    ]);
    await systemLine(db, {
      roomId: C,
      authorId: A,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'found failing checks on',
      kind: 'check-failed',
      object: { text: 'pull request #22', headSha: head },
    });
    const [fix] = (await commands(A, C)).filter((command) => command.reason === 'corner_check');
    await claim(fix!);
    await result(fix!, 'Pushed a fix.');
    await db.query(
      `UPDATE agent_commands SET completed_at=now()-interval '3 minutes' WHERE id=$1`,
      [fix!.id],
    );
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      C,
      JSON.stringify({ checks: 'pending', pr: { number: 22, headSha: '9'.repeat(40) } }),
    ]);
    expect(await noteBlockedCornerChecks(db)).toBe(0);
  });

  // Reproduction REVIEW-HANDBACK-NULL: a corner an agent opened off its own
  // root message records no requester, so the cap stopped the handbacks and
  // said nothing — the transcript ended on the reviewer's last round.
  it('keeps a configured reviewer as the review target even when it is not a corner member', async () => {
    // Remove Goosy (B) from the CORNER (it stays a parent-Room member and the
    // configured reviewer). The check passes. Where does the review command go?
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      C,
      B,
    ]);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 8, url: 'https://github.com/acme/repo/pull/8', headSha: '2'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const routed = (
      await db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1`,
        [C],
      )
    ).rows;
    console.log('routed:', JSON.stringify(routed));
    expect(routed).toHaveLength(1);
    expect(routed[0]!.agent_id).toBe(B);
  });

  it('wakes the implementer without consuming green when the reviewer is not a parent member', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      R,
      B,
    ]);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 9, url: 'https://github.com/acme/repo/pull/9', headSha: '3'.repeat(40) },
        }),
      ],
    );
    await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const routed = (
      await db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1`,
        [C],
      )
    ).rows;
    expect(routed).toEqual([{ agent_id: A, reason: 'corner_review_needed' }]);
    expect((await commands(A, C))[0]?.source.body).toContain('the configured reviewer is unreachable');
    expect(
      (
        await db.query<{ command_check_state: string | null }>(
          `SELECT command_check_state FROM corner_facts WHERE corner_id=$1`,
          [C],
        )
      ).rows[0]?.command_check_state,
    ).toBeNull();
    expect(
      (
        await db.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`,
          [C],
        )
      ).rows.map((row) => row.text),
    ).toEqual([]);
    expect((await commands(A, R)).filter(command => command.reason === 'report')
      .some(command => command.private && command.source.body.includes('not a current member of the parent Room'))).toBe(true);
  });

  it('names a parent-member reviewer it cannot deliver into the corner and still retries', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      C,
      B,
    ]);
    await db.query(`
      CREATE FUNCTION keep_reviewer_off_corner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.room_id='${C}' AND NEW.identity_id='${B}' THEN
          NEW.removed_at := now();
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER keep_reviewer_off_corner BEFORE INSERT OR UPDATE ON memberships
        FOR EACH ROW EXECUTE FUNCTION keep_reviewer_off_corner();
    `);
    try {
      await db.query(
        `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
        [
          C,
          JSON.stringify({
            checks: 'passing',
            lifecycle: 'in-review',
            pr: {
              number: 10,
              url: 'https://github.com/acme/repo/pull/10',
              headSha: '4'.repeat(40),
            },
          }),
        ],
      );
      await systemLine(db, {
        roomId: C,
        authorId: H,
        subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check',
        kind: 'check-passed',
      });
      expect(
        (
          await db.query<{ agent_id: string; reason: string }>(
            `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1`,
            [C],
          )
        ).rows,
      ).toEqual([{ agent_id: A, reason: 'corner_review_needed' }]);
      expect(
        (
          await db.query<{ command_check_state: string | null }>(
            `SELECT command_check_state FROM corner_facts WHERE corner_id=$1`,
            [C],
          )
        ).rows[0]?.command_check_state,
      ).toBeNull();
      expect(
        (
          await db.query<{ text: string }>(
            `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`,
            [C],
          )
        ).rows.map((row) => row.text),
      ).toEqual([]);
      expect((await commands(A, R)).filter(command => command.reason === 'report')
        .some(command => command.private && command.source.body.includes('not a current member of this corner'))).toBe(true);
    } finally {
      await db.query(`
        DROP TRIGGER IF EXISTS keep_reviewer_off_corner ON memberships;
        DROP FUNCTION IF EXISTS keep_reviewer_off_corner();
      `);
    }
    await greenHead(10, '4'.repeat(40));
    expect((await commands(B, C)).map(command => command.reason)).toEqual(['subscribed_event']);
  });
});

describe('the corner implementer the workflow wakes follows a person hand-over', () => {
  it('a blocked-checks line keys on the current implementer, not the opener', async () => {
    const head = 'a'.repeat(40);
    await db.query(`UPDATE corner_facts SET worker_agent_id=$2,lifecycle=$3::jsonb WHERE corner_id=$1`, [
      C,
      B,
      JSON.stringify({
        checks: 'failing',
        lifecycle: 'in-review',
        pr: { number: 31, url: 'https://github.com/acme/repo/pull/31', headSha: head },
      }),
    ]);
    const source = await systemLine(db, {
      roomId: C,
      authorId: A,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'found failing checks on',
      object: { text: 'Fix widget', headSha: head },
    });
    await createAgentCommand(db, { roomId: C, agentId: B, sourceMessageId: source.id, reason: 'corner_check' });
    // The opener still holds an unclaimed fix turn: reading the opener would
    // stop the blocked line and hide the current implementer's ended turn.
    await createAgentCommand(db, { roomId: C, agentId: A, sourceMessageId: source.id, reason: 'corner_check' });
    await db.query(
      `UPDATE agent_commands SET state='complete',completed_at=now()-interval '3 minutes'
       WHERE room_id=$1 AND agent_id=$2`,
      [C, B],
    );
    expect(await noteBlockedCornerChecks(db)).toBe(1);
  });

  it('a zero-check PR is completed for the current implementer, not the opener', async () => {
    const checkGate = vi.fn(async () => ({
      checks: 'pending' as const,
      checkCount: 0,
      pullRequest: 'https://github.com/acme/repo/pull/7',
      headSha: '1'.repeat(40),
      approvalPending: true,
      reviewer: '@hoots',
      reviewerExists: true,
      reviewerWake: { status: 'waiting' as const, detail: 'No checks have reported.' },
      rule: 'Only the configured reviewer records PASS.',
    }));
    daemon = new DaemonService(
      db,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      checkGate,
    );
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    await db.query(`UPDATE corner_facts SET worker_agent_id=$2,lifecycle=$3::jsonb WHERE corner_id=$1`, [
      C,
      B,
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
    const source = await systemLine(db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'requested work',
    });
    await createAgentCommand(db, {
      roomId: C,
      agentId: B,
      sourceMessageId: source.id,
      reason: 'human_tag',
    });
    const [worker] = await commands(B, C);
    await claim(worker!);
    await result(worker!, 'https://github.com/acme/repo/pull/7');
    expect(checkGate).toHaveBeenCalledOnce();
    expect(
      (
        await db.query<{ lifecycle: { checks: string } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [C],
        )
      ).rows[0]?.lifecycle.checks,
    ).toBe('passing');
  });
});
