import { randomBytes, randomUUID, describe, expect, it, vi, migrateData, SYSTEM_IDENTITY_ID, PhoneService, DaemonService, LiveHub, systemLine, GitHubHttpError, advanceCorner, cornerMergeGate, createAgentCommand, CORNER_LIFECYCLE_CARD_TYPE, H, A, B, W, R, db, phone, daemon, github, githubRollupState, githubHead, githubApp, implementersMerge, cards, currentState, brief, open, claim, pushToCorner, greenHead, redHead, commands, result, SHA, branchOf, reasons, projected, inReview, approve, approved, mergedWebhook, say, revise, rootFixture, fixtureScope22, fixtureScope26, fixtureScope28 } from './corner-lifecycle.test-support.js';

describe('a person hands the corner to another agent (the implementer follows the tag)', () => {
const scope22 = fixtureScope22();


  it('an agent tag invites conversation without handing the corner on', async () => {
    const cornerId = await open('owner/widgets');
    // The person asks the agent working the corner to give the work to Goosy.
    await say(cornerId, '@hoots hand this corner to goosy');
    const command = (await commands(A, cornerId)).find((c) => c.reason === 'human_tag')!;
    await claim(command);
    await result(command, '@goosy take this one');
    console.log('Reproduction H1-1:', {
      implementer: await scope22.workerOf(cornerId),
      goosyCommands: (await commands(B, cornerId)).map((c) => c.reason),
    });
    expect(await scope22.workerOf(cornerId)).toBe(A);
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
    expect(await scope22.workerOf(cornerId)).toBe(A);
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
    expect(await scope22.workerOf(cornerId)).toBe(A);
  });


  it('an agent hand-over to the configured reviewer does not take the implementer role', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await say(cornerId, '@hoots hand this corner to goosy');
    const command = (await commands(A, cornerId)).find((c) => c.reason === 'human_tag')!;
    await claim(command);
    await result(command, '@goosy take this one');
    // The person's tag put Hoots in the role; the reviewer Goosy never takes it.
    expect(await scope22.workerOf(cornerId)).toBe(A);
  });


  it('a corner nobody redirected still wakes its opener', async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 3, SHA);
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(1);
    expect((await reasons(cornerId, B)).filter((reason) => reason === 'corner_check')).toHaveLength(0);
  });
});
describe('CI never escalates to a human', () => {
  it('keeps waking the implementer after more than 100 failing rounds', async () => {
    const cornerId = await open('owner/widgets');
    await pushToCorner(cornerId, '0'.repeat(40));
    for (let round = 1; round <= 101; round += 1) {
      const headSha = round.toString(16).padStart(40, '0');
      if (round > 1) await advanceCorner(rootFixture.db, cornerId, { kind: 'push', headSha, contents: { headSha } });
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
        cornerId,
        JSON.stringify({ checks: 'failing', lifecycle: 'in-review', pr: { number: 4, url: 'https://github.com/owner/widgets/pull/4', headSha } }),
      ]);
      await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'found failing checks on', kind: 'check-failed' });
      expect(await currentState(cornerId)).toBe('implement');
    }
    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_check')).toHaveLength(101);
    const line = (
      await rootFixture.db.query<{ system_event: { subject: { id?: string } } }>(
        `SELECT system_event FROM messages WHERE room_id=$1 AND card_type='corner-checks-blocked'`,
        [cornerId],
      )
    ).rows;
    expect(line).toHaveLength(0);
    await pushToCorner(cornerId, 'f'.repeat(40));
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'implement', outcome: 'pushed', toState: 'checks' }),
    );
  }, 60_000);
});
describe("the configured reviewer's verdict (AC-4)", () => {
  it('records PASS from a reviewer turn that was not the review dispatch (the Sol case)', async () => {
    const cornerId = await inReview();
    // Goosy is asked something by a person in the corner: its session never
    // booted as the reviewer, and the server alone decides the verdict.
    await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [cornerId]);
    await say(cornerId, '@goosy what do you think?');
    const [asked] = await commands(B, cornerId);
    expect(asked?.reason).not.toBe('subscribed_event');
    await claim(asked!);
    await expect(approve(cornerId)).resolves.toMatchObject({ headSha: SHA });
    await result(asked!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('review');
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true });
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });


  it('rejects a caller who is not the configured reviewer and a stale head by name; a brief revision does not stale it', async () => {
    const cornerId = await inReview();
    await expect(approve(cornerId, SHA, A)).rejects.toThrow(/^NOT_CONFIGURED_REVIEWER:/);
    await expect(approve(cornerId, '9'.repeat(40))).rejects.toThrow(/^STALE_HEAD:/);
    expect(await currentState(cornerId)).toBe('review');
    expect((await rootFixture.db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [cornerId])).rowCount).toBe(0);
    await revise(cornerId);
    await expect(approve(cornerId)).resolves.toMatchObject({ headSha: SHA });
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true, open: true });
  });
});
describe('the implementer merges when the gate opens (AC-5)', () => {
  it('approval, landing and hold release remain separate server operations', async () => {
    const cornerId = await inReview();
    const land = vi.fn(async () => true);
    const wired = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirm) => rootFixture.github.prChecksStatus(input, confirm), undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, land);
    await expect(wired.execute('mergeCorner', { cornerId }, A)).resolves.toMatchObject({ status: 'blocked' });
    expect((await rootFixture.db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [cornerId])).rowCount).toBe(0);
    const hold = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    await approve(cornerId);
    expect(land).not.toHaveBeenCalled();
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ approved: true, held: true, mergeAllowed: false });
    await expect(wired.execute('mergeCorner', { cornerId }, A)).resolves.toMatchObject({ status: 'blocked', blocker: expect.stringContaining('hold') });
    expect(land).not.toHaveBeenCalled();
    expect((await rootFixture.db.query(`SELECT released_at FROM corner_merge_holds WHERE id=$1`, [hold.holdId])).rows[0]).toEqual({ released_at: null });
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]).toEqual({ archived_at: null });
  });


  it('opens the gate only for a yes from the configured reviewer or a Workspace admin, on the current head with no hold', async () => {
    const peer = 'f'.repeat(64);
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$1) ON CONFLICT DO NOTHING`, [peer]);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member') ON CONFLICT DO NOTHING`, [W, peer]);
    const reviewerYes = await approved();
    const briefEdited = await approved();
    const workerYoloOff = await approved();
    const personYes = await approved();
    const held = await approved();
    const unapproved = await approved();
    const staleHead = await approved();
    const authorYes = await approved();
    const memberYes = await approved();
    await revise(briefEdited);
    await rootFixture.db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    await rootFixture.db.query(`UPDATE corner_merge_approvals SET approved_by=$2 WHERE corner_id=$1`, [personYes, H]);
    await rootFixture.phone.execute('setCornerHold', { cornerId: held }, H);
    await rootFixture.db.query(`DELETE FROM corner_merge_approvals WHERE corner_id=$1`, [unapproved]);
    await rootFixture.db.query(`UPDATE corner_merge_approvals SET head_sha=$2 WHERE corner_id=$1`, [staleHead, '9'.repeat(40)]);
    await rootFixture.db.query(`UPDATE corner_merge_approvals SET approved_by=$2 WHERE corner_id=$1`, [authorYes, A]);
    await rootFixture.db.query(`UPDATE corner_merge_approvals SET approved_by=$2 WHERE corner_id=$1`, [memberYes, peer]);
    const opened = [reviewerYes, briefEdited, workerYoloOff, personYes];
    for (const cornerId of [...opened, held, unapproved, staleHead, authorYes, memberYes]) {
      const gate = await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA });
      expect(gate.open).toBe(opened.includes(cornerId));
      expect(gate.approved).toBe(cornerId !== unapproved && cornerId !== staleHead && cornerId !== authorYes && cornerId !== memberYes);
      expect(gate).not.toHaveProperty('isWorkerYolo');
      expect(gate).not.toHaveProperty('expressMergeOrdered');
      expect(gate).not.toHaveProperty('approvalPending');
    }
    const status = await rootFixture.github.prChecksStatus({ cornerId: reviewerYes });
    expect(status).toMatchObject({ stage: 'waiting_for_yes', approved: true, held: false, mergeAllowed: true });
    expect(status).not.toHaveProperty('rule');
    expect(status).not.toHaveProperty('recordedChecks');
  });


  it('Reproduction R5c: a departed self-reviewer cannot authorize a merge', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, A]);
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    // A reviewer is configured, so reviewerExists is true even though it has
    // left the parent Room; its departure is reported through reviewerWake,
    // not by hiding the configuration.
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA }))
      .toMatchObject({ reviewerExists: true, approved: false, open: false });
    expect(await currentState(cornerId)).toBe('review');
    expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`, [cornerId])).rows)
      .toHaveLength(0);
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ reviewerExists: true, mergeAllowed: false });
    expect(await implementersMerge()).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });

  it('after green checks and PASS, merge_corner merges the exact head, then lands on the merge webhook', async () => {
    const cornerId = await inReview();
    const implementerBefore = await reasons(cornerId, A);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('review');
    expect(await reasons(cornerId, A)).toEqual(implementerBefore);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    // Nothing merges until the implementer asks.
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    // Close stops only a claimed (running) assignment; pending ones are just cancelled.
    const assignmentsBefore = (await rootFixture.db.query(`SELECT DISTINCT turn_request_id FROM agent_commands
      WHERE room_id=$1 AND agent_id=$2 AND action IN ('input','resume') AND state='claimed'`,
      [cornerId, A])).rowCount;
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id: string) => rootFixture.github.landCornerOutcome(id));
    await expect(wiredDaemon.execute('mergeCorner', { cornerId }, A))
      .resolves.toEqual({ status: 'merge-started', headSha: SHA });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    await mergedWebhook(cornerId, 7, SHA);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(cornerId));
    expect(await currentState(cornerId)).toBe('landed');
    expect(await projected(cornerId)).toBe('landed');
    expect((await reasons(cornerId, A)).filter(reason => reason !== 'corner_close'))
      .toEqual(implementerBefore);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands
      WHERE room_id=$1 AND agent_id=$2 AND action='stop' AND reason='corner_close'`, [cornerId, A])).rowCount)
      .toBe(assignmentsBefore);
    expect(
      (await rootFixture.db.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [cornerId])).rowCount,
    ).toBe(1);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND action IN ('input','resume') AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1
      AND status='working'`, [cornerId])).rowCount).toBe(0);
  });


  it.each(['agent', 'phone'] as const)('R1 %s close closes the PR and archives a held corner', async path => {
    const cornerId = await inReview();
    const hold = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, id => rootFixture.github.closeCornerPullRequest(id));
    const wiredPhone = new PhoneService(rootFixture.db, 'http://test', rootFixture.github);
    if (path === 'agent') await wiredDaemon.execute('archiveCorner', { cornerId }, A);
    else await wiredPhone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(rootFixture.githubApp.closePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7);
    expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived).toBe(true);
    expect(await currentState(cornerId)).toBe('closed');
    expect((await rootFixture.db.query(`SELECT lifecycle->'pr' pr FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.pr).toBeNull();
    expect((await rootFixture.db.query(`SELECT released_at FROM corner_merge_holds WHERE id=$1`, [hold.holdId])).rows[0]!.released_at).not.toBeNull();
    console.log(`R1 Demonstrated: ${path} close closes the PR, archives the held corner and releases its hold.`);
  });


  it.each(['agent', 'phone'] as const)('R1 %s close still archives when GitHub fails', async path => {
    const cornerId = await inReview();
    rootFixture.githubApp.closePullRequest.mockRejectedValueOnce(new Error('GitHub unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, id => rootFixture.github.closeCornerPullRequest(id));
      if (path === 'agent') await wiredDaemon.execute('archiveCorner', { cornerId }, A);
      else await new PhoneService(rootFixture.db, 'http://test', rootFixture.github).execute('requestCornerClose', { roomId: cornerId }, H);
      expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived).toBe(true);
      expect(await currentState(cornerId)).toBe('closed');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('closing corner anyway'), expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });


  it('R1 closes a legacy archived corner PR without reopening the corner or waking work', async () => {
    const cornerId = await inReview();
    const pr = (await rootFixture.db.query(`SELECT lifecycle->'pr' pr FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.pr;
    // Recreate a corner archived by the old close path, with its PR still recorded.
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'pr' WHERE corner_id=$1`, [cornerId]);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr}',$2::jsonb) WHERE corner_id=$1`, [cornerId, JSON.stringify(pr)]);
    await rootFixture.db.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha) VALUES($1,$2,7,$3)`, [cornerId, B, SHA]);
    const before = (await rootFixture.db.query(`SELECT lifecycle-'pr' lifecycle FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.lifecycle;
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, (id: string) => rootFixture.github.closeCornerPullRequest(id));
    await expect(wiredDaemon.execute('closeCornerPullRequest', { cornerId }, A)).resolves.toMatchObject({ status: 'closed', pullRequestNumber: 7 });
    expect(rootFixture.githubApp.closePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7);
    expect((await rootFixture.db.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.lifecycle).toEqual(before);
    expect(await currentState(cornerId)).toBe('closed');
    expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived).toBe(true);
    expect((await rootFixture.db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    await expect(wiredDaemon.execute('closeCornerPullRequest', { cornerId }, A)).resolves.toMatchObject({ status: 'blocked', blocker: 'the corner has no pull request' });
    expect(rootFixture.githubApp.closePullRequest).toHaveBeenCalledTimes(1);
    console.log('R1 Demonstrated: legacy archived PR closed through daemon service; PR and approval cleared; corner stays closed with no pending work.');
  });


  it('does not close or alter a merged corner PR', async () => {
    const cornerId = await inReview();
    await mergedWebhook(cornerId, 7, SHA);
    const before = (await rootFixture.db.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.lifecycle;
    await expect(rootFixture.github.closeCornerPullRequest(cornerId)).resolves.toMatchObject({ status: 'blocked' });
    expect(rootFixture.githubApp.closePullRequest).not.toHaveBeenCalled();
    expect((await rootFixture.db.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.lifecycle).toEqual(before);
    expect(await currentState(cornerId)).toBe('landed');
  });


  it('lets any corner member close its pull request without merging; the corner stays open with no PR', async () => {
    const cornerId = await inReview();
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id: string) => rootFixture.github.landCornerOutcome(id),
      (id: string) => rootFixture.github.closeCornerPullRequest(id));
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id IN ($1,$3) AND identity_id=$2`, [cornerId, B, R]);
    await expect(wiredDaemon.execute('closeCornerPullRequest', { cornerId }, B)).rejects.toThrow(/access denied/);
    expect(rootFixture.githubApp.closePullRequest).not.toHaveBeenCalled();
    await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id IN ($1,$3) AND identity_id=$2`, [cornerId, B, R]);
    // B is a member, not the opener or implementer.
    await expect(wiredDaemon.execute('closeCornerPullRequest', { cornerId }, B)).resolves.toEqual({
      status: 'closed', pullRequestNumber: 7, url: expect.stringContaining('/pull/7'),
    });
    expect(rootFixture.githubApp.closePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    const fact = (
      await rootFixture.db.query<{ pr: unknown; archived: boolean }>(
        `SELECT fact.lifecycle->'pr' pr,corner.archived_at IS NOT NULL archived
         FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id WHERE fact.corner_id=$1`,
        [cornerId],
      )
    ).rows[0];
    expect(fact).toEqual({ pr: null, archived: false });
    expect(await currentState(cornerId)).toBe('implement');
    expect(await projected(cornerId)).toBe('implement');
    await expect(wiredDaemon.execute('mergeCorner', { cornerId }, A))
      .resolves.toEqual({ status: 'blocked', blocker: 'the corner has no pull request' });
    await expect(wiredDaemon.execute('closeCornerPullRequest', { cornerId }, B))
      .resolves.toEqual({ status: 'blocked', blocker: 'the corner has no pull request' });
    expect(rootFixture.githubApp.closePullRequest).toHaveBeenCalledTimes(1);
  });


  it('a delayed close result does not remove a replacement PR', async () => {
    const cornerId = await inReview();
    rootFixture.githubApp.closePullRequest.mockImplementationOnce(async () => {
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,number}','8'::jsonb) WHERE corner_id=$1`, [cornerId]);
    });
    await rootFixture.github.closeCornerPullRequest(cornerId);
    expect((await rootFixture.db.query(`SELECT (lifecycle->'pr'->>'number')::int number FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.number).toBe(8);
    expect(await currentState(cornerId)).toBe('review');
  });


  it('an unmerged GitHub close returns a legacy waiting corner to implement, once', async () => {
    const cornerId = await inReview();
    await rootFixture.db.query(`UPDATE messages SET card=card||'{"toState":"ask_human","outcome":"changes_requested"}'::jsonb
      WHERE id=(SELECT id FROM messages WHERE room_id=$1 AND card_type=$2 ORDER BY (card->>'seq')::int DESC LIMIT 1)`,
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE]);
    const event = {
      action: 'closed', installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' },
      pull_request: { number: 7, html_url: 'https://github.com/owner/widgets/pull/7', title: 'Widget', merged: false,
        head: { ref: branchOf(cornerId), sha: SHA }, base: { ref: 'main' } },
    };
    await rootFixture.github.processWebhook('pull_request', event);
    expect(await currentState(cornerId)).toBe('implement');
    expect(await projected(cornerId)).toBe('implement');
    expect((await rootFixture.db.query(`SELECT lifecycle->'pr' pr FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.pr).toBeNull();
    const count = (await cards(cornerId)).length;
    await rootFixture.github.processWebhook('pull_request', event);
    expect(await cards(cornerId)).toHaveLength(count);
    expect(rootFixture.githubApp.closePullRequest).not.toHaveBeenCalled();
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it('recovers a missed unmerged close on an explicit check command', async () => {
    const cornerId = await inReview();
    // Cache the same check verdict first: closure must not depend on a check change.
    await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 });
    rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/widgets/pull/7',
      headSha: SHA, headRef: branchOf(cornerId), merged: false, state: 'closed', mergeability: 'unknown' });
    await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 });
    expect(await currentState(cornerId)).toBe('implement');
    expect((await rootFixture.db.query(`SELECT lifecycle->'pr' pr FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.pr).toBeNull();
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it('Reproduction REACH-1: a parent Room agent outside the corner closes, renames, steers, reads, revises and posts to it; an outsider cannot', async () => {
    const cornerId = await inReview();
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, (id: string) => rootFixture.github.landCornerOutcome(id),
      (id: string) => rootFixture.github.closeCornerPullRequest(id), (id: string) => rootFixture.github.readCornerPullRequest(id));
    // B reaches every corner through the parent Room, with no copied row.
    const outsider = '3'.repeat(64);
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Outsider','outsider') ON CONFLICT DO NOTHING`, [outsider]);
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [outsider, H]);
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member') ON CONFLICT DO NOTHING`,
      [W, outsider],
    );

    // Reads.
    await expect(wiredDaemon.execute('getCornerRestoreState', { cornerId }, B)).resolves.toBeDefined();
    await expect(wiredDaemon.execute('listCornerBriefRevisions', { cornerId }, B)).resolves.toBeDefined();
    await expect(wiredDaemon.execute('getRoomConversation', { roomId: cornerId, limit: 5 }, B)).resolves.toBeDefined();
    const members = await wiredDaemon.execute('listRoomMembers', { roomId: cornerId }, B);
    expect(members.members.map((member) => member.id)).toEqual(expect.arrayContaining([A, H]));
    expect(members.members.map((member) => member.id)).toContain(B);
    expect((await wiredDaemon.execute('listRoomCorners', { roomId: R }, B)).corners).toHaveLength(1);
    expect((await wiredDaemon.execute('listReachableCorners', { roomId: R }, B)).corners)
      .toEqual([expect.objectContaining({ cornerId, pullRequestNumber: 7, archived: false })]);
    await expect(wiredDaemon.execute('readCornerPullRequest', { cornerId, roomId: R }, B)).resolves.toMatchObject({
      status: 'ok', number: 7, files: [{ filename: 'widget.ts', additions: 3, deletions: 1 }],
      reviews: [{ author: 'speedy', body: 'Looks close' }],
    });
    for (const [operation, input] of [
      ['getCornerRestoreState', { cornerId }],
      ['listCornerBriefRevisions', { cornerId }],
      ['getRoomConversation', { roomId: cornerId, limit: 5 }],
      ['listRoomMembers', { roomId: cornerId }],
      ['readCornerPullRequest', { cornerId }],
      ['closeCornerPullRequest', { cornerId }],
      ['archiveCorner', { cornerId }],
    ] as const)
      await expect(wiredDaemon.execute(operation, input as never, outsider)).rejects.toThrow(/access denied/);

    // Writes from B's own Room turn.
    await say(R, '@goosy look after the widget corner');
    const turn = (await commands(B, R)).at(-1)!;
    await claim(turn);
    const authority = { roomId: R, requestId: turn.turnRequestId, generationId: 'g1' };
    await wiredDaemon.execute('postCornerMessage', { ...authority, cornerId, text: 'A note from the Room' }, B);
    expect((await rootFixture.db.query(`SELECT author_id FROM messages WHERE room_id=$1 AND text='A note from the Room'`, [cornerId])).rows)
      .toEqual([{ author_id: B }]);
    await wiredDaemon.execute('renameCorner', { ...authority, cornerId, name: 'Renamed-widget' }, B);
    expect((await rootFixture.db.query(`SELECT name FROM rooms WHERE id=$1`, [cornerId])).rows[0]).toEqual({ name: 'Renamed-widget' });
    await wiredDaemon.execute('order', {
      ...authority, text: 'Pick this up', address: cornerId,
    }, B);
    expect((await commands(A, cornerId)).at(-1)?.reason).toBe('order');
    await expect(wiredDaemon.execute('reviseCornerBrief', {
      ...authority, cornerId, expectedRevision: 1,
      brief: { ...brief(turn.sourceMessageId), spec: 'Revised from the Room\n\n## Checklist\n- Ship it', change: 'Room revision' },
    }, B)).resolves.toMatchObject({ revision: 2 });
    await expect(wiredDaemon.execute('closeCornerPullRequest', { cornerId, roomId: R }, B))
      .resolves.toMatchObject({ status: 'closed', pullRequestNumber: 7 });
    await wiredDaemon.execute('archiveCorner', { cornerId, roomId: R }, B);
    expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [cornerId])).rows[0])
      .toEqual({ archived: true });
  });


  it('Reproduction R1: leaving the parent Room removes access to its corners', async () => {
    const cornerId = await inReview();
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks));
    // A loses corner access as soon as the parent membership ends.
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, A]);
    try {
      await expect(wiredDaemon.execute('listReachableCorners', { roomId: R }, A)).rejects.toThrow(/access denied/);
      await expect(wiredDaemon.execute('getCornerRestoreState', { cornerId }, A))
        .rejects.toThrow(/access denied/);
      await expect(wiredDaemon.execute('getPrChecksStatus', { cornerId, pullRequest: 7 }, A)).rejects.toThrow(/access denied/);
      await expect(wiredDaemon.execute('getRoomConversation', { roomId: cornerId, limit: 9, window: 'earliest' }, A))
        .rejects.toThrow(/access denied/);

      const outsider = '3'.repeat(64);
      await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Outsider','outsider') ON CONFLICT DO NOTHING`, [outsider]);
      await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [outsider, H]);
      for (const [operation, input] of [
        ['getCornerRestoreState', { cornerId }],
        ['getPrChecksStatus', { cornerId, pullRequest: 7 }],
        ['getRoomConversation', { roomId: cornerId, limit: 9, window: 'earliest' }],
      ] as const)
        await expect(wiredDaemon.execute(operation, input as never, outsider)).rejects.toThrow(/access denied/);
    } finally {
      await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, A]);
    }
  });


  it('Reproduction R4-TARGET-READ: an unrelated roomId never opens a corner read', async () => {
    const cornerId = await inReview();
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks));
    const unrelated = randomUUID();
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Unrelated')`, [unrelated, W]);
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,
      [W, unrelated, A, B],
    );
    // B leaves the corner and its parent Room but stays in the unrelated Room.
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id IN ($1,$2) AND identity_id=$3`, [cornerId, R, B]);
    try {
      const reads = [
        ['getCornerRestoreState', { roomId: unrelated, cornerId }],
        ['getPrChecksStatus', { roomId: unrelated, cornerId, pullRequest: 7 }],
        ['listCornerBriefRevisions', { roomId: unrelated, cornerId }],
      ] as const;
      for (const [operation, input] of reads)
        await expect(wiredDaemon.execute(operation, input as never, B), operation).rejects.toThrow(/access denied/);
      // A, who reaches the corner, still reads it with the same unrelated roomId.
      for (const [operation, input] of reads)
        await expect(wiredDaemon.execute(operation, input as never, A), operation).resolves.toBeDefined();
    } finally {
      await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id IN ($1,$2) AND identity_id=$3`, [cornerId, R, B]);
      await rootFixture.db.query(`DELETE FROM memberships WHERE room_id=$1`, [unrelated]);
      await rootFixture.db.query(`DELETE FROM rooms WHERE id=$1`, [unrelated]);
    }
  });


  it('Reproduction REACH-2: a Room and all its corners read each other with inherited membership', async () => {
    const cornerId = await open();
    const cornerOnly = '5'.repeat(64);
    const roomOnly = '6'.repeat(64);
    await rootFixture.db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Corner only'),($2,'human','Room only') ON CONFLICT DO NOTHING`,
      [cornerOnly, roomOnly],
    );
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member'),($1,$4,$5,'member') ON CONFLICT DO NOTHING`,
      [W, R, cornerOnly, R, roomOnly],
    );
    try {
      await say(R, 'Room fact: the widget ships blue');
      const roomMessage = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND text LIKE 'Room fact%'`, [R])).rows[0]!.id;
      await say(cornerId, 'Corner fact: the widget ships on Friday');
      const cornerMessage = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND text LIKE 'Corner fact%'`, [cornerId])).rows[0]!.id;

      await say(cornerId, '@hoots what colour is the widget?');
      const inCorner = (await commands(A, cornerId)).at(-1)!;
      await claim(inCorner);
      await expect(rootFixture.daemon.execute('getRoomMessage', {
        roomId: cornerId, requestId: inCorner.turnRequestId, generationId: 'g1', messageId: roomMessage,
      }, A)).resolves.toMatchObject({ body: expect.stringContaining('ships blue') });
      // Sibling corners share the same current Room audience.
      const sibling = await open();
      await say(sibling, 'Sibling fact: the widget is heavy');
      const siblingMessage = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND text LIKE 'Sibling fact%'`, [sibling])).rows[0]!.id;
      await expect(rootFixture.daemon.execute('getRoomMessage', {
        roomId: cornerId, requestId: inCorner.turnRequestId, generationId: 'g1', messageId: siblingMessage,
      }, A)).resolves.toMatchObject({ body: expect.stringContaining('heavy') });

      await say(R, '@hoots when does the widget ship?');
      const inRoom = (await commands(A, R)).at(-1)!;
      await claim(inRoom);
      await expect(rootFixture.daemon.execute('getRoomMessage', {
        roomId: R, requestId: inRoom.turnRequestId, generationId: 'g1', messageId: cornerMessage,
      }, A)).resolves.toMatchObject({ body: expect.stringContaining('on Friday') });
    } finally {
      await rootFixture.db.query(`DELETE FROM memberships WHERE identity_id IN ($1,$2)`, [cornerOnly, roomOnly]);
    }
  });


  it('Reproduction SR-1: a sole implementer reviewer receives the existing missing-reviewer handback', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('review');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'checks', outcome: 'no_reviewer', toState: 'review' }),
    );
    const pending = await commands(A, cornerId);
    expect(pending.some(command => command.reason === 'corner_review_needed')).toBe(true);
    expect(pending.some(command => command.reason === 'subscribed_event' || command.reason === 'corner_review_dispatch')).toBe(false);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({
      stage: 'waiting_for_yes', approved: false, mergeAllowed: false,
    });
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });
});
describe('Reproduction PR-2960-draft', () => {
const scope26 = fixtureScope26();

  it('reports a passed green draft as blocked, marks it ready and merges through mergeCorner', async () => {
    const cornerId = await approved();
    let draft = true;
    rootFixture.githubApp.readPullRequest.mockImplementation(async () => ({ number: 7,
      url: 'https://github.com/owner/widgets/pull/7', headSha: SHA,
      mergeability: draft ? 'draft' : 'clean' }));
    rootFixture.githubApp.markPullRequestReadyForReview.mockImplementation(async () => { draft = false; });
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ mergeAllowed: false, blockedReason: 'PR is a draft' });
    expect(await scope26.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toMatchObject({ status: 'merge-started' });
    expect(rootFixture.githubApp.markPullRequestReadyForReview).toHaveBeenCalledWith('tok', 'owner/widgets', 7, SHA);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(rootFixture.githubApp.markPullRequestReadyForReview.mock.invocationCallOrder[0]).toBeLessThan(rootFixture.githubApp.mergePullRequest.mock.invocationCallOrder[0]!);
  });


  it('waits for checks restarted by marking ready, then merges after they pass', async () => {
    const cornerId = await approved();
    let draft = true;
    rootFixture.githubApp.readPullRequest.mockImplementation(async () => ({ number: 7,
      url: 'https://github.com/owner/widgets/pull/7', headSha: SHA,
      mergeability: draft ? 'draft' : 'clean' }));
    rootFixture.githubApp.markPullRequestReadyForReview.mockImplementation(async () => { draft = false; rootFixture.githubRollupState = 'pending'; });
    expect(await scope26.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toMatchObject({ status: 'blocked', blocker: 'checks are pending' });
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    rootFixture.githubRollupState = 'passed';
    expect(await scope26.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toMatchObject({ status: 'merge-started' });
    expect(rootFixture.githubApp.markPullRequestReadyForReview).toHaveBeenCalledTimes(1);
  });


  it.each(['held', 'stale-pass', 'person-yes'])('leaves a draft alone with %s', async condition => {
    const cornerId = await approved();
    rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA, mergeability: 'draft' });
    if (condition === 'held') await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    if (condition === 'stale-pass') await rootFixture.db.query(`UPDATE corner_merge_approvals SET head_sha=$2 WHERE corner_id=$1`, [cornerId, 'b'.repeat(40)]);
    if (condition === 'person-yes') await rootFixture.db.query(`UPDATE corner_merge_approvals SET approved_by=$2 WHERE corner_id=$1`, [cornerId, H]);
    expect(await scope26.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toMatchObject({ status: 'blocked' });
    expect(rootFixture.githubApp.markPullRequestReadyForReview).not.toHaveBeenCalled();
  });


  it('leaves an unpassed draft alone', async () => {
    const cornerId = await inReview();
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA, mergeability: 'draft' });
    expect(await scope26.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('PR is a draft') });
    expect(rootFixture.githubApp.markPullRequestReadyForReview).not.toHaveBeenCalled();
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it('reports a failed ready-mark once to the commander and keeps the draft blocked', async () => {
    const cornerId = await approved();
    rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/widgets/pull/7', headSha: SHA, mergeability: 'draft' });
    rootFixture.githubApp.markPullRequestReadyForReview.mockRejectedValue(new Error('HTTP 403'));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await scope26.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toMatchObject({ status: 'blocked', blocker: 'PR is a draft: HTTP 403' });
    }
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    const reports = await rootFixture.db.query(`SELECT 1 FROM messages WHERE text LIKE 'blocked: PR is a draft%'`);
    const privateReports = await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE private_payload->>'text' LIKE 'blocked: PR is a draft%'`);
    expect(reports.rowCount + privateReports.rowCount).toBe(1);
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [cornerId]);
    await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [cornerId]);
    expect(await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).toMatchObject({ state: 'waiting' });
  });
});
describe('MERGE-LIVE: merges read GitHub live; nothing records an attempt', () => {
const scope28 = fixtureScope28();


  it('a successful gated merge archives without the closed webhook, once', async () => {
    const cornerId = await approved();
    rootFixture.githubApp.readPullRequest.mockResolvedValue(scope28.providerPr(cornerId, false));
    rootFixture.githubApp.mergePullRequest.mockImplementationOnce(async () => {
      rootFixture.githubApp.readPullRequest.mockResolvedValue(scope28.providerPr(cornerId, true));
    });
    expect(await implementersMerge()).toBe(1);
    await scope28.landing(cornerId);
    await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 });
    await scope28.landing(cornerId);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });


  it('a lost merge response is settled by the live pull request read: merged lands, no refusal', async () => {
    const cornerId = await approved();
    rootFixture.githubApp.readPullRequest.mockResolvedValue(scope28.providerPr(cornerId, false));
    rootFixture.githubApp.mergePullRequest.mockImplementationOnce(async () => {
      rootFixture.githubApp.readPullRequest.mockResolvedValue(scope28.providerPr(cornerId, true));
      throw new TypeError('fetch failed');
    });
    expect(await rootFixture.github.landCornerOutcome(cornerId)).toEqual({ status: 'started' });
    await scope28.landing(cornerId);
    expect(await reasons(cornerId, A)).not.toContain('corner_merge_refused');
  });


  it('an unreadable outcome is settled later by the merge webhook, with no stored claim', async () => {
    const cornerId = await approved();
    rootFixture.githubApp.mergePullRequest.mockImplementationOnce(async () => {
      rootFixture.githubApp.readPullRequest.mockRejectedValue(new Error('temporary GitHub outage'));
    });
    expect(await implementersMerge()).toBe(1);
    expect(await currentState(cornerId)).toBe('review');
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('landed');
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
describe('at most one merge per head (AC-7)', () => {
  it('concurrent sweeps, direct lands and a redelivered verdict merge once, with no refusal', async () => {
    const cornerId = await approved();
    const merged = {
      number: 7, url: 'https://github.com/owner/widgets/pull/7', title: 'Ship the widget',
      headSha: SHA, headRef: branchOf(cornerId), baseRef: 'main', merged: true, mergeability: 'clean',
      mergedAt: '2026-01-01T00:00:00Z', mergeCommitSha: '8'.repeat(40),
    };
    let landedOnGitHub = false;
    // GitHub merges a pull request once; a later attempt on that head is refused.
    rootFixture.githubApp.mergePullRequest.mockImplementation(async () => {
      if (landedOnGitHub) throw new GitHubHttpError('Pull Request is not mergeable', 405);
      landedOnGitHub = true;
      rootFixture.githubApp.readPullRequest.mockResolvedValue(merged);
    });
    await Promise.all([
      implementersMerge(),
      implementersMerge(),
      rootFixture.github.landCorner(cornerId),
      rootFixture.github.landCorner(cornerId),
      approve(cornerId),
    ]);
    await implementersMerge();
    expect(landedOnGitHub).toBe(true);
    expect(await currentState(cornerId)).toBe('landed');
    expect(await reasons(cornerId, A)).not.toContain('corner_merge_refused');
  });
});
describe('the gate stays shut (AC-8)', () => {
  it('Reproduction R4: a negated proceed instruction cannot release a hold', async () => {
    const cornerId = await approved();
    await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    await say(cornerId, 'hold');
    await say(cornerId, 'Do not proceed until I check this');
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, open: false });
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ held: true, mergeAllowed: false });
  });

  it('after a push following PASS', async () => {
    const cornerId = await approved();
    const next = '8'.repeat(40);
    await pushToCorner(cornerId, next);
    expect(await currentState(cornerId)).toBe('checks');
    rootFixture.githubHead = next;
    expect(await implementersMerge()).toBe(0);
    expect((await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 })).mergeAllowed).toBe(false);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it('while a person holds it, and opens when they lift the hold', async () => {
    const cornerId = await approved();
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    expect(await implementersMerge()).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    await say(cornerId, 'go ahead');
    expect(await implementersMerge()).toBe(0);
    await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
    expect(await implementersMerge()).toBe(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });


  it('HOLD-ARCHIVE: closing or merging a corner releases its holds, and migration repairs older ones', async () => {
    const active = async (cornerId: string) => Number((await rootFixture.db.query<{ n: string }>(
      `SELECT count(*) n FROM corner_merge_holds WHERE corner_id=$1 AND released_at IS NULL`, [cornerId])).rows[0]!.n);
    const closed = await approved();
    await rootFixture.phone.execute('setCornerHold', { cornerId: closed }, H);
    await rootFixture.phone.execute('requestCornerClose', { roomId: closed }, H);
    expect(await active(closed)).toBe(0);
    const merged = await approved();
    await rootFixture.phone.execute('setCornerHold', { cornerId: merged }, H);
    await mergedWebhook(merged, 7, SHA);
    expect(await rootFixture.db.query(`SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL`, [merged])).toMatchObject({ rowCount: 1 });
    expect(await active(merged)).toBe(0);
    const stale = await approved();
    await rootFixture.phone.execute('setCornerHold', { cornerId: stale }, H);
    await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [stale]);
    await migrateData(rootFixture.db);
    expect(await active(stale)).toBe(0);
    expect((await rootFixture.db.query(`SELECT released_by FROM corner_merge_holds WHERE corner_id=$1`, [stale])).rows)
      .toEqual([{ released_by: SYSTEM_IDENTITY_ID }]);
  });
});
