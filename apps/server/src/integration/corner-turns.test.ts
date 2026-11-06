import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { migrateMembershipSubscriptions } from '.././agent-subscriptions.js';
import { createAgentCommand, claimAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PhoneService } from '.././phone-service.js';
import { isRoomView, type RoomView } from '@beeline/api-contract/phone';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: corner-turns', () => {
const fixture = monolithFixture();

  it('returns nonretryable refusals for retired tools and legacy watch kinds', async () => {
    const messageId = createHash('sha256').update('retired-tool-source').digest('hex');
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@bee do this')`, [messageId, ROOM, HUMAN]);
    const command = (await createAgentCommand(fixture.database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: messageId, reason: 'human_tag', turnRequestId: 'retired-tool',
    }))!;
    await claimAgentCommand(fixture.database, ROOM, AGENT, command.id, 'retired-g');
    const turn = { roomId: ROOM, requestId: 'retired-tool', generationId: 'retired-g' };
    const relay = await fixture.request('/v1/daemon/operations/postRoomMessage', 'POST', {
      ...turn, text: 'Old steer', relay: { fromRoomId: ROOM, toRoomId: ROOM, direction: 'down' },
    }, fixture.daemonToken);
    expect(relay.status).toBe(410);
    expect(await relay.json()).toMatchObject({ error: expect.stringContaining('use order and report') });
    const retired = await fixture.request('/v1/daemon/operations/getCornerAsk', 'POST', turn, fixture.daemonToken);
    expect(retired.status).toBe(410);
    expect(await retired.json()).toMatchObject({ error: expect.stringContaining('use order and report') });
    const watch = await fixture.request('/v1/daemon/operations/watchCorner', 'POST', {
      ...turn, cornerId: ROOM, kinds: ['check-passed'],
    }, fixture.daemonToken);
    expect(watch.status).toBe(400);
    const empty = await fixture.request('/v1/daemon/operations/report', 'POST', { ...turn, text: 'blocked:' }, fixture.daemonToken);
    expect(empty.status).toBe(400);
    const privateOrder = (await createAgentCommand(fixture.database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: null, reason: 'order', turnRequestId: 'retired-private',
      privatePayload: { kind: 'order', authorId: HUMAN, fromRoomId: ROOM, text: 'Do the private work' },
    }))!;
    await claimAgentCommand(fixture.database, ROOM, AGENT, privateOrder.id, 'private-g');
    const privateRelay = await fixture.request('/v1/daemon/operations/postRoomMessage', 'POST', {
      roomId: ROOM, requestId: 'retired-private', generationId: 'private-g', text: 'Old private steer',
      relay: { fromRoomId: ROOM, toRoomId: ROOM, direction: 'down' },
    }, fixture.daemonToken);
    expect(privateRelay.status).toBe(410);
    expect((await fixture.database.query(`SELECT state FROM agent_commands WHERE id=$1`, [privateOrder.id])).rows[0]?.state).toBe('claimed');
    expect((await fixture.database.query(`SELECT 1 FROM messages WHERE text LIKE 'done: Old private steer%'`)).rowCount).toBe(0);
    expect((await fixture.database.query(`SELECT 1 FROM agent_commands WHERE private_payload->>'text'='done: Old private steer'`)).rowCount).toBe(0);

  });

  it('has no feedback triage setting or tools, refuses Fixed DMs from a non-sender, and opens fix corners beside the corner', async () => {
    const corner = (
      (await fixture.phone.execute('createHumanCorner', { roomId: ROOM, title: 'Issues-triage' }, HUMAN)) as {
        id: string;
      }
    ).id;
    let turns = 0;
    const turnIn = async (roomId: string, authorId = HUMAN) => {
      turns += 1;
      const messageId = createHash('sha256').update(`triage-${turns}`).digest('hex');
      await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
        messageId,
        roomId,
        authorId,
        '@bee sweep the feedback',
      ]);
      const requestId = `triage-request-${turns}`;
      const command = await createAgentCommand(fixture.database, {
        roomId,
        agentId: AGENT,
        sourceMessageId: messageId,
        reason: 'human_tag',
        turnRequestId: requestId,
      });
      await claimAgentCommand(fixture.database, roomId, AGENT, command!.id, `${requestId}-g`);
      return { roomId, requestId, generationId: `${requestId}-g`, messageId };
    };
    const daemonCall = (name: string, body: unknown) =>
      fixture.request(`/v1/daemon/operations/${name}`, 'POST', body, fixture.daemonToken);

    // The setting and the triage tools are gone: their routes do not exist.
    for (const retired of ['listFeedback', 'fileFeedbackIssue', 'setCornerFeedbackTriage']) {
      const gone = await daemonCall(retired, await turnIn(corner));
      expect(gone.status).toBe(404);
    }

    // A Fixed DM needs an owner in BEELINE_SYSTEM_SENDERS; this agent's has none.
    const during = await turnIn(corner);
    const refused = await daemonCall('notifyFeedbackFixed', {
      ...during,
      itemIds: ['fb_000000000000000000000000'],
      title: 'Grant card resolves',
      prUrl: 'https://github.com/Beeline-Work/beeline/pull/1',
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining('System DM access denied'),
    });

    // A fix corner opened from the triage corner is its sibling in the Room.
    const fix = await turnIn(corner);
    const opened = await daemonCall('createCorner', {
      ...fix,
      idempotencyKey: 'fix-grant-card',
      name: 'Fix-grant-card',
      objective: 'Fix the grant card that stays pending',
      brief: {
        spec: 'Fix the grant card that stays pending after approval (feedback fb_000000000000000000000000).\n\n## Checklist\n\n- AC-1: The grant card resolves after approval',
        approval: { sourceMessageId: fix.messageId },
      },
    });
    expect(opened.status).toBe(200);
    const { cornerId } = (await opened.json()) as { cornerId: string };
    const sibling = await fixture.database.query<{ parent_id: string }>(
      `SELECT parent_id FROM rooms WHERE id=$1`,
      [cornerId],
    );
    expect(sibling.rows[0]?.parent_id).toBe(ROOM);

    // Cited-approval cases use a non-commander reviser. The opening agent
    // otherwise now approves its own revision directly, regardless of citation.
    await fixture.database.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [cornerId, HUMAN]);

    // RO3a: reuse the human approval that dispatched this sibling corner.
    const revision = await daemonCall('reviseCornerBrief', {
      ...(await turnIn(ROOM)),
      cornerId,
      expectedRevision: 1,
      brief: {
        spec: 'Fix the grant card and preserve the approved label.',
        change: 'Clarify the approved label.',
        approval: { sourceMessageId: fix.messageId },
      },
    });
    const revised = await revision.json();
    expect({ status: revision.status, body: revised }).toMatchObject({
      status: 200,
      body: {
        revision: 2,
        sourceRoomId: corner,
        approval: {
          sourceMessageId: fix.messageId,
          text: '@bee sweep the feedback',
          approvedBy: HUMAN,
        },
      },
    });
    const unrelated = (
      (await fixture.phone.execute(
        'createHumanCorner',
        { roomId: ROOM, title: 'Unrelated-work' },
        HUMAN,
      )) as {
        id: string;
      }
    ).id;
    const unrelatedApproval = await turnIn(unrelated);
    const agentApproval = { messageId: createHash('sha256').update('triage-agent-approval').digest('hex') };
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Agent approval')`,
      [agentApproval.messageId, corner, AGENT]);
    const attachments = new Map<string, { objectId: string; purpose: string; required: boolean }>();
    for (const [index, sourceRoomId] of [ROOM, cornerId, corner, unrelated].entries()) {
      const objectId = `65432109-0000-4000-8000-00000000000${index}`;
      const bytes = Buffer.from(`Reference from ${sourceRoomId}`);
      const sha = createHash('sha256').update(bytes).digest('hex');
      await fixture.database.query(
        `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
         VALUES($1,$2,'media',$3,'text/plain','reference.txt',$4,$5,'ready',now()+interval '1 hour')`,
        [objectId, HUMAN, `media/${HUMAN}/${sha}`, bytes.length, sha],
      );
      const shared = await turnIn(sourceRoomId);
      await fixture.database.query(`UPDATE messages SET attachments=$2::jsonb WHERE id=$1`, [
        shared.messageId,
        JSON.stringify([{ url: `${fixture.origin}/v1/media/${objectId}`, name: 'reference.txt' }]),
      ]);
      attachments.set(sourceRoomId, { objectId, purpose: 'Approved reference', required: true });
    }
    let expectedRevision = 2;
    const revise = async (
      sourceMessageId: string,
      files: Array<{ objectId: string; purpose: string; required: boolean }> = [],
    ) =>
      daemonCall('reviseCornerBrief', {
        ...(await turnIn(ROOM)),
        cornerId,
        expectedRevision,
        brief: {
          spec: 'Fix the grant card and preserve the approved label.',
          change: 'Bind the approved reference.',
          approval: { sourceMessageId },
          attachments: files,
        },
      });
    const expectRefusal = async (
      sourceMessageId: string,
      files: Parameters<typeof revise>[1] = [],
    ) => {
      const refused = await revise(sourceMessageId, files);
      expect(refused.status).toBe(files.length ? 400 : 403);
      expect(await refused.json()).toMatchObject({
        error: files.length
          ? expect.stringContaining('missing or unavailable in this Room')
          : "brief.approval.sourceMessageId must cite a human message from a current Room member or an active order from this corner's commander; use the delivered order ID or its forwarded root human message ID",
      });
      expect(
        (
          await fixture.database.query<{ count: number }>(
            `SELECT count(*)::integer count FROM corner_brief_revisions WHERE corner_id=$1`,
            [cornerId],
          )
        ).rows[0]?.count,
      ).toBe(expectedRevision);
    };

    // RO3b i/ii: neither unrelated rooms nor agent messages convey approval.
    await expectRefusal(unrelatedApproval.messageId);
    await expectRefusal(agentApproval.messageId);
    await expectRefusal(fix.messageId, [attachments.get(unrelated)!]);

    // Approvals and explicit files share the parent/self/opening room set.
    // Move the latest approval to the parent, then self, then back to the opener:
    // only the FIRST revision determines the extra room.
    for (const sourceRoomId of [ROOM, cornerId, corner]) {
      const approval = sourceRoomId === corner ? fix : await turnIn(sourceRoomId);
      const accepted = await revise(approval.messageId, [attachments.get(sourceRoomId)!]);
      expect(accepted.status).toBe(200);
      expectedRevision += 1;
      expect(await accepted.json()).toMatchObject({
        revision: expectedRevision,
        sourceRoomId,
        approval: {
          sourceMessageId: approval.messageId,
          text: '@bee sweep the feedback',
          approvedBy: HUMAN,
        },
        attachments: [attachments.get(sourceRoomId)!],
      });
    }

    // A corner cannot be left independently. Parent departure revokes the entire surface.
    await fixture.database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[ROOM,AGENT]);
    expect((await daemonCall('listCornerBriefRevisions',{ cornerId })).status).toBe(403);
    await fixture.database.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[ROOM,AGENT]);
    const stored = await revise(fix.messageId);
    expect(stored.status).toBe(200);
    expectedRevision += 1;
    expect(await stored.json()).toMatchObject({
      sourceRoomId: corner,
      approval: { sourceMessageId: fix.messageId, text: '@bee sweep the feedback', approvedBy: HUMAN },
    });
    const parentApproval = await turnIn(ROOM);
    const parentRevision = await revise(parentApproval.messageId, [attachments.get(ROOM)!]);
    expect(parentRevision.status).toBe(200);
    expectedRevision += 1;
    console.info(
      'RO3a: authenticated sibling revision 2 quotes opening approval; parent/self/opening attachments accepted. RO3b: unrelated and agent-authored approvals/files refused; parent departure revokes corner reads.',
    );
  });


  it('sets, validates, resolves, self-omits, and clears a Room reviewer', async () => {
    const reviewerId = '9'.repeat(64);
    const outsideId = '8'.repeat(64);
    const cornerId = '44444444-4444-4444-8444-444444444444';
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'agent','Echo','echo'),($2,'agent','Outside','outside')`,
      [reviewerId, outsideId],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
      reviewerId,
      outsideId,
      HUMAN,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, reviewerId, ROOM],
    );
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,
      [cornerId, WORKSPACE, ROOM, AGENT],
    );

    expect(
      (await fixture.operation('updateRoom', { roomId: ROOM, reviewerAgentId: reviewerId })).status,
    ).toBe(204);
    expect(
      (
        await fixture.database.query<{ reviewer_agent_id: string | null }>(
          `SELECT reviewer_agent_id FROM rooms WHERE id=$1`,
          [ROOM],
        )
      ).rows,
    ).toEqual([{ reviewer_agent_id: reviewerId }]);
    expect(
      (
        await fixture.database.query<{ room_id: string; event_subscriptions: string[] }>(
          `SELECT room_id,event_subscriptions FROM room_access
           WHERE identity_id=$1 AND room_id=ANY($2::uuid[]) ORDER BY room_id`,
          [reviewerId, [ROOM, cornerId]],
        )
      ).rows,
    ).toEqual([
      { room_id: ROOM, event_subscriptions: ['check-passed'] },
      { room_id: cornerId, event_subscriptions: ['check-passed'] },
    ]);
    expect(
      ((await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView).room.reviewerAgentId,
    ).toBe(reviewerId);

    expect(
      await (
        await fixture.daemonOperation('getAgentConfiguration', { agentId: AGENT, roomId: cornerId })
      ).json(),
    ).toEqual(expect.objectContaining({ reviewerHandle: 'echo' }));

    expect((await fixture.operation('updateRoom', { roomId: ROOM, reviewerAgentId: HUMAN })).status).toBe(
      400,
    );
    expect(
      (await fixture.operation('updateRoom', { roomId: ROOM, reviewerAgentId: outsideId })).status,
    ).toBe(400);

    expect((await fixture.operation('updateRoom', { roomId: ROOM, reviewerAgentId: AGENT })).status).toBe(
      204,
    );
    expect(
      (
        await fixture.database.query<{ event_subscriptions: string[] }>(
          `SELECT event_subscriptions FROM room_access WHERE identity_id=$1 AND room_id=$2`,
          [reviewerId, ROOM],
        )
      ).rows,
    ).toEqual([{ event_subscriptions: [] }]);
    expect(
      await (
        await fixture.daemonOperation('getAgentConfiguration', { agentId: AGENT, roomId: cornerId })
      ).json(),
    ).not.toHaveProperty('reviewerHandle');

    expect((await fixture.operation('updateRoom', { roomId: ROOM, reviewerAgentId: null })).status).toBe(
      204,
    );
    expect(
      (
        await fixture.database.query<{ reviewer_agent_id: string | null }>(
          `SELECT reviewer_agent_id FROM rooms WHERE id=$1`,
          [ROOM],
        )
      ).rows,
    ).toEqual([{ reviewer_agent_id: null }]);
    expect(
      (
        await fixture.database.query<{ event_subscriptions: string[] }>(
          `SELECT event_subscriptions FROM room_access
           WHERE identity_id=$1 AND room_id=ANY($2::uuid[]) ORDER BY room_id`,
          [AGENT, [ROOM, cornerId]],
        )
      ).rows,
    ).toEqual([{ event_subscriptions: [] }, { event_subscriptions: [] }]);
  });


  it('never resurrects the draft of a turn that has stopped working', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'settled-corner-request',
      name: 'Settled-corner',
      objective: 'A turn that has already answered',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    const turnId = 'settled-corner-turn';
    await fixture.daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: cornerId,
      requestId: turnId,
      status: 'working',
    });
    await fixture.daemonOperation('postAgentDraft', {
      agentId: AGENT,
      roomId: cornerId,
      turnId,
      text: 'half an answer',
    });
    await fixture.daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: cornerId,
      requestId: turnId,
      status: 'complete',
    });
    expect(await new PhoneService(fixture.database, fixture.origin).liveDraftSnapshot(cornerId)).toEqual([]);

    // A working turn nobody has heartbeated inside the horizon is equally
    // dead: its words must not reappear as provisional prose on every open.
    await fixture.daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: cornerId,
      requestId: turnId,
      status: 'working',
    });
    expect(await new PhoneService(fixture.database, fixture.origin).liveDraftSnapshot(cornerId)).toEqual([]);
    await fixture.database.query(
      `UPDATE agent_turns SET created_at=now()-interval '5 minutes' WHERE room_id=$1 AND request_id=$2`,
      [cornerId, turnId],
    );
    expect(await new PhoneService(fixture.database, fixture.origin).liveDraftSnapshot(cornerId)).toEqual([]);
  });


  it('fetches a search result from an authorized source Room in a corner turn', async () => {
    const corner = '22222222-2222-4222-8222-222222222223';
    const shared = '22222222-2222-4222-8222-222222222224';
    const privateRoom = '22222222-2222-4222-8222-222222222225';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
       ($1,$4,$5,'Issues triage'),($2,$4,NULL,'Shared'),($3,$4,NULL,'Private')`,
      [corner, shared, privateRoom, WORKSPACE, ROOM],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$4,'owner'),($1,$2,$5,'member'),($1,$3,$5,'member') `,
      [WORKSPACE, shared, privateRoom, HUMAN, AGENT],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES
       ('triage-root',$1,$4,'Inspect this result','message'),
       ('triage-shared',$2,$4,'Authorized result text','message'),
       ('triage-private',$3,$5,'Private result text','message')`,
      [ROOM, shared, privateRoom, HUMAN, AGENT],
    );
    await fixture.database.transaction(async (tx) => {
      const command = await createAgentCommand(tx, {
        roomId: corner,
        agentId: AGENT,
        sourceMessageId: 'triage-root',
        turnRequestId: 'triage-request',
        reason: 'fixture',
      });
      expect(command).toBeTruthy();
      await claimAgentCommand(tx, corner, AGENT, command!.id, 'triage-generation');
    });
    const call = (messageId: string) => fixture.daemonOperation('getRoomMessage', {
      roomId: corner,
      messageId,
      requestId: 'triage-request',
      generationId: 'triage-generation',
    });
    const sharedResult = await call('triage-shared');
    expect(sharedResult.status).toBe(200);
    expect(await sharedResult.json()).toMatchObject({ body: 'Authorized result text' });
    const parentResult = await call('triage-root');
    expect(parentResult.status).toBe(200);
    expect(await parentResult.json()).toMatchObject({ body: 'Inspect this result' });
    // A message that exists but is outside the authorized rooms is a refusal
    // (download_attachment's `forbidden`), distinct from a missing id.
    expect((await call('triage-private')).status).toBe(403);
    expect((await call('triage-missing')).status).toBe(404);
  });


  it('keeps the Room list readable when corner enrichment fails', async () => {
    const brokenEnrichment = {
      query: async () => {
        throw new Error('enrichment pool unavailable');
      },
      transaction: async () => {
        throw new Error('enrichment pool unavailable');
      },
    };
    const phone = new PhoneService(
      fixture.database,
      'http://placeholder',
      undefined,
      undefined,
      undefined,
      false,
      brokenEnrichment,
    );
    const chats = await phone.readChats(WORKSPACE, HUMAN);
    expect(chats?.chats.some((chat) => chat.room.id === ROOM)).toBe(true);
  });


  it("returns more than 60 of a long turn's corner work rows, oldest first", async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'long-turn-corner',
      name: 'Long-turn',
      objective: 'Long turn',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const updates = 96;
    for (let update = 1; update <= updates; update++) {
      expect(
        (
          await fixture.daemonOperation('postAgentActivity', {
            agentId: AGENT,
            roomId: cornerId,
            requestId: 'long-turn',
            activity: [{ kind: 'output', title: 'Update', text: `Update ${update}` }],
          })
        ).status,
      ).toBe(200);
    }

    const corner = (await (await fixture.request(`/v1/phone/rooms/${cornerId}`)).json()) as RoomView;
    expect(isRoomView(corner)).toBe(true);
    const texts = corner.toolRows!.map((message) => message.activity?.[0]?.text);
    expect(texts).toHaveLength(updates);
    expect(texts[0]).toBe('Update 1');
    // A phone that still keeps only the last 60 rows keeps the newest ones.
    expect(texts.slice(-60)[59]).toBe(`Update ${updates}`);
  });


  it('archives a chat-only corner without invalidating its attached media', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'chat-only-corner',
      name: 'Render-clip',
      objective: 'Generate a clip and attach it',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      cornerId,
      parentRoomId: ROOM,
      archived: false,
    });
    const mediaId = '66666666-6666-4666-8666-666666666666';
    const clipDigest = createHash('sha256').update('video-bytes').digest('hex');
    await fixture.objectStorage.putObject(
      `media/${AGENT}/${clipDigest}`,
      Buffer.from('video-bytes'),
      'video/mp4',
    );
    await fixture.database.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media',$3,'video/mp4','clip.mp4',$4,$5,'ready',now()+interval '24 hours')`,
      [mediaId, AGENT, `media/${AGENT}/${clipDigest}`, 11, clipDigest],
    );
    const attachment = {
      url: `${fixture.origin}/v1/media/${mediaId}`,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 11,
      sha256: createHash('sha256').update('video-bytes').digest('hex'),
    };
    expect(
      (await fixture.daemonOperation('postAgentAttachment', { roomId: cornerId, attachment })).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postRoomMessage', {
          roomId: cornerId,
          requestId: 'e'.repeat(64),
          text: 'Here is the clip.',
        })
      ).status,
    ).toBe(200);

    expect((await fixture.daemonOperation('archiveCorner', { cornerId })).status).toBe(200);
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      cornerId,
      parentRoomId: ROOM,
      archived: true,
      closeRequested: true,
    });
    expect(
      (
        await fixture.database.query<{
          archived: boolean;
          close_requested: boolean;
          lifecycle: Record<string, unknown>;
        }>(
          `SELECT room.archived_at IS NOT NULL archived,room.archived_at IS NOT NULL close_requested,fact.lifecycle
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`,
          [cornerId],
        )
      ).rows[0],
    ).toMatchObject({
      archived: true,
      close_requested: true,
      lifecycle: { lifecycle: 'done', checks: 'unknown' },
    });
    const media = await phoneFetch(attachment.url, {
      headers: { authorization: `Bearer ${fixture.accessToken}` },
    });
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).toString()).toBe('video-bytes');
  });


  it('authenticates an explicit corner close and routes structured stops without chat prose', async () => {
    const sourceMessageId = createHash('sha256').update('phone-close-corner').digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Open a corner for the phone close proof')`,
      [sourceMessageId, ROOM, HUMAN],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'phone-close-corner',
      name: 'Close-request',
      objective: 'Close this corner from the phone',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const outsiderToken = await fixture.phoneToken('corner-outsider');
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          roomId: cornerId,
          requestId: 'phone-close-corner',
          status: 'working',
        })
      ).status,
    ).toBe(200);

    const refused = await fixture.operation('requestCornerClose', { roomId: cornerId }, outsiderToken);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'room access denied' });
    expect(
      (
        await fixture.database.query<{ close_requested: boolean }>(
          `SELECT archived_at IS NOT NULL close_requested FROM rooms WHERE id=$1`,
          [cornerId],
        )
      ).rows[0]?.close_requested,
    ).toBe(false);

    // The parent hears the close from the rooms trigger (postgres-live.test.ts).
    expect((await fixture.operation('requestCornerClose', { roomId: cornerId })).status).toBe(204);
    expect((await fixture.operation('requestCornerClose', { roomId: cornerId })).status).toBe(204);
    expect(
      (
        await fixture.database.query<{
          archived: boolean;
          close_requested: boolean;
          lifecycle: Record<string, unknown>;
        }>(
          `SELECT room.archived_at IS NOT NULL archived,room.archived_at IS NOT NULL close_requested,fact.lifecycle
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`,
          [cornerId],
        )
      ).rows[0],
    ).toMatchObject({
      archived: true,
      close_requested: true,
      lifecycle: { lifecycle: 'done', checks: 'unknown' },
    });
    expect(
      (
        await fixture.database.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [cornerId, 'phone-close-corner', AGENT],
        )
      ).rows[0]?.status,
    ).toBe('cancelled');
    const helperCommandsResponse = await fixture.daemonOperation('getAgentCommands', { roomId: cornerId });
    expect(helperCommandsResponse.status).toBe(200);
    const helperCommands = (await helperCommandsResponse.json()) as {
      commands: Array<{ id: string; action: string; reason: string; turnRequestId: string }>
    };
    expect(helperCommands.commands).toContainEqual(
      expect.objectContaining({
        action: 'stop',
        reason: 'corner_close',
        turnRequestId: 'phone-close-corner',
      }),
    );
    expect(
      (
        await fixture.database.query<{ action: string; reason: string; state: string; agent_id: string }>(
          `SELECT action,reason,state,agent_id FROM agent_commands
           WHERE room_id=$1 ORDER BY created_at,id`,
          [cornerId],
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({ action: 'input', state: 'cancelled', agent_id: AGENT }),
      expect.objectContaining({
        action: 'stop',
        reason: 'corner_close',
        state: 'pending',
        agent_id: AGENT,
      }),
    ]);
    const stop = helperCommands.commands.find(command => command.action === 'stop')!;
    const stopInput = { roomId: cornerId, commandId: stop.id, generationId: 'closed-corner-stop' };
    expect((await fixture.daemonOperation('claimAgentCommand', stopInput)).status).toBe(200);
    expect((await fixture.daemonOperation('acknowledgeAgentCommand', stopInput)).status).toBe(200);
    expect((await fixture.database.query(`SELECT 1 FROM memberships WHERE room_id=$1`, [cornerId])).rowCount).toBe(0);
    await fixture.database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, AGENT]);
    expect((await fixture.daemonOperation('getAgentCommands', { roomId: cornerId })).status).toBe(403);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND text='Close this corner.'`,
          [cornerId],
        )
      ).rowCount,
    ).toBe(0);
    const parent = await fixture.phone.readRoom(ROOM, HUMAN);
    expect(
      parent?.messages.find((message) => message.daemonFact?.cornerId === cornerId)?.daemonFact,
    ).toMatchObject({ type: 'corner-open', cornerId });
  });


  it('creates a human corner that inherits only Room-level subscriptions from a stale parent row', async () => {
    await fixture.database.query(
      `UPDATE memberships SET event_subscriptions='["joined","grant-decided"]'::jsonb
       WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, AGENT],
    );
    await migrateMembershipSubscriptions(fixture.database);
    const created = await fixture.operation('createHumanCorner', {
      roomId: ROOM,
      title: 'Subscription-inherit-check',
    });
    expect(created.status).toBe(200);
    const { id: cornerId } = (await created.json()) as { id: string };
    const inherited = await fixture.database.query<{ event_subscriptions: string[] }>(
      `SELECT event_subscriptions FROM room_access WHERE room_id=$1 AND identity_id=$2`,
      [cornerId, AGENT],
    );
    expect(inherited.rows[0]!.event_subscriptions).toEqual(['joined']);
  });


  it('marks the message a human corner was opened from and keeps the opening historical', async () => {
    const sourceId = '7'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: ROOM,
          messageId: sourceId,
          text: 'Worth its own corner',
        })
      ).status,
    ).toBe(200);
    const created = await fixture.operation('createHumanCorner', {
      roomId: ROOM,
      title: 'quiet-amber-corner',
      sourceMessageId: sourceId,
    });
    expect(created.status).toBe(200);
    const { id: cornerId } = (await created.json()) as { id: string };

    const markerFor = async (viewer: string) =>
      (await fixture.phone.readRoom(ROOM, viewer))?.messages.find(
        (message) => message.daemonFact?.cornerId === cornerId,
      );
    const marker = await markerFor(HUMAN);
    expect(marker).toMatchObject({
      presentation: 'card',
      daemonFact: {
        type: 'corner-open',
        cornerId,
        name: 'quiet-amber-corner',
        objective: 'quiet-amber-corner',
        sourceMessageId: sourceId,
      },
    });
    // Everyone in the Room reads the same marker, not just its opener.
    expect((await markerFor(AGENT))?.daemonFact?.sourceMessageId).toBe(sourceId);
    // A person opening a scratch corner wakes nobody.
    expect(
      (
        await fixture.database.query(`SELECT 1 FROM agent_commands WHERE source_message_id=$1`, [
          marker!.id,
        ])
      ).rowCount,
    ).toBe(0);

    expect(
      (await fixture.operation('updateRoom', { roomId: cornerId, name: 'bright-river-corner' })).status,
    ).toBe(204);
    expect((await markerFor(HUMAN))?.daemonFact).toMatchObject({
      name: 'quiet-amber-corner',
      sourceMessageId: sourceId,
    });

    // A missing source leaves an unanchored opening at the current position.
    const unmarked = await fixture.operation('createHumanCorner', {
      roomId: ROOM,
      title: 'stray-corner',
      sourceMessageId: '8'.repeat(64),
    });
    expect(unmarked.status).toBe(200);
    const { id: unmarkedId } = (await unmarked.json()) as { id: string };
    expect(await markerFor(HUMAN)).toBeDefined();
    expect(
      (await fixture.phone.readRoom(ROOM, HUMAN))?.messages.some(
        (message) => message.daemonFact?.cornerId === unmarkedId,
      ),
    ).toBe(true);
  });


  it('renames a human corner through a name-only updateRoom', async () => {
    const created = await fixture.operation('createHumanCorner', {
      roomId: ROOM,
      title: 'quiet-amber-corner',
    });
    expect(created.status).toBe(200);
    const { id: cornerId } = (await created.json()) as { id: string };

    expect(
      (await fixture.operation('updateRoom', { roomId: cornerId, name: 'bright-river-corner' })).status,
    ).toBe(204);
    expect(
      (await fixture.database.query<{ name: string }>(`SELECT name FROM rooms WHERE id=$1`, [cornerId]))
        .rows[0]?.name,
    ).toBe('bright-river-corner');

    const visibility = await fixture.operation('updateRoom', {
      roomId: cornerId,
      visibility: 'invite-only',
    });
    expect(visibility.status).toBe(503);
    expect(await visibility.json()).toEqual({ error: 'room lifecycle cannot target a corner' });
  });


  it('never closes a corner from a helper remote-state heartbeat', async () => {
    const created = await fixture.operation('createHumanCorner', { roomId: ROOM, title: 'Gone-branch' });
    expect(created.status).toBe(200);
    const { id: cornerId } = (await created.json()) as { id: string };
    expect(
      (
        await fixture.daemonOperation('postCornerRemoteState', {
          cornerId,
          branch: 'fm/gone-branch',
          state: 'gone',
          checks: 'unknown',
        })
      ).status,
    ).toBe(200);
    const listed = (await (await fixture.request(`/v1/phone/rooms/${ROOM}/corners`)).json()) as {
      corners: Array<{ corner: { id: string }; state: string }>;
    };
    expect(listed.corners.find((item) => item.corner.id === cornerId)?.state).not.toBe('archived');
    expect(
      (
        await fixture.database.query<{ lifecycle: string | null }>(
          `SELECT lifecycle->>'lifecycle' lifecycle FROM corner_facts WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows,
    ).not.toEqual([{ lifecycle: 'done' }]);
  });
});
