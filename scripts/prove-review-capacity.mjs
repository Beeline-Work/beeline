// Isolated built-service proof: synthetic database and provider responses only.
import assert from 'node:assert/strict';
const root = process.cwd();
const mod = (path) => import(`${root}/${path}`);
const { PgliteDatabase } = await mod('apps/server/src/test-support.ts');
const { migrate } = await mod('apps/server/dist/database.js');
const { DaemonService } = await mod('apps/server/dist/daemon-service.js');
const { LiveHub } = await mod('apps/server/dist/live.js');
const { TokenAuth, tokenHash } = await mod('apps/server/dist/auth.js');
const { PhoneService } = await mod('apps/server/dist/phone-service.js');
const { createBeelineServer } = await mod('apps/server/dist/server.js');
const { systemLine } = await mod('apps/server/dist/system-line.js');
const { createAgentCommand, reconcileConfiguredCornerReviewers } = await mod(
  'apps/server/dist/agent-command.js',
);
const { flushDueCommanderWakes } = await mod('apps/server/dist/commander-wakes.js');
const { advanceCorner } = await mod('apps/server/dist/corner-lifecycle.js');
const { refreshCornerAttention } = await mod('apps/server/dist/corner-attention.js');
const { GitHubOperations } = await mod('apps/server/dist/github-operations.js');
const db = new PgliteDatabase();
const human = 'a'.repeat(64),
  worker = 'b'.repeat(64),
  reviewer = 'c'.repeat(64),
  head = 'd'.repeat(40),
  commander = 'e'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111',
  parent = '22222222-2222-4222-8222-222222222222',
  corner = '33333333-3333-4333-8333-333333333333';
