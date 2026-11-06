import { phoneFetch, randomBytes, randomUUID, describe, expect, it, vi, migrate, assignCornerWorker, PhoneService, DaemonService, GitHubOperations, LiveHub, systemLine, advanceCorner, backfillCornerLifecycleRuns, cornerMergeGate, confirmCornerMergeAuthority, createAgentCommand, CORNER_LIFECYCLE_CARD_TYPE, H, A, B, W, R, db, phone, daemon, github, githubRollupState, githubHead, githubApp, implementersMerge, currentState, commissioned, brief, open, claim, pushToCorner, greenHead, redHead, resumeWorker, commands, result, SHA, branchOf, reasons, projected, inReview, approve, approved, mergedWebhook, say, rootFixture, fixtureScope30, fixtureScope31, type GitHubAppClient, type GitHubOAuthClient } from './test-support-corner-lifecycle.test-support.js';

describe('the gate stays shut (AC-8)', () => {

  it('R4: holds survive more than 200 messages and deletion, without chat-derived releases', async () => {
    const cornerId = await approved();
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    await say(cornerId, 'hold');
    await rootFixture.db.query(`UPDATE messages SET deleted_at=now() WHERE room_id=$1 AND text='hold'`, [cornerId]);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text)
      SELECT md5($1 || n::text) || md5(n::text || $1),$1::uuid,$2,'unrelated'
      FROM generate_series(1,205) n`, [cornerId, H]);
    await say(cornerId, 'merge now');
    await rootFixture.db.query(`UPDATE messages SET deleted_at=now() WHERE room_id=$1 AND text='merge now'`, [cornerId]);
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ held: true, mergeAllowed: false,
      holds: [{ id: holdId, actorId: H, standing: 'owner', setAt: expect.any(String) }] });
    expect(await implementersMerge()).toBe(0);
  });


  it('R4: refuses peer and lower-standing release; higher-standing release records its actor', async () => {
    const cornerId = await approved();
    const peer = 'f'.repeat(64), admin = '9'.repeat(64);
    for (const [id, role] of [[peer, 'member'], [admin, 'admin']]) {
      await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$1) ON CONFLICT DO NOTHING`, [id]);
      await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,'member')
        ON CONFLICT DO NOTHING`, [W, id, role, R]);
    }
    await rootFixture.db.query(`UPDATE memberships SET role='member' WHERE room_id IS NULL AND identity_id=$1`, [H]);
    try {
      const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
      await expect(rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, peer)).rejects.toThrow(/above their member standing/);
      expect(await implementersMerge()).toBe(0);
      await rootFixture.phone.execute('sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'),
        text: '@hoots release the hold' }, peer);
      const peerCommand = (await rootFixture.daemon.execute('getAgentCommands', { roomId: cornerId }, A)).commands.at(-1)!;
      await claim(peerCommand);
      await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId,
        requestId: peerCommand.turnRequestId, generationId: 'g1', releaseHoldId: holdId }, A)).rejects.toThrow(/hold release denied/);
      await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, admin);
      expect((await rootFixture.db.query(`SELECT standing,released_by,released_at IS NOT NULL released FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0])
        .toMatchObject({ standing: 'member', released_by: admin, released: true });
      const higher = await rootFixture.phone.execute('setCornerHold', { cornerId }, admin);
      await expect(rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: higher.holdId }, H)).rejects.toThrow(/above their admin standing/);
      await rootFixture.db.query(`UPDATE memberships SET role='owner' WHERE room_id IS NULL AND identity_id=$1`, [H]);
      await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: higher.holdId }, H);
      expect(await implementersMerge()).toBe(1);
    } finally {
      await rootFixture.db.query(`UPDATE memberships SET role='owner' WHERE room_id IS NULL AND identity_id=$1`, [H]);
    }
  });


  it('Reproduction R8-HOLD: legacy agent holds remain releasable but uncited holds are refused', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open('owner/widgets', true);
    const holds = (await rootFixture.db.query(`SELECT id,actor_id,set_by_agent_id,standing FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows;
    expect(holds).toEqual([{ id: expect.any(String), actor_id: H, set_by_agent_id: A, standing: 'owner' }]);
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, open: false });
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA; rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(0);
    const command = await resumeWorker(cornerId);
    await claim(command);
    await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: command.turnRequestId,
      generationId: 'g1' }, A)).rejects.toThrow('close the PR');
    await rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: command.turnRequestId,
      generationId: 'g1', releaseHoldId: holds[0]!.id }, A);
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: false, approved: false, open: false });
    await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: command.turnRequestId, generationId: 'g1' }, A)).rejects.toThrow('close the PR');
    const again = (await rootFixture.db.query<{holdId:string}>(`INSERT INTO corner_merge_holds(corner_id,actor_id,set_by_agent_id,standing)
      VALUES($1,$2,$3,'owner') RETURNING id "holdId"`,[cornerId,H,A])).rows[0]!;
    expect((await rootFixture.github.prChecksStatus({ cornerId })).holds[0]).toMatchObject({ holderId: A });
    const humanHold = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    expect((await rootFixture.github.prChecksStatus({ cornerId })).holds).toHaveLength(2);
    await migrate(rootFixture.db);
    expect((await rootFixture.github.prChecksStatus({ cornerId })).holds).toHaveLength(2);
    await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: again.holdId }, H);
    await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: command.turnRequestId, generationId: 'g1', releaseHoldId: humanHold.holdId }, A)).rejects.toThrow('Human');
    await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: humanHold.holdId }, H);
  });


  it('Reproduction H1: the holder’s release order in the parent Room releases the hold from that Room turn', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open('owner/widgets', true);
    const holdId = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows[0]!.id;
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA; rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(0);
    await say(R, '@hoots release the hold');
    const order = (await commands(A, R)).at(-1)!;
    await claim(order);
    await rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: R, requestId: order.turnRequestId,
      generationId: 'g1', releaseHoldId: holdId }, A);
    expect((await rootFixture.db.query(`SELECT released_by FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]).toEqual({ released_by: A });
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: false, approved: false, open: false });
  });


  it('R8-HOLD: a relayed order does not let another agent release the setter’s hold', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    const cornerId = await open('owner/widgets', true);
    const holdId = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows[0]!.id;
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA; rootFixture.githubRollupState = 'passed';
    await say(R, '@hoots release the hold');
    const order = (await commands(A, R)).at(-1)!;
    await claim(order);
    await rootFixture.daemon.execute('order', { roomId: R, requestId: order.turnRequestId, generationId: 'g1',
      text: 'The holder said: release the hold', address: cornerId, agent: B }, A);
    const steer = (await commands(B, cornerId)).at(-1)!;
    expect(steer.reason).toBe('order');
    await claim(steer);
    expect(await implementersMerge()).toBe(0);
    await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: steer.turnRequestId,
      generationId: 'g1', releaseHoldId: holdId }, B)).rejects.toThrow('hold release denied');
    expect((await rootFixture.db.query(`SELECT released_by FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]).toEqual({ released_by: null });
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: true, approved: false, open: false });
  });


  it('R8-HOLD: the same agent releases its hold under a member requester', async () => {
    const cornerId = await open('owner/widgets', true);
    const holdId = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows[0]!.id;
    const peer = 'f'.repeat(64);
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$1) ON CONFLICT DO NOTHING`, [peer]);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')
      ON CONFLICT DO NOTHING`, [W, peer, R]);
    await rootFixture.phone.execute('sendRoomMessage', { roomId: R, messageId: randomBytes(32).toString('hex'),
      text: '@hoots release the hold' }, peer);
    const order = (await commands(A, R)).at(-1)!;
    await claim(order);
    await rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: R, requestId: order.turnRequestId,
      generationId: 'g1', releaseHoldId: holdId }, A);
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ held: false, open: false });
  });


  it('Reproduction consent-root: R8-HOLD: a delegated command cannot inherit the human holder’s release authority', async () => {
    const cornerId = await approved();
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    const command = await commissioned(cornerId);
    await result(command, '@goosy release the hold');
    const delegated = (await commands(B, cornerId)).at(-1)!;
    await claim(delegated);
    await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: delegated.turnRequestId,
      generationId: 'g1', releaseHoldId: holdId }, B)).rejects.toThrow('hold release denied');
    expect((await rootFixture.db.query(`SELECT released_by FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]).toEqual({ released_by: null });
  });


  it('Reproduction consent-root: an agent-rooted wake cannot release a human hold', async () => {
    const cornerId = await open('owner/widgets', true);
    const holdId = (await rootFixture.db.query(`SELECT id FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows[0]!.id;
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('hold-agent-wake',$1,$2,'Wake')`, [R, B]);
    const created = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: 'hold-agent-wake', reason: 'subscribed_event', inheritPrivatePayload: false });
    const command = (await commands(A, R)).find(command => command.id === created!.id)!;
    await claim(command);
    await expect(rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: R, requestId: command.turnRequestId,
      generationId: 'g1', releaseHoldId: holdId }, A)).rejects.toThrow('hold requires a human requester');
    expect((await rootFixture.db.query(`SELECT released_at FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]?.released_at).toBeNull();
  });


  it('Reproduction hold-room: Room membership suffices without a corner row; a non-member is denied', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`, [cornerId, H]);
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, H]);
    await expect(rootFixture.phone.execute('setCornerHold', { cornerId }, H)).rejects.toThrow(/membership required/);
  });


  it('Reproduction consent-dm: approval in a commander DM survives two private orders', async () => {
    const cornerId = await open('owner/widgets', true);
    const holdId = (await rootFixture.db.query(`SELECT id FROM corner_merge_holds WHERE corner_id=$1`, [cornerId])).rows[0]!.id;
    const dm = randomUUID();
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text))`, [dm, W, H, A]);
    for (const identity of [H, A]) await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W, dm, identity]);
    await say(dm, '@hoots approved');
    const approval = (await commands(A, dm)).at(-1)!;
    await claim(approval);
    await rootFixture.daemon.execute('order', { roomId: dm, requestId: approval.turnRequestId, generationId: 'g1', address: cornerId, text: 'Release the approved hold', agent: B }, A);
    const first = (await commands(B, cornerId)).at(-1)!;
    await claim(first);
    await rootFixture.daemon.execute('order', { roomId: cornerId, requestId: first.turnRequestId, generationId: 'g1', address: cornerId, text: 'Release the approved hold', agent: A }, B);
    const second = (await commands(A, cornerId)).at(-1)!;
    await claim(second);
    await rootFixture.daemon.execute('setCornerHold', { cornerId, roomId: cornerId, requestId: second.turnRequestId, generationId: 'g1', releaseHoldId: holdId }, A);
    expect((await rootFixture.db.query(`SELECT released_by FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]).toEqual({ released_by: A });
  });


  it('R4: chat alone creates no hold and migration intentionally starts inferred holds clean', async () => {
    const cornerId = await approved();
    await say(cornerId, 'hold');
    await migrate(rootFixture.db);
    expect((await rootFixture.github.prChecksStatus({ cornerId })).held).toBe(false);
    expect(await implementersMerge()).toBe(1);
  });


  it('R4: a failed initial hold rolls back the entire corner', async () => {
    const command = await commissioned(R);
    const count = (await rootFixture.db.query(`SELECT count(*) n FROM rooms WHERE parent_id=$1`, [R])).rows;
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, H]);
    try {
      await expect(rootFixture.daemon.execute('createCorner', { roomId: R, requestId: command.turnRequestId,
        generationId: 'g1', name: 'Held-work', objective: 'Keep this corner held', hold: true,
        brief: brief(command.sourceMessageId) }, A))
        .rejects.toThrow('close the PR');
      expect((await rootFixture.db.query(`SELECT count(*) n FROM rooms WHERE parent_id=$1`, [R])).rows).toEqual(count);
      expect((await rootFixture.db.query(`SELECT count(*) n FROM corner_merge_holds`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, H]);
    }
  });


  it('Demonstrated R8-HOLD and HOLD-IDS: HTTP agent and socket person hold release stay separate', async () => {
    const { createBeelineServer } = await import('../dist/server.js');
    const { PhoneService: BuiltPhone } = await import('../dist/phone-service.js');
    const { HelperDaemonService: BuiltDaemon } = await import('../dist/test-fixtures/helper-daemon.js');
    const { GitHubOperations: BuiltGitHub } = await import('../dist/github-operations.js');
    const { TokenAuth, tokenHash } = await import('./auth.js');
    const auth = new TokenAuth(rootFixture.db, async () => { throw new Error('fixture does not sign in'); });
    const token = 'R4-fixture-phone-token';
    await rootFixture.db.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
      VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT DO NOTHING`, [tokenHash(token), H, W]);
    const exchange = await auth.createDaemonExchange(A);
    const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
    const builtGitHub = new BuiltGitHub(rootFixture.db, {} as GitHubOAuthClient, rootFixture.githubApp as unknown as GitHubAppClient, 'secret');
    const live = new LiveHub();
    const builtDaemon = new BuiltDaemon(rootFixture.db, live, undefined, undefined, false, undefined, false, undefined,
      input => builtGitHub.prChecksStatus(input), undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, id => builtGitHub.landCorner(id));
    const server = createBeelineServer({ database: rootFixture.db, auth, phone: new BuiltPhone(rootFixture.db, 'http://test'),
      daemon: builtDaemon, live, mediaMaximumBytes: 1 });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const post = async (lane: 'phone' | 'daemon', operation: string, body: unknown, expectedStatus = 200) => {
      const response = await (lane === 'phone' ? phoneFetch : fetch)(`http://127.0.0.1:${address.port}/v1/${lane}/operations/${operation}`, {
        method: 'POST', headers: { authorization: `Bearer ${lane === 'phone' ? token : daemonToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.text();
      const result = payload ? JSON.parse(payload) : undefined;
      expect(response.status, JSON.stringify(result)).toBe(expectedStatus);
      return result;
    };
    try {
      await post('phone', 'updateRoom', { roomId: R, reviewerAgentId: A }, 204);
      const cornerId = await open('owner/widgets', true);
      await greenHead(cornerId, 7, SHA);
      rootFixture.githubHead = SHA; rootFixture.githubRollupState = 'passed';
      let holdId = (await post('daemon', 'getPrChecksStatus', { cornerId })).holds[0].id;
      const objective = await resumeWorker(cornerId);
      await rootFixture.daemon.execute('claimAgentCommand',{roomId:cornerId,commandId:objective.id,generationId:'g1'},A);
      await post('daemon', 'setCornerHold', { cornerId, roomId: cornerId,
        requestId: objective.turnRequestId, generationId: 'g1', releaseHoldId: holdId });
      expect((await rootFixture.db.query(`SELECT released_by FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]).toEqual({ released_by: A });
      holdId = (await post('phone', 'setCornerHold', { cornerId })).holdId;
      await post('phone', 'sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'), text: 'Do not proceed until I check this' });
      const held = await post('daemon', 'getPrChecksStatus', { cornerId });
      expect(held).toMatchObject({ held: true, mergeAllowed: false,
        holds: [{ id: holdId, actorId: H, standing: 'owner', setAt: expect.any(String) }] });
      const hold = held.holds[0];
      expect(hold).toMatchObject({ holderId: H, holderName: expect.any(String) });
      const blocked = await post('daemon', 'mergeCorner', { cornerId });
      expect(blocked).toMatchObject({ status: 'blocked', holds: held.holds });
      expect(blocked.blocker).toContain(hold.id);
      expect(blocked.blocker).toContain(hold.holderName);
      // Reproduction HOLD-IDS: read -> blocked merge -> release by the returned ID.
      await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, A]);
      await post('daemon', 'getPrChecksStatus', { cornerId }, 403);
      await post('daemon', 'getCornerRestoreState', { cornerId }, 403);
      await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, A]);
      expect(await implementersMerge(builtGitHub)).toBe(0);
      expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
      await post('phone', 'sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'), text: '@hoots release the hold' });
      const direct = (await post('daemon', 'getAgentCommands', { roomId: cornerId })).commands.at(-1);
      await rootFixture.daemon.execute('claimAgentCommand',{roomId:cornerId,commandId:direct.id,generationId:'g2'},A);
      await post('daemon', 'setCornerHold', { cornerId, roomId: cornerId, requestId: direct.turnRequestId,
        generationId: 'g2', releaseHoldId: holdId }, 503);
      expect((await post('daemon', 'getPrChecksStatus', { cornerId })).held).toBe(true);
      await post('phone', 'setCornerHold', { cornerId, releaseHoldId: holdId });
      const released = await post('daemon', 'getPrChecksStatus', { cornerId });
      // The hold is gone; the self-reviewer's corner still waits for a person's yes.
      expect(released).toMatchObject({ held: false, approved: false, mergeAllowed: false, holds: [] });
      expect(await implementersMerge(builtGitHub)).toBe(0);
      // Reproduction R2199 over HTTP: the implementer's merge_corner is refused and names the missing yes.
      const refusedMerge = await post('daemon', 'mergeCorner', { cornerId });
      expect(refusedMerge).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('no yes on this head') });
      expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
      console.log(`Demonstrated R2199: authenticated HTTP mergeCorner by self-reviewing implementer => ${JSON.stringify(refusedMerge)}, merges=0.`);
      console.log('Demonstrated R8-HOLD: agent releases own hold; agent cannot release person hold; person releases hold; held=false, holds=[], mergeAllowed=false without yes (fixture GitHub).');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });


  it('but not because the implementer\'s yolo is off: a reviewer PASS still merges', async () => {
    const cornerId = await approved();
    await rootFixture.db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ approved: true, held: false, mergeAllowed: true });
    expect(await implementersMerge()).toBe(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
  });


  it('when the reviewer is no longer configured or no longer a member', async () => {
    const cornerId = await approved();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
    expect(await implementersMerge()).toBe(0);
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, B]);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    expect(await implementersMerge()).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(cornerId).toBeTruthy();
  });


  it('when no reviewer is configured at all', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('working');
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });
});
describe('zero checks with no reviewer wait for the commander', () => {
  it.each(['agent', 'person'] as const)('lands only after the %s commander says yes on the completed head', async (kind) => {
    const cornerId = await open('owner/widgets');
    rootFixture.githubHead = SHA;
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValue({ state: 'pending', total: 0, failing: [], checks: [] });
    // Use an agent order to establish the same private return route as a dispatched corner.
    await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: A, sourceMessageId: null,
      privatePayload: { kind: 'order', authorId: kind === 'agent' ? B : H, fromRoomId: R, text: 'Finish the widget' }, reason: 'order' });
    await pushToCorner(cornerId, SHA);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [cornerId,
      JSON.stringify({ checks: 'unknown', lifecycle: 'in-review', pr: { number: 7,
        url: 'https://github.com/owner/widgets/pull/7', headSha: SHA, mergeability: 'clean' } })]);
    const wired = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks));
    const added = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: A, sourceMessageId: null,
      privatePayload: { kind: 'order', authorId: kind === 'agent' ? B : H, fromRoomId: R, text: 'Finish the widget' }, reason: 'order' });
    const turn = (await commands(A, cornerId)).find(command => command.id === added!.id)!;
    await claim(turn);
    await wired.execute('postRoomMessage', { roomId: cornerId, requestId: turn.turnRequestId,
      generationId: 'g1', text: 'Widget complete' }, A);
    await wired.execute('postAgentTurnReceipt', { roomId: cornerId, requestId: turn.turnRequestId, generationId: 'g1', status: 'complete' }, A);
    await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
    expect(await currentState(cornerId)).toBe('working');

    const notices = (await commands(A, cornerId)).filter(c => c.reason === 'corner_review_needed');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ private: true, source: {
      body: expect.stringContaining('This pull request has no checks and no reviewer. Landing needs your commander\'s yes. Ask your commander using your normal report tool.'),
    } });
    expect((await commands(B, R)).filter(c => c.reason === 'report' && c.source.body.includes('pending your yes'))).toHaveLength(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text LIKE '%ready to land pending your yes%'
      OR text LIKE '%Landing needs your commander%'`)).rowCount).toBe(0);
    // Reconciliation replays the same head without another notice or a person-facing report.
    await advanceCorner(rootFixture.db, cornerId, { kind: 'checks', result: 'passing', sourceMessageId: cornerId });
    expect((await commands(A, cornerId)).filter(c => c.reason === 'corner_review_needed')).toHaveLength(1);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValue({ state: 'pending', total: 0, failing: [], checks: [] });
    try {
      expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
      expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
      await expect(approve(cornerId, SHA, A)).rejects.toThrow('configured reviewer');
      if (kind === 'agent') {
        await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary,total}','1') WHERE corner_id=$1`, [cornerId]);
        await expect(approve(cornerId, SHA, B)).rejects.toThrow('configured reviewer');
        await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checksSummary,total}','0') WHERE corner_id=$1`, [cornerId]);
        await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
        await expect(approve(cornerId, SHA, B)).rejects.toThrow('configured reviewer');
        await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
        await expect(approve(cornerId, '8'.repeat(40), B)).rejects.toThrow('STALE_HEAD');
        await approve(cornerId, SHA, B);
        expect((await reasons(cornerId, A))).not.toContain('corner_land');
        const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
        expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
        await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
        await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
        expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
        await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, B]);
        expect(await rootFixture.github.landCorner(cornerId)).toBe(true);
      } else {
        await rootFixture.github.approveCornerMerge(H, { cornerId });
      }
      expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledOnce();
      await mergedWebhook(cornerId, 7, SHA);
      expect(await currentState(cornerId)).toBe('archived');
    } finally {
      rootFixture.githubApp.readCommitCheckRollup.mockImplementation(async () => ({ state: rootFixture.githubRollupState, total: 1,
        failing: rootFixture.githubRollupState === 'failed' ? ['typecheck'] : [], checks: [{ name: 'typecheck', status: rootFixture.githubRollupState }] }));
    }
  });
});
describe("a Workspace owner or admin's yes (order_corner_merge) merges only through the one gate", () => {
const scope30 = fixtureScope30();


  it('a corner with no reviewer set merges on its owner\'s yes, but not before and not while a hold stands', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('working');
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';

    // Left alone, a corner with no reviewer never merges itself.
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA }))
      .toMatchObject({ reviewerExists: false, approved: false, open: false });
    expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();

    // A hold is the only veto: the owner's yes is recorded, but it does not merge.
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    await rootFixture.db.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [A]);
    await expect(scope30.order(cornerId)).resolves.toEqual({ roomId: cornerId, headSha: SHA });
    expect(await currentState(cornerId)).toBe('working');

    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA }))
      .toMatchObject({ reviewerExists: false, approved: true, held: true, open: false });
    const status = await rootFixture.github.prChecksStatus({ cornerId });
    expect(status).toMatchObject({ approved: true, held: true, mergeAllowed: false });
    // Each fact is named once: no held/didHumanSayDontMerge duplicate survives.
    expect(Object.keys(status).filter((key) => /humansaydontmerge/i.test(key))).toEqual([]);
    expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();

    // Lifting the hold opens the gate on the same yes; yolo is not part of it.
    await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
    // GitHub merges once: afterwards the live pull request reads merged.
    rootFixture.githubApp.mergePullRequest.mockImplementationOnce(async () => {
      rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/widgets/pull/7',
        headSha: SHA, headRef: branchOf(cornerId), baseRef: 'main', merged: true, mergedAt: '2026-01-01T00:00:00Z' });
    });
    expect(await rootFixture.github.landCorner(cornerId)).toBe(true);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });


  it('waits for green checks: the yes is kept, and green on that head wakes the implementer to merge', async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('working');
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'failed';

    const landing = vi.fn((id: string) => rootFixture.github.landCornerOutcome(id));
    const wiredDaemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, landing);
    await scope30.order(cornerId, wiredDaemon);
    // Recording the yes does not invoke the landing action.
    expect(landing).not.toHaveBeenCalled();
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(await currentState(cornerId)).toBe('working');
    expect(await rootFixture.github.prChecksStatus({ cornerId }))
      .toMatchObject({ stage: 'building', checks: 'failed', approved: true, mergeAllowed: false });
    expect(await implementersMerge()).toBe(0);

    // Checks go green on the same head: the kept yes needs no review.
    const before = (await reasons(cornerId, A)).filter((reason) => reason === 'corner_land');
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`, [cornerId]);
    await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' }, verb: 'passed a check', kind: 'check-passed' });

    expect((await reasons(cornerId, A)).filter((reason) => reason === 'corner_land')).toHaveLength(before.length + 1);
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
  });


  it('a new commit cancels the yes', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    await scope30.order(cornerId);
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true, open: true });
    const next = '8'.repeat(40);
    await greenHead(cornerId, 7, next);
    rootFixture.githubHead = next;
    rootFixture.githubRollupState = 'passed';
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: next })).toMatchObject({ approved: false, open: false });
    expect(await implementersMerge()).toBe(0);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it('confirmCornerMergeAuthority allows only an open gate on the exact current head', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    expect(await confirmCornerMergeAuthority(rootFixture.db, cornerId, SHA)).toBe(false);
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    await scope30.order(cornerId);
    expect(await confirmCornerMergeAuthority(rootFixture.db, cornerId, SHA)).toBe(false);
    await rootFixture.phone.execute('setCornerHold', { cornerId, releaseHoldId: holdId }, H);
    expect(await confirmCornerMergeAuthority(rootFixture.db, cornerId, '9'.repeat(40))).toBe(false);
    expect(await confirmCornerMergeAuthority(rootFixture.db, cornerId, SHA)).toBe(true);
  });


  it("the phone's approve is the same yes: it waits for green checks, then the implementer merges", async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'failed';
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).resolves.toMatchObject({ status: 'merge-requested' });
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).resolves.toMatchObject({ status: 'already-requested' });
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true, open: true });
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });


  it('refuses an order from someone who is not a current Workspace owner or admin', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    const peer = 'f'.repeat(64);
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$1) ON CONFLICT DO NOTHING`, [peer]);
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,
      [W, peer],
    );
    await rootFixture.db.query(
      `INSERT INTO memberships(room_id,identity_id,role,workspace_id) VALUES($1,$2,'member',$3) ON CONFLICT DO NOTHING`,
      [R, peer, W],
    );
    await rootFixture.phone.execute('sendRoomMessage', { roomId: cornerId, messageId: randomBytes(32).toString('hex'),
      text: '@hoots merge this now' }, peer);
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await expect(rootFixture.daemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A))
      .rejects.toThrow(/Workspace owner or admin/);
    expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it('recording a yes leaves landing to the explicit merge action', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    const wiredDaemon = new DaemonService(
      rootFixture.db,
      new LiveHub(),
      undefined, // roomGitHubToken
      undefined, // mediaMaximumBytes
      undefined, // commandTransaction
      undefined, // authorizedCommand
      undefined, // livePaintDiagnostics
      undefined, // liveDiagnosticServerInstance
      undefined, // prChecksStatus
      undefined, // _legacyProviderSlot
      undefined, // institutionalMemoryShadow
      undefined, // mcpRegistry
      undefined, // registryMcpOAuth
      undefined, // composio
      undefined, // feedback
      undefined, // objects
      undefined, // linkWallet
      undefined, // refreshMergeability
      (id: string) => rootFixture.github.landCornerOutcome(id), // landCorner
    );
    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await wiredDaemon.execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(await rootFixture.github.landCorner(cornerId)).toBe(true);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('archived');
  });
});
describe('the brief gate on landing: only a brief that assigns repository work merges', () => {
const scope31 = fixtureScope31();


  it.each([false, 'none'] as const)('merge_corner after a reviewer PASS is refused when the brief is %s', async (says) => {
    const cornerId = await approved();
    await scope31.briefSays(cornerId, says);
    // The reviewer's PASS itself was recorded: only the land is gated.
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true, open: true });
    await expect(scope31.wired().execute('mergeCorner', { cornerId }, A)).rejects.toThrow(scope31.REFUSAL);
    await expect(rootFixture.github.landCorner(cornerId)).rejects.toThrow(scope31.REFUSAL);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it.each([false, 'none'] as const)('recording yes cannot land when the brief is %s', async (says) => {
    const cornerId = await scope31.waitingForPerson();
    await scope31.briefSays(cornerId, says);
    await say(cornerId, '@hoots merge this now');
    const direct = (await commands(A, cornerId)).at(-1)!;
    await claim(direct);
    await scope31.wired().execute('orderCornerMerge',
      { cornerId, roomId: cornerId, requestId: direct.turnRequestId, generationId: 'g1' }, A);
    await expect(rootFixture.github.landCorner(cornerId)).rejects.toThrow(scope31.REFUSAL);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it.each([false, 'none'] as const)("the phone's approve is refused when the brief is %s", async (says) => {
    const cornerId = await scope31.waitingForPerson();
    await scope31.briefSays(cornerId, says);
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).rejects.toThrow(scope31.REFUSAL);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it('a brief revised to no repository work during the GitHub read is refused at claim', async () => {
    const cornerId = await approved();
    // Passes the early brief check, then the brief is revised while landCorner reads GitHub.
    let revised = false;
    rootFixture.githubApp.readCommitCheckRollup.mockImplementationOnce(async () => {
      await scope31.briefSays(cornerId, false);
      revised = true;
      return { state: 'passed', total: 1, failing: [], checks: [{ name: 'typecheck', status: 'passed' }] };
    });
    await expect(rootFixture.github.landCorner(cornerId)).rejects.toThrow(scope31.REFUSAL);
    expect(revised).toBe(true);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  });


  it('merges when the current brief assigns repository work', async () => {
    const cornerId = await approved();
    await scope31.briefSays(cornerId, true);
    await expect(scope31.wired().execute('mergeCorner', { cornerId }, A))
      .resolves.toEqual({ status: 'merge-started', headSha: SHA });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
  });


  it("the phone's approve merges when the brief leaves repositoryWork unset", async () => {
    const cornerId = await scope31.waitingForPerson();
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).resolves.toMatchObject({ status: 'merge-requested' });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
describe('a corner opened before the workflow run existed (AC-10)', () => {
  it('gets a run derived from its lifecycle and continues through review and merge', async () => {
    const cornerId = await inReview();
    // Pre-#1918: no run cards, no projected state; the reviewer was already woken.
    await rootFixture.db.query(`DELETE FROM messages WHERE room_id=$1 AND card_type=$2`, [
      cornerId,
      CORNER_LIFECYCLE_CARD_TYPE,
    ]);
    await rootFixture.db.query('UPDATE corner_facts SET machine=NULL WHERE corner_id=$1', [cornerId]);
    expect(await backfillCornerLifecycleRuns(rootFixture.db)).toBe(1);
    expect(await projected(cornerId)).toBe('review');

    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    expect(await currentState(cornerId)).toBe('idle');
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(1);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('archived');
  });


  it('a corner with no run at all is given one on its next event', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`DELETE FROM messages WHERE room_id=$1 AND card_type=$2`, [
      cornerId,
      CORNER_LIFECYCLE_CARD_TYPE,
    ]);
    await pushToCorner(cornerId, SHA);
    expect(await currentState(cornerId)).toBe('review');
  });
});
describe('Reproduction IDLE-1: corner status says whether its agent runs or waits', () => {
  it('restores the current implementer so legacy work goes to the assigned agent', async () => {
    const cornerId = await open('owner/widgets');
    expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).implementerAgentId).toBe(A);
    await assignCornerWorker(rootFixture.db, cornerId, B);
    expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).implementerAgentId).toBe(B);
  });


  it('reports an unanswered human decision as waiting after the worker queue drains', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [cornerId]);
    await rootFixture.db.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'outline',$2,'working')`,
      [cornerId, A],
    );
    await expect(rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).resolves.toMatchObject({
      lifecycle: expect.objectContaining({ lifecycle: 'working' }),
      activity: 'running',
    });
    // The outline asks the human, so the corner owes them a reply.
    const outline = `needs-decision: @human Outline for approval. ${'x'.repeat(400)}`;
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
       VALUES($1,$2,$3,$4,'message',now()+interval '1 second'),
             ($5,$2,$3,'thinking','activity',now()+interval '2 seconds')`,
      [randomBytes(32).toString('hex'), cornerId, A, outline, randomBytes(32).toString('hex')],
    );
    await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1`, [cornerId]);
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [cornerId]);
    await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
    const status = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A);
    expect(status).toMatchObject({
      state: 'waiting',
      activity: 'idle',
      awaiting: 'reply',
      lastMessage: { authorId: A, type: 'message', excerpt: outline.slice(0, 280) },
    });
    expect(status.lastMessage!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A human reply is the newest message: the corner no longer waits on one.
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
       VALUES($1,$2,$3,'approve','message',now()+interval '3 seconds')`,
      [randomBytes(32).toString('hex'), cornerId, H],
    );
    await advanceCorner(rootFixture.db, cornerId, { kind: 'reconcile' });
    const replied = await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A);
    // The answer clears Waiting and the completed turn's grace period.
    // Work resumes when a new command or turn actually starts.
    expect(replied).toMatchObject({ state: 'idle', activity: 'idle', lastMessage: { authorId: H, excerpt: 'approve' } });
    expect(replied.awaiting).toBeUndefined();
  });


  it('R1 round-trips server-generated UUID and hex message cursors in both directions', async () => {
    const cornerId = await open('owner/widgets');
    const uuid = randomUUID();
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'cursor boundary','message')`,
      [uuid, cornerId, A],
    );
    const page = await rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, limit: 200 }, A);
    for (const [index, item] of page.items.entries()) {
      const forward = await rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, after: item.cursor }, A);
      const backward = await rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, before: item.cursor, window: 'recent' }, A);
      expect(forward.items.map(row => row.id)).toEqual(page.items.slice(index + 1).map(row => row.id));
      expect(backward.items.map(row => row.id)).toEqual(page.items.slice(0, index).map(row => row.id));
    }
    expect(page.items.some(item => item.id === uuid)).toBe(true);
    for (const cursor of [uuid, '123,abc', 'invalid']) {
      await expect(rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, after: cursor }, A)).rejects.toThrow('pass the returned next object unchanged');
      await expect(rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, before: cursor }, A)).rejects.toThrow('pass the returned next object unchanged');
    }
  });


  it('pages a conversation backward from the newest messages with a before cursor', async () => {
    const cornerId = await open('owner/widgets');
    for (const text of ['one', 'two', 'three', 'four']) await say(cornerId, text);
    const newest = await rootFixture.daemon.execute(
      'getRoomConversation',
      { roomId: cornerId, limit: 2, window: 'recent' },
      A,
    );
    const all = await rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, limit: 200, window: 'recent' }, A);
    expect(all.items.length).toBeGreaterThan(2);
    expect(newest.items.map((item) => item.id)).toEqual(all.items.slice(-2).map((item) => item.id));
    const older = await rootFixture.daemon.execute(
      'getRoomConversation',
      { roomId: cornerId, limit: 2, window: 'recent', before: newest.items[0]!.cursor },
      A,
    );
    expect(older.items.map((item) => item.id)).toEqual(all.items.slice(-4, -2).map((item) => item.id));
    await expect(
      rootFixture.daemon.execute('getRoomConversation', { roomId: cornerId, window: 'earliest', before: newest.items[0]!.cursor }, A),
    ).rejects.toThrow(/before cursor/);
  });
});
