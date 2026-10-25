import { readFileSync } from 'node:fs';
import { assembleTurnPrompt, cornerReviewerInstruction } from '../../body/src/prompt-assembly.js';
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
    for (const room of [null, R])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db?.close());
beforeEach(async () => {
  daemon = new DaemonService(db, new LiveHub());
  // These lifecycle fixtures model an independent PR author; provider checks have separate coverage.
  Object.assign(daemon, { github: { assertCornerReviewerNotAuthor: async () => {} } });
  await db.query('DELETE FROM free_agents WHERE agent_id=$1', [B]);
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
  it('REVIEW-SOURCE-1 reads only current brief citations during an assigned review', async () => {
    const source = '44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Brief source')`, [source,W]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,presentation,text) VALUES
      ('review-approval',$1,$2,'message','Approved scope'),
      ('review-intent',$1,$2,'message','Original intent'),
      ('review-private',$1,$2,'message','Unrelated private message')`, [source,H]);
    await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,
      source_room_id,source_message_id,approval_basis,intent_verbatim) VALUES
      ($1,1,'Review scope','Review scope',$2,$3,'review-approval',
      '{"sourceMessageId":"review-approval"}',
      '[{"sourceMessageId":"review-intent","snapshot":"Original intent"}]')`, [C,H,source]);
    await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R,B]);
    await greenHead(7, 'a'.repeat(40));
    const [review] = await commands(B,C);
    expect(review).toBeDefined();
    await claim(review!);
    const read = (messageId: string, agent = B) => daemon.execute('getRoomMessage', {roomId:C,messageId}, agent);
    await expect(read('review-approval')).resolves.toMatchObject({body:'Approved scope'});
    await expect(read('review-intent')).resolves.toMatchObject({body:'Original intent'});
    await expect(daemon.execute('getRoomMessage', {roomId:C,messageId:'review-intent',offset:9},B))
      .resolves.toMatchObject({body:'intent'});
    await expect(read('review-private')).rejects.toThrow('message access denied');
    await expect(read('review-approval',A)).rejects.toThrow('message access denied');
    await expect(daemon.execute('getRoomMessage', {roomId:source,messageId:'review-approval'},B)).rejects.toThrow();
    expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2`, [source,B])).rowCount).toBe(0);
    await daemon.execute('postAgentTurnReceipt', {roomId:C,requestId:review!.turnRequestId,
      generationId:'g1',status:'complete'}, B);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await db.query(`UPDATE agent_commands SET state='claimed',completed_at=NULL WHERE id=$1`, [review!.id]);
    await expect(read('review-approval')).resolves.toMatchObject({body:'Approved scope'});
    await db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [review!.id]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await db.query(`UPDATE agent_commands SET state='claimed' WHERE id=$1`, [review!.id]);
    await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [C]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [C]);
    await db.query(`UPDATE corner_brief_revisions SET revision=2 WHERE corner_id=$1`, [C]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await db.query(`UPDATE corner_brief_revisions SET revision=1 WHERE corner_id=$1`, [C]);
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"') WHERE corner_id=$1`, [C]);
    await expect(read('review-approval')).rejects.toThrow('message access denied');
    await db.query(`DELETE FROM rooms WHERE id=$1`, [source]);
  });
  it.each([
    {reason:'ACP error -32000: Authentication required',free:false},
    {reason:'model selection unavailable',free:false},
    {reason:'provider refused the selected configuration',reasonKind:'model-selection-unavailable' as const,free:false},
    {reason:'ACP error -32000: Authentication required',free:true},
  ])('WAKE-STORM: standing reviewer failure waits for recovery: $reason (free=$free)', async ({reason,reasonKind,free}) => {
    if (free) await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'{}')`, [B,W,H]);
    await db.query('UPDATE agents SET selected_model=NULL WHERE agent_id=$1', [B]);
    await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R, B]);
    await greenHead(7, 'a'.repeat(40));
    const [review] = await commands(B, C);
    expect(review).toBeDefined();
    await claim(review!);
    await daemon.execute('postAgentTurnReceipt', { roomId: C, requestId: review!.turnRequestId,
      generationId: 'g1', status: 'failed', reason, reasonKind }, B);
    for (let cycle = 0; cycle < 5; cycle++) await reconcileConfiguredCornerReviewers(db, R);
    expect(await commands(B, C)).toHaveLength(0);
    const reports = (await commands(A, R)).filter(c => c.reason === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.source.body).toContain(reason);
    // A timer and a new PR head cannot repair credentials or a missing model.
    await db.query(`UPDATE agent_turns SET created_at=now()-interval '1 day' WHERE agent_id=$1`, [B]);
    await greenHead(8, 'b'.repeat(40));
    await reconcileConfiguredCornerReviewers(db, R);
    expect(await commands(B, C)).toHaveLength(0);
    // A model selection change is a concrete recovery signal.
    await db.query("UPDATE agents SET selected_model='working-model' WHERE agent_id=$1", [B]);
    await reconcileConfiguredCornerReviewers(db, R);
    expect(await commands(B, C)).toHaveLength(1);
  });

  // Reproduction ZC-1: GitHub reports no rollup for a PR with no checks, so no
  // check webhook exists to create the configured reviewer's command.
  it.each(['sign-in','successful-turn','legacy-configuration'])('WAKE-STORM: reviewer resumes after a concrete %s recovery', async recovery => {
    await db.query('UPDATE agents SET selected_model=NULL WHERE agent_id=$1', [B]);
    await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R,B]);
    await greenHead(9,'c'.repeat(40));
    const [review] = await commands(B,C);
    await claim(review!);
    await daemon.execute('postAgentTurnReceipt', {roomId:C,requestId:review!.turnRequestId,
      generationId:'g1',status:'failed',reason:'Authentication required'}, B);
    if (recovery === 'legacy-configuration') await db.query(`UPDATE agent_commands
      SET review_context=review_context-'reviewerConfiguration' WHERE id=$1`, [review!.id]);
    await reconcileConfiguredCornerReviewers(db,R);
    expect(await commands(B,C)).toHaveLength(0);
    if(recovery === 'sign-in') await db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
      VALUES($1,$2,$3,'Signed in','agent-sign-in',jsonb_build_object('agentId',$3::text,'attemptId',$1::text,'status','signed-in'))`,
      ['recovery-'+review!.id,R,B]);
    else if(recovery === 'successful-turn') await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
      VALUES($1,$2,$3,'complete')`, [R,'recovery-'+review!.id,B]);
    else await db.query("UPDATE agents SET selected_model='recovered-model' WHERE agent_id=$1", [B]);
    await reconcileConfiguredCornerReviewers(db,R);
    expect(await commands(B,C)).toHaveLength(1);
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
    await db.query('DELETE FROM free_agents WHERE agent_id=$1', [B]);
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
      body: expect.stringContaining('This pull request has no checks and no reviewer. Landing needs your commander\'s yes. Ask your commander using your normal report tool.'),
    } });
    expect((await commands(B, R)).filter(command => command.reason === 'report' && command.source.body.includes('pending your yes'))).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM messages WHERE text LIKE '%ready to land pending your yes%'
      OR text LIKE '%Landing needs your commander%'`)).rowCount).toBe(0);
    expect((await commands(A, C)).filter(command => command.reason === 'corner_land')).toHaveLength(0);
  });

  it.each(['final', 'post'] as const)('Reproduction REVIEW-HEAD-1: a late old-head %s verdict cannot wake the worker', async surface => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(81, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await greenHead(81, '2'.repeat(40));
    if (surface === 'final') await result(review!, '@hoots FAIL: repair the old head.');
    else await daemon.execute('postCornerMessage', { roomId: C, cornerId: C, requestId: review!.turnRequestId,
      generationId: 'g1', text: '@hoots FAIL: repair the old head.' }, B);
    expect(await commands(A, C)).toEqual([]);
    expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%repair the old head%'`, [C])).rowCount).toBe(0);
  });

  it('Reproduction REVIEW-HEAD-1: a queued repair is dropped when its reviewed head moves', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(82, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@hoots FAIL: repair this head.');
    await greenHead(82, '2'.repeat(40));
    expect(await commands(A, C)).toEqual([]);
  });

  it('Reproduction REVIEW-HEAD-1: a queued reviewer report is dropped at its commander after a push', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(84, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await daemon.execute('report', { roomId: C, requestId: review!.turnRequestId,
      generationId: 'g1', status: 'done', text: 'done: FAIL on the reviewed head.' }, B);
    await greenHead(84, '2'.repeat(40));
    expect((await commands(A, R)).filter(c => c.reason === 'report' && c.source.body.includes('FAIL on the reviewed head'))).toEqual([]);
  });

  it('Reproduction REVIEW-HEAD-1: a worker that pushes while repairing hands off the new head', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(83, '1'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, '@hoots FAIL: repair this head.');
    const [repair] = await commands(A, C);
    await claim(repair!);
    // GitHub moves before the synchronize webhook. Exercise the daemon's
    // provider-refresh seam; the provider implementation has its own fixture.
    const refreshed = vi.fn(async () => {
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`, [C, '2'.repeat(40)]);
    });
    Object.assign(daemon, { github: { refreshCornerReviewHead: refreshed } });
    await result(repair!, '@goosy The fix is pushed; please review.');
    const next = (await commands(B, C)).find(c => c.reason === 'agent_tag');
    expect(refreshed).toHaveBeenCalledWith(C);
    expect(next?.source.body).toContain(`Current handoff target: PR #83 at ${'2'.repeat(40)}`);
    const target = (await db.query<{ context: { headSha: string } }>('SELECT review_context context FROM agent_commands WHERE id=$1', [next!.id])).rows[0]?.context;
    expect(target?.headSha).toBe('2'.repeat(40));
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
    // A check event is not a human assignment, even when its fixture author is human.
    await expect(result(review!, '@human the reproduction is missing. Fix that and push.'))
      .rejects.toThrow('not your direct commander');
    await result(review!, 'The reproduction is missing. Fix that and push.');
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

  it.each(['FAIL: fix the demonstration.', 'PASS: reviewed all changed files.',
    'FAIL: the diff is empty; there is nothing to review.'])(
    'Reproduction REVIEW-QUIET-1: duplicate green deliveries retain %s', async verdict => {
      await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
      const head = '9'.repeat(40);
      await greenHead(71, head);
      const [review] = await commands(B, C);
      await claim(review!);
      await result(review!, verdict);
      // A pending/green cycle writes new lifecycle cards, losing the old
      // outstanding-command window. The source event has no head field.
      await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [C]);
      await advanceCorner(db, C, { kind: 'checks-pending' });
      await greenHead(71, head);
      for (let cycle = 0; cycle < 3; cycle++) await reconcileConfiguredCornerReviewers(db, R);
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
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(72, '9'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: required evidence is missing.');
    await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checksSummary}',
      '{"checks":[{"name":"new-required-check","status":"passed"}]}') WHERE corner_id=$1`, [C]);
    await reconcileConfiguredCornerReviewers(db, R);
    expect(await commands(B, C)).toEqual([]);
  });

  it.each(['pending', 'complete'] as const)(
    'Reproduction REVIEW-PR-1: a replacement PR on the same head supersedes a %s review', async state => {
      await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
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
      const rows = await db.query<{ context: { pullRequest: number }; state: string }>(
        'SELECT review_context context,state FROM agent_commands WHERE id=$1', [old!.id]);
      expect(rows.rows[0]?.state).toBe(state === 'pending' ? 'cancelled' : 'complete');
    });

  it('Reproduction REVIEW-CYCLE-1: later background cycles repair a lost wake and report a finished review only once', async () => {
    // Keep the database stand-in tied to the actual background-cycle wiring.
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(index.includes('reconciledCornerReviewers')).toBe(false);
    const repairStart = index.indexOf("work.add('repair', reconciliationMs, async (newLeader) => {");
    expect(repairStart).toBeGreaterThan(-1);
    const repair = index.slice(repairStart, index.indexOf('const leader = new BackgroundLeader', repairStart));
    expect(repair.replace(/\s+/g, ' ')).toContain("githubJobs ? id => githubJobs.refreshCornerReviewHead(id) : undefined");
    const cycle = () => reconcileConfiguredCornerReviewers(db);
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(61, '6'.repeat(40));
    await cycle();
    const [lost] = await commands(B, C);
    await db.query('DELETE FROM agent_commands WHERE id=$1', [lost!.id]);
    await cycle();
    const [repaired] = await commands(B, C);
    expect(repaired?.reason).toBe('corner_review_dispatch');
    await claim(repaired!);
    await result(repaired!, 'Review ended without a verdict.');
    for (let i = 0; i < 4; i++) await cycle();
    expect(await commands(B, C)).toHaveLength(0);
    const reports = (await commands(A, R)).filter(c => c.reason === 'report' && c.source.body.includes('the reviewer completed its review'));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source.body).toMatch(/^blocked:/);
    expect((await commands(A, C)).filter(c => c.reason === 'corner_review_needed')).toHaveLength(1);
    console.info('Demonstrated REVIEW-CYCLE-1: later cycle restored review; completed review reported once across four repairs');
  });

  it.each(['pending', 'claimed'] as const)('Reproduction REVIEW-WORK-1: no repair wake or report while implementer is %s', async (state) => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(62, '5'.repeat(40));
    const [lost] = await commands(B, C);
    await db.query('DELETE FROM agent_commands WHERE id=$1', [lost!.id]);
    const worker = await createAgentCommand(db, { roomId: C, agentId: A, sourceMessageId: null,
      privatePayload: { text: 'Fix in progress', authorId: H, fromRoomId: R, kind: 'order' }, reason: 'order' });
    expect(worker).toBeDefined();
    if (state === 'claimed') await claim((await commands(A, C))[0]!);
    await reconcileConfiguredCornerReviewers(db);
    expect(await commands(B, C)).toHaveLength(0);
    expect((await commands(A, R)).filter(c => c.reason === 'report')).toHaveLength(0);
    expect((await commands(A, C)).filter(c => c.reason === 'corner_review_needed')).toHaveLength(0);
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

  it('Reproduction REVIEW-HEAD-1: a worker tag does not repeat a finished review on the unchanged head', async () => {
    const head = 'b'.repeat(40);
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
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
    await reconcileConfiguredCornerReviewers(db, R);
    expect(await commands(B, C)).toEqual([]);
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
    expect(handback[0]?.source.body).toContain('the reviewer completed its review of the current head');
    expect(handback[0]?.source.body).toContain('report the blocker to its commander');
    for (let sweep = 2; sweep <= 3; sweep += 1)
      expect((await reconcileConfiguredCornerReviewers(db, R)).commands).toBe(0);
    expect((await commands(A, C)).map(command => command.id)).toEqual(handback.map(command => command.id));
    expect(await commands(B, C)).toEqual([]);
    // Completing the handback without a push must not automatically repeat
    // the rejected review on each background reconciliation.
    await claim(handback[0]!);
    await result(handback[0]!, 'The draft still needs its demonstration.');
    for (let sweep=0;sweep<3;sweep++) {
      await reconcileConfiguredCornerReviewers(db, R);
      expect(await commands(B, C)).toEqual([]);
    }
    // A new head is a new review.
    await greenHead(28, 'd'.repeat(40));
    expect((await commands(B, C)).map((command) => command.reason)).toEqual(['subscribed_event']);
  });

  it('names the brief revision current at dispatch in the review wake', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    for (const revision of [1, 2])
      await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
        VALUES($1,$2,'Brief','Brief',$3,$4)`, [C, revision, A, R]);
    await greenHead(29, 'e'.repeat(40));
    const [review] = await commands(B, C);
    expect(review?.source.body).toContain('Review against brief revision 2');
    expect(review?.source.body).not.toContain('revision 1');
  });

  it.each(['reviewer', 'worker'] as const)('Reproduction %s: delivered revision 2 instructions are replaced by current revision 3', async (role) => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,2,'Keep the PR open','Keep the PR open',$2,$3)`, [C, A, R]);
    const headSha = 'e'.repeat(40);
    let delivered: AgentCommand;
    if (role === 'reviewer') {
      await greenHead(29, headSha);
      delivered = (await commands(B, C))[0]!;
    } else {
      const order = await createAgentCommand(db, {
        roomId: C, agentId: A, sourceMessageId: null, reason: 'order',
        privatePayload: { kind: 'order', authorId: B, fromRoomId: R,
          text: 'Under brief revision 2, close the PR.' },
      });
      delivered = (await commands(A, C)).find(command => command.id === order!.id)!;
    }
    // Delivery precedes the revision: queued-wake cancellation cannot repair this copy.
    await claim(delivered);
    await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,3,'Keep the PR open','Keep the PR open and implement the fix.',$2,$3)`, [C, A, R]);
    const restore = await daemon.execute('getCornerRestoreState', { cornerId: C }, delivered.agentId);
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
        await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
          VALUES($1,$2,'Brief',$3,$4,$5)`, [C, revision, `Brief at ${revision}`, A, R]);
        if (!queue) return;
        const line = await systemLine(db, { roomId: C,
          subject: { kind: 'agent', id: A, name: 'Hoots' }, verb: 'revised the corner brief',
          object: { text: `Revision ${revision}`, id: C } });
        await createAgentCommand(db, { roomId: C, agentId: A, sourceMessageId: line.id,
          reason: 'corner_brief_revision' });
      };
      await assignment(1);
      const [old] = await commands(A, C);
      await assignment(2, false);
      // An incomplete producer cannot take away the only wake.
      expect((await commands(A, C)).map(c => c.id)).toContain(old!.id);
      const human = await phone.execute('sendRoomMessage', { roomId: C, text: '@hoots keep this instruction' }, H);
      const line = await systemLine(db, { roomId: C,
        subject: { kind: 'agent', id: A, name: 'Hoots' }, verb: 'revised the corner brief',
        object: { text: 'Revision 2', id: C } });
      const replacement = await createAgentCommand(db, { roomId: C, agentId: A,
        sourceMessageId: line.id, reason: 'corner_brief_revision' });
      // A timestamp comparison cannot distinguish these durable causes.
      await db.query(`UPDATE corner_brief_revisions SET created_at=now() WHERE corner_id=$1`, [C]);
      await db.query(`UPDATE agent_commands SET created_at=now() WHERE room_id=$1`, [C]);
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
      await db.query('DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2', [C, H]);
    }
  });

  it('Reproduction STALE-2: an implementer assignment wake shows the live brief revision, not the queued one', async () => {
    // Queue the implementer wake a brief revision writes: the revision row,
    // its system line, and the corner_brief_revision assignment command.
    const assignment = async (revision: number) => {
      await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
        VALUES($1,$2,'Brief',$3,$4,$5)`, [C, revision, `Brief at ${revision}`, A, R]);
      const line = await systemLine(db, {
        roomId: C,
        subject: { kind: 'agent', id: A, name: 'Hoots' },
        verb: 'revised the corner brief',
        object: { text: `Revision ${revision}`, id: C },
      });
      await createAgentCommand(db, {
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
      await db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])
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
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    const headA = '3'.repeat(40), headB = '4'.repeat(40);
    const green = async (number: number, headSha: string) => {
      await db.query(
        `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
        [C, JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number, url: `https://github.com/acme/repo/pull/${number}`, headSha } })],
      );
      await systemLine(db, { roomId: C, authorId: H, subject: { kind: 'github', name: 'GitHub' },
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
      await db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [queued!.id])
    ).rows[0]?.state;
    console.info(
      `Reproduction STALE-3: wrong=1 review naming ${headA.slice(0, 8)}; right=0; observed=${staleDelivered.length}`,
    );
    expect(staleDelivered).toHaveLength(0);
    expect(queuedState).toBe('cancelled');
    // The current head gets its review wake, naming that head.
    await reconcileConfiguredCornerReviewers(db, R);
    const current = (await commands(B, C)).filter((command) =>
      command.source.body.includes(headB),
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.source.body).not.toContain(headA);
    console.log(
      'Demonstrated Reproduction STALE-3: review wake for moved head dropped; reviewer woken for current head',
    );
  });

  it('does not wake the reviewer again for the same head and brief revision after a blocking verdict', async () => {
    const head = 'f'.repeat(40);
    /** A check verdict on `head`, as the GitHub webhook writes it. */
    const verdict = async (kind: 'check-passed' | 'rerun') => {
      if (kind === 'rerun') {
        await db.query(
          `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [C]);
        await advanceCorner(db, C, { kind: 'checks-pending' });
        await db.query(
          `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`, [C]);
      }
      await systemLine(db, { roomId: C, authorId: H, subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check', kind: 'check-passed', object: { text: 'ci', headSha: head } });
    };
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,1,'Brief','Brief',$2,$3)`, [C, A, R]);
    await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
      JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number: 30, headSha: head } })]);
    await verdict('check-passed');
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: the waiver is not in the brief.');
    // A CI re-run on the same head and the same brief revision.
    await verdict('rerun');
    const repeated = (await commands(B, C)).length;
    console.info(`Reproduction REVIEW-DUP-1: wrong=1 repeat review wake; right=0; observed=${repeated}`);
    expect(repeated).toBe(0);
    expect((await commands(A, C)).map((command) => command.reason)).toContain('corner_review_needed');
    // A revised brief is a new review on the same head.
    await db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,2,'Brief','Brief with the waiver',$2,$3)`, [C, A, R]);
    await verdict('rerun');
    const [rereview] = await commands(B, C);
    expect(rereview?.source.body).toContain('Review against brief revision 2');
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

  it('Reproduction R1: waits for new input after a completed fix with no push', async () => {
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
    expect(await noteBlockedCornerChecks(db)).toBe(0);
    expect(await noteBlockedCornerChecks(db)).toBe(0);
    expect((await commands(A, C)).filter(command => command.reason === 'corner_check')).toEqual([]);
    await push.runOnce();
    expect(send).not.toHaveBeenCalled();
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
      // An Attention request is a human message, not a system lifecycle fact.
      const sourceId = 'd'.repeat(63) + (tagged ? '1' : '0');
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please attach the report.')`,
        [sourceId, C, H]);
      await createAgentCommand(db, {
        roomId: C,
        agentId: A,
        sourceMessageId: sourceId,
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

  it('delivers to a parent-member reviewer without creating a corner roster row', async () => {
    await phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    expect((await db.query('SELECT 1 FROM memberships WHERE room_id=$1',[C])).rowCount).toBe(0);
    await greenHead(10,'4'.repeat(40));
    expect((await commands(B,C)).map(command => command.reason)).toEqual(['subscribed_event']);
    expect((await db.query('SELECT 1 FROM memberships WHERE room_id=$1',[C])).rowCount).toBe(0);
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
        checksSummary: { updatedAt: Math.floor(Date.now() / 1000) - 3660, checks: [{ name: 'Server suite', status: 'pending' }] },
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
      zeroChecksConfirmed: true,
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