let server;
let merged = false;
try {
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Reviewer','reviewer'),($4,'agent','Commander','commander')`,
    [human, worker, reviewer, commander],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3),($4,$3)`, [
    worker,
    reviewer,
    human,
    commander,
  ]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,
    [human],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`,
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,github_installation_id,reviewer_agent_id) VALUES($1,$2,'Parent','owner/widgets','repository',77,$3)`,
    [parent, workspace, reviewer],
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,
    [corner, workspace, parent, commander],
  );
  for (const who of [human, worker, reviewer, commander])
    for (const place of [null, parent])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [workspace, place, who],
      );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,lifecycle) VALUES($1,$2,$2,$3::jsonb)`,
    [
      corner,
      worker,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 1, headSha: head, url: 'https://github.com/owner/widgets/pull/1' },
      }),
    ],
  );
  const opening = await createAgentCommand(db, {
    id: 'proof-opening',
    roomId: corner,
    agentId: worker,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: {
      kind: 'order',
      text: 'Implement the agreed change.',
      authorId: commander,
      fromRoomId: parent,
    },
  });
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [opening.id]);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [
    corner,
    opening.turn_request_id,
  ]);
  const operations = new GitHubOperations(
    db,
    {},
    {
      installationToken: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }),
      readPullRequest: async () => ({
        number: 1,
        headSha: head,
        url: 'https://github.com/owner/widgets/pull/1',
        merged,
      }),
      readCommitCheckRollup: async () => ({ state: 'passed', total: 1, checks: [], failing: [] }),
    },
    'fixture',
  );
  const live = new LiveHub();
  const daemon = new DaemonService(
    db,
    live,
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    (input) => operations.prChecksStatus(input),
  );
  daemon.github = { assertCornerReviewerNotAuthor: async () => {} };
  daemon.warmConnectorIndex = async () => {};
  for (const who of [worker, reviewer, commander])
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [
      tokenHash(`bdt_proof_${who}`),
      who,
    ]);
  server = createBeelineServer({
    database: db,
    daemon,
    live,
    auth: new TokenAuth(db, async () => {
      throw Error('unused');
    }),
    phone: new PhoneService(db, 'http://test'),
    mediaMaximumBytes: 1,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  async function call(operation, input, who = reviewer) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer bdt_proof_${who}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    return { status: response.status, body: await response.json() };
  }
  async function claim(command, generationId, who = reviewer) {
    assert.equal(
      (
        await call(
          'claimAgentCommand',
          { roomId: corner, commandId: command.id, generationId },
          who,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          'postAgentTurnReceipt',
          { roomId: corner, requestId: command.turnRequestId, generationId, status: 'working' },
          who,
        )
      ).status,
      200,
    );
  }
  // The production alerts were queued at opening, then delivered during CI.
  await db.query(`UPDATE corner_facts SET lifecycle='{}' WHERE corner_id=$1`,[corner]);
  await db.query(`UPDATE corner_attention_spans SET last_turn_ended_at=NULL,last_state=NULL WHERE corner_id=$1`,[corner]);
  await refreshCornerAttention(db,corner);
  const idleCommands=(await call('getAgentCommands',{roomId:corner},commander)).body.commands;
  assert.ok(idleCommands.some(c=>c.source.body.includes('is idle')),JSON.stringify((await db.query('SELECT last_state,episode,reported_episode FROM corner_attention_spans WHERE corner_id=$1',[corner])).rows));
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`,[corner,JSON.stringify({checks:'pending',pr:{number:1,headSha:head}})]);
  assert.deepEqual((await call('getAgentCommands',{roomId:corner},commander)).body.commands,[]);
  console.log('idle-1 demonstrated: built HTTP drops the opening alert while checks are running.');
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`,[corner]);
  for (const [index, verdict] of [
    'failed: FAIL: required evidence is missing.',
    'blocked: required checks are missing.',
    'FAIL: helper-forwarded arrays bypass the wording lock. Fix the parameter tracking.',
  ].entries()) {
    const currentHead = String(index + 1).repeat(40);
    await db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [corner]);
    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`,
      [corner, currentHead],
    );
    await systemLine(db, {
      roomId: corner,
      authorId: human,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    await reconcileConfiguredCornerReviewers(db, parent);
    const pending = (await call('getAgentCommands', { roomId: corner })).body.commands;
    assert.equal(pending.length, 1, 'new head must wake reviewer');
    const review = pending[0],
      generationId = `review-${index}`;
    await claim(review, generationId);
    if (index === 2) {
      assert.equal((await call('order',{roomId:corner,requestId:review.turnRequestId,generationId,
        address:corner,agent:'@worker',text:verdict})).status,200);
      assert.equal((await call('postAgentTurnReceipt',{roomId:corner,requestId:review.turnRequestId,generationId,status:'complete',completionKind:'no-reply'})).status,200);
      await db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1 AND agent_id=$2`,[corner,worker]);
    } else {
    const report = await call('report', {
      roomId: corner,
      requestId: review.turnRequestId,
      generationId,
      status: index ? 'blocked' : 'failed',
      text: verdict,
    });
    assert.equal(report.status, 200);
    assert.equal(
      (
        await call('postAgentTurnReceipt', {
          roomId: corner,
          requestId: review.turnRequestId,
          generationId,
          status: 'failed',
          reason: 'unreported_order: runtime failed after delivery',
          reasonKind: 'hiccup',
        })
      ).status,
      200,
    );
    }
    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,
      [corner],
    );
    await advanceCorner(db, corner, { kind: 'checks-pending' });
    await db.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`,
      [corner],
    );
    await systemLine(db, {
      roomId: corner,
      authorId: human,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    await reconcileConfiguredCornerReviewers(db, parent);
    assert.deepEqual((await call('getAgentCommands', { roomId: corner })).body.commands, []);
  }
  console.log('review-1 demonstrated: built HTTP repair order without a final reply suppresses repeated review.');
  console.log(
    'REVIEW-STOP-1 demonstrated: built HTTP report -> failed receipt -> repeated green/check repair produces no review; new head dispatches again.',
  );
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [parent]);
  await db.query(`UPDATE agent_commands SET state='complete'`);
  await db.query(`DELETE FROM automatic_report_wakes`);
  const capacityOrder = await createAgentCommand(db, {
    roomId: corner,
    agentId: worker,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: {
      kind: 'order',
      text: 'Finish the agreed work.',
      authorId: commander,
      fromRoomId: parent,
    },
  });
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [capacityOrder.id]);
  const capacity = await createAgentCommand(db, {
    roomId: corner,
    agentId: worker,
    sourceMessageId: null,
    reason: 'subscribed_event',
    parent: capacityOrder,
  });
  for (const attempt of [1, 2, 3]) {
    const command = (await call('getAgentCommands', { roomId: corner }, worker)).body.commands.find(
      (item) => item.id === capacity.id,
    );
    assert.ok(command);
    const generationId = `capacity-${attempt}`;
    await claim(command, generationId, worker);
    assert.equal((await call('postRoomMessage',{roomId:corner,requestId:command.turnRequestId,generationId,
      text:'Selected model is at capacity. Please try a different model.'},worker)).status,200);
    const receipt = await call(
      'postAgentTurnReceipt',
      {
        roomId: corner,
        requestId: command.turnRequestId,
        generationId,
        status: 'complete',
      },
      worker,
    );
    assert.equal(receipt.status, 200);
    assert.equal(Boolean(receipt.body.hiccupRestart), attempt < 3);
    assert.deepEqual(
      (await call('getAgentCommands', { roomId: corner }, worker)).body.commands,
      [],
      'backoff or exhaustion prevents immediate execution',
    );
    if (attempt < 3) {
      const delay = (
        await db.query(
          `SELECT EXTRACT(EPOCH FROM (wake_after-now()))::float seconds FROM agent_commands WHERE id=$1`,
          [capacity.id],
        )
      ).rows[0].seconds;
      assert.ok(delay > (attempt === 1 ? 25 : 55) && delay <= (attempt === 1 ? 30 : 60));
      await db.query(`UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1`, [
        capacity.id,
      ]);
      await flushDueCommanderWakes(db);
    }
  }
  const reports = (await call('getAgentCommands', { roomId: parent }, commander)).body.commands;
  assert.ok(
    reports.some(
      (command) =>
        command.source.body.includes('failed:') && command.source.body.includes('at capacity'),
    ),
  );
  console.log('capacity-1 demonstrated: final capacity text plus successful receipt retries with bounded backoff.');
  console.log(
    'CAPACITY-1 / CAPACITY-COMMANDER-1 demonstrated: built HTTP capacity receipt -> hidden during backoff -> durable deadline release -> retry, finite exhaustion -> commander receives failure. Fixture advances database deadlines instead of waiting.',
  );
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`,[parent,reviewer]);
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text)) WHERE corner_id=$1`,[corner,head]);
  await db.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,head_sha,pull_request_number) VALUES($1,$2,$3,1)`,[corner,reviewer,head]);
  merged=true;
  const gate=await call('getPrChecksStatus',{cornerId:corner},worker);
  assert.equal(gate.status,200);
  assert.equal(gate.body.stage,'merged');
  assert.equal(gate.body.mergeAllowed,false);
  console.log('merged-1 demonstrated: built HTTP refuses a merged PR even before corner archival.');

} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
}
