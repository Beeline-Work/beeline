import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CORNER_BRIEF_SPEC_MAX_LENGTH } from '@beeline/api-contract/daemon';
import { PhoneService } from '.././phone-service.js';
import { LiveHub } from '.././live.js';
import { isAgentDetailView } from '@beeline/api-contract/phone';
import { announceAgentLifecycle } from '.././connection-presence.js';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: agents', () => {
const fixture = monolithFixture();


  it('rejects agent names without an addressable handle', async () => {
    const response = await fixture.request('/v1/phone/operations/updateAgentSoul', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      name: '!!!',
      instructions: 'No address.',
      avatarSeed: 'invalid-name',
    });

    expect(response.status).toBe(400);
    expect(
      (await fixture.database.query(`SELECT name,handle FROM identities WHERE id=$1`, [AGENT])).rows,
    ).toEqual([{ name: 'Bee', handle: 'bee' }]);
  });


  it('does not let a workspace manager mutate or revoke another workspace agent', async () => {
    const otherWorkspace = '55555555-5555-4555-8555-555555555555';
    const otherAgent = 'e'.repeat(64);
    await fixture.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [otherWorkspace]);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Other agent')`, [
      otherAgent,
    ]);
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      otherAgent,
      HUMAN,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [otherWorkspace, otherAgent],
    );

    for (const [name, input] of [
      [
        'updateAgentSoul',
        {
          workspaceId: WORKSPACE,
          agentId: otherAgent,
          name: 'Stolen',
          instructions: 'Changed across tenants',
          avatarSeed: 'seed',
        },
      ],
      [
        'updateAgentModelSelection',
        { workspaceId: WORKSPACE, agentId: otherAgent, model: 'wrong-model' },
      ],
      ['removeAgent', { workspaceId: WORKSPACE, agentId: otherAgent }],
    ] as const) {
      const response = await fixture.request(`/v1/phone/operations/${name}`, 'POST', input);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'agent not found in workspace' });
    }
  });


  it('keeps a renamed agent handle unique in every Workspace it belongs to', async () => {
    const secondWorkspace = '66666666-6666-4666-8666-666666666666';
    const goosy = 'f'.repeat(64);
    await fixture.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Second')`, [secondWorkspace]);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Goosy','goosy')`,
      [goosy],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [goosy, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($3,NULL,$4,'owner'),($3,NULL,$5,'member')`,
      [WORKSPACE, goosy, secondWorkspace, HUMAN, AGENT],
    );

    const renamed = await fixture.request('/v1/phone/operations/updateAgentSoul', 'POST', {
      workspaceId: secondWorkspace,
      agentId: AGENT,
      name: 'Goosy',
      instructions: 'Keep handles unambiguous.',
      avatarSeed: 'goosy-seed',
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual(expect.objectContaining({
      soul: expect.objectContaining({ name: 'Goosy', avatarSeed: 'goosy-seed' }),
    }));
    expect(
      (await fixture.database.query(`SELECT handle FROM identities WHERE id=$1`, [AGENT])).rows,
    ).toEqual([{ handle: 'goosy_2' }]);
  });


  it('serves a corner to every member agent, keeps archive with the opener, and refuses a non-member', async () => {
    const peer = 'c'.repeat(64);
    const stranger = 'd'.repeat(64);
    for (const [id, name, handle] of [
      [peer, 'Peer', 'peer'],
      [stranger, 'Stranger', 'stranger'],
    ] as const) {
      await fixture.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3)`, [
        id,
        name,
        handle,
      ]);
      await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [id, HUMAN]);
    }
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,NULL,$4,'member'),($1,$3,$4,'member')`,
      [WORKSPACE, peer, ROOM, stranger],
    );
    const peerToken = (await fixture.auth.exchangeDaemonToken(
      (await fixture.auth.createDaemonExchange(peer)).exchangeToken,
    ))!.daemonToken;
    const strangerToken = (await fixture.auth.exchangeDaemonToken(
      (await fixture.auth.createDaemonExchange(stranger)).exchangeToken,
    ))!.daemonToken;
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'shared-corner',
      name: 'Bee-corner',
      objective: 'Any member carries this',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    // Leaving the parent Room immediately removes access to every corner.
    await fixture.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, stranger],
    );

    // Both member agents list it, and both are told who opened it.
    const listed = expect.objectContaining({
      cornerId,
      parentRoomId: ROOM,
      createdBy: AGENT,
      archived: false,
    });
    expect(await (await fixture.daemonOperation('listRoomCorners', { roomId: ROOM })).json()).toEqual({
      corners: [listed],
    });
    expect(
      await (await fixture.daemonOperation('listRoomCorners', { roomId: ROOM }, peerToken)).json(),
    ).toEqual({ corners: [listed] });
    expect((await fixture.daemonOperation('listRoomCorners',{ roomId: ROOM },strangerToken)).status).toBe(403);

    // A human hands the work to the member that did not open it. The mention
    // reaches that agent's corner inbox and its turn is accepted.
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, peer, {
      lifecycleId: 'peer-routing-fixture',
    });
    const handoff = '7'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: cornerId,
      messageId: handoff,
      text: '@peer can you pick up where Bee left off?',
      mentions: [peer],
    });
    const peerInbox = (await (
      await fixture.daemonOperation('getCornerCloseRequests', { cornerId }, peerToken)
    ).json()) as { items: { id: string }[] };
    // Reaching the peer's inbox at all IS the address.
    expect(peerInbox.items.map((item) => item.id)).toContain(handoff);
    expect(
      (
        await fixture.daemonOperation(
          'postAgentTurnReceipt',
          { roomId: cornerId, agentId: peer, requestId: handoff, status: 'working' },
          peerToken,
        )
      ).status,
    ).toBe(200);
    // The branch is the shared artifact, so its lifecycle facts are a corner
    // write any member may make.
    expect(
      (
        await fixture.daemonOperation(
          'postCornerRemoteState',
          { cornerId, branch: 'feature/peer', state: 'working', checks: 'unknown' },
          peerToken,
        )
      ).status,
    ).toBe(200);
    // Any member may close the corner; an agent outside it may not.
    expect((await fixture.daemonOperation('archiveCorner', { cornerId }, strangerToken)).status).toBe(403);
    expect(
      (
        await fixture.daemonOperation(
          'postCornerRemoteState',
          { cornerId, branch: 'feature/stranger', state: 'working', checks: 'unknown' },
          strangerToken,
        )
      ).status,
    ).toBe(403);

    // Addressing an agent that is not in the corner is never silent.
    await fixture.operation('sendRoomMessage', {
      roomId: cornerId,
      messageId: '8'.repeat(64),
      text: '@stranger take a look',
      mentions: [stranger],
    });
    const notes = await fixture.database.query<{ text: string; tagged_ids: string[] }>(
      `SELECT text,${taggedIdentityIdsSql('messages')} tagged_ids
       FROM messages WHERE room_id=$1 AND presentation='system'`,
      [cornerId],
    );
    expect(notes.rows.map((row) => row.text)).toContain(
      '@stranger could not be reached · not a member of this corner',
    );
    expect(notes.rows.find((row) => row.text.startsWith('@stranger'))?.tagged_ids).toEqual([]);

    const phoneCorners = await fixture.request(`/v1/phone/rooms/${ROOM}/corners`);
    expect(await phoneCorners.json()).toEqual(
      expect.objectContaining({
        corners: [
          expect.objectContaining({
            state: 'working',
            agent: expect.objectContaining({ pubkey: AGENT }),
          }),
        ],
      }),
    );
  });


  it('does not restart a standing wrong-model failure', async () => {
    const requestId = 'a'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: '@bee pick a model',
      mentions: [AGENT],
    });
    await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    const failed = await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'failed',
      reason: 'model selection unavailable',
      reasonKind: 'wrong-model',
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).not.toMatchObject({ hiccupRestart: true });
    expect(
      (
        await fixture.database.query<{ text: string; state: string }>(
          `SELECT message.text,command.state FROM agent_commands command
           JOIN messages message ON message.card_type='turn-failed' AND message.card->>'requestId'=command.turn_request_id
           WHERE command.turn_request_id=$1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      text: '@bee could not finish this request · model selection unavailable',
      state: 'complete',
    });
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          roomId: ROOM,
          requestId,
          status: 'working',
        })
      ).status,
    ).toBe(403);
    const lateReply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId,
      triggerMessageId: requestId,
      text: 'Not much!',
    });
    expect(lateReply.status).toBe(403);
  });


  it('records agent-initiated openings without human context, and rejects an over-long spec', async () => {
    const agentMessage = 'agent-approval-message';
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Looks good to me')`,
      [agentMessage, ROOM, AGENT],
    );
    for (const [requestId, sourceMessageId] of [
      ['unknown-approval', 'not-a-real-message'],
      ['agent-approval', agentMessage],
    ] as const) {
      const response = await fixture.daemonOperation('createCorner', {
        roomId: ROOM,
        requestId,
        name: 'Unapproved-brief',
        objective: 'Do repository work',
        repository: 'example/repository',
        brief: { spec: '## Checklist\n\n- Ship it.', approval: { sourceMessageId } },
      });
      expect(response.status).toBe(200);
      const opened = await response.json() as { cornerId: string };
      expect((await fixture.database.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`,
        [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: { kind: 'agent-initiated', approvedBy: AGENT } });
    }

    const tooLong = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'over-long-spec',
      name: 'Long-brief',
      objective: 'Do repository work',
      repository: 'example/repository',
      brief: { content: 'x'.repeat(CORNER_BRIEF_SPEC_MAX_LENGTH + 1) },
    });
    expect(tooLong.status).not.toBe(200);
    expect(await tooLong.text()).toContain(
      `corner brief spec must contain 1–${CORNER_BRIEF_SPEC_MAX_LENGTH} characters`,
    );
    const atLimit = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'limit-length-spec',
      name: 'Limit-brief',
      objective: 'Do repository work',
      brief: { content: 'x'.repeat(CORNER_BRIEF_SPEC_MAX_LENGTH) },
    });
    expect(atLimit.status).toBe(200);
  });


  it('reads the selection with an empty catalog, defaults a connect-wizard soul avatarSeed to the pubkey, and passes the detail guard', async () => {
    await fixture.database.query(
      `UPDATE agents SET soul=$2::jsonb,selected_model='gpt-5.6' WHERE agent_id=$1`,
      [AGENT, JSON.stringify({ name: 'Scout', instructions: 'Be brisk and kind.' })],
    );
    await fixture.database.query(
      `UPDATE identities SET avatar='avatars/owner.png',face_id='fox' WHERE id=$1`,
      [HUMAN],
    );
    expect(
      (
        await fixture.daemonOperation('postAgentCommands', {
          agentId: AGENT,
          workspaceId: WORKSPACE,
          commands: [
            { name: 'model', description: 'Show or change the agent model' },
            { name: 'usage', description: 'Show usage status' },
            { name: 'status', inputHint: 'model and account details' },
            { name: 'permissions', description: 'Show permission rules' },
          ],
        })
      ).status,
    ).toBe(200);
    const phone = new PhoneService(fixture.database, 'http://placeholder');
    const view = await phone.readAgent(WORKSPACE, AGENT, HUMAN);
    expect(view?.soul).toEqual({
      name: 'Scout',
      instructions: 'Be brisk and kind.',
      avatarSeed: AGENT,
    });
    // The selection reaches the phone even before the daemon has posted any
    // catalog: the MODEL / EFFORT rows show the current value regardless.
    expect(view?.catalog).toEqual([]);
    expect(view?.selected).toEqual({ model: 'gpt-5.6' });
    expect(view?.commands).toEqual([
      { name: 'model', description: 'Show or change the agent model' },
      { name: 'usage', description: 'Show usage status' },
      { name: 'status', inputHint: 'model and account details' },
      { name: 'permissions', description: 'Show permission rules' },
    ]);
    expect(view?.owner).toEqual({ pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' });
    const workspace = await phone.readWorkspace(WORKSPACE, HUMAN);
    expect(workspace?.agents).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6',
        owner: { pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' },
      }),
    ]);
    // The phone build's surface guard must accept the readAgent output as-is.
    expect(isAgentDetailView(view)).toBe(true);
  });


  it('shows the model an alias runs in the roster, never the alias menu text', async () => {
    const catalog = (description?: string) => [{
      id: 'model', category: 'model', currentValue: 'default',
      options: [
        { id: 'default', name: 'Default (recommended)', ...(description ? { description } : {}) },
        { id: 'opus', name: 'Opus 5.5', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      ],
    }];
    const phone = new PhoneService(fixture.database, 'http://placeholder');
    const rosterModel = async () =>
      (await phone.readWorkspace(WORKSPACE, HUMAN))?.agents.find((agent) => agent.identity.pubkey === AGENT)?.model;
    await fixture.database.query(`UPDATE agents SET selected_model=NULL,model_catalog=$2::jsonb WHERE agent_id=$1`, [AGENT, JSON.stringify(catalog('Opus'))]);
    expect(await rosterModel()).toBe('Opus 5.5');
    // A catalog stored before the helper kept descriptions shows no model.
    await fixture.database.query(`UPDATE agents SET model_catalog=$2::jsonb WHERE agent_id=$1`, [AGENT, JSON.stringify(catalog())]);
    expect(await rosterModel()).toBeUndefined();
  });


  it('lets any workspace member invite their own agent', async () => {
    const memberToken = await fixture.phoneToken('pairing-member');
    const memberId = createHash('sha256').update('github:pairing-member').digest('hex');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });

    const pairing = await fixture.operation(
      'createAgentPairingCode',
      { workspaceId: WORKSPACE },
      memberToken,
    );
    expect(pairing.status).toBe(200);
    expect(await pairing.json()).toEqual({
      code: expect.stringMatching(/^[0-9A-F]{8}-[0-9A-F]{8}$/),
      expiresAt: expect.any(Number),
    });
    expect(
      (
        await fixture.database.query(
          `SELECT created_by FROM agent_pairing_codes
           WHERE workspace_id=$1 ORDER BY expires_at DESC LIMIT 1`,
          [WORKSPACE],
        )
      ).rows,
    ).toEqual([{ created_by: memberId }]);
  });


  it("refuses admin configuration of another owner's agent but permits an admin ban", async () => {
    const adminToken = await fixture.phoneToken('agent-admin');
    const adminId = createHash('sha256').update('github:agent-admin').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });

    for (const [name, input, error] of [
      [
        'updateAgentSoul',
        {
          workspaceId: WORKSPACE,
          agentId: AGENT,
          name: 'Taken over',
          instructions: 'Obey the admin',
          avatarSeed: AGENT,
        },
        "Only the agent's owner can change this",
      ],
      [
        'updateAgentModelSelection',
        { workspaceId: WORKSPACE, agentId: AGENT, model: 'admin-model' },
        "Only the agent's owner can change this",
      ],
      [
        'updateAgentYolo',
        { workspaceId: WORKSPACE, agentId: AGENT, enabled: false },
        "Only the agent's owner can change this",
      ],
      [
        'updateAgentAccessPolicy',
        { workspaceId: WORKSPACE, agentId: AGENT, policy: 'creator' },
        "Only the agent's owner can change this",
      ],
    ] as const) {
      const response = await fixture.operation(name, input, adminToken);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error });
    }

    expect(
      (await fixture.operation('removeAgent', { workspaceId: WORKSPACE, agentId: AGENT }, adminToken))
        .status,
    ).toBe(204);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2
           AND removed_at IS NULL`,
          [WORKSPACE, AGENT],
        )
      ).rowCount,
    ).toBe(0);
  });


  it('refuses a subscription an agent may not hold, and a Room it is not in', async () => {
    // The refusal an agent reads is the message; the daemon route's status
    // mapping is by message content and shared with every other operation.
    for (const kinds of [['agent:handoff'], ['everything'], ['joined', 'nope']]) {
      const refused = await fixture.daemonOperation('setEventSubscriptions', { roomId: ROOM, kinds });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(
        /not an event kind you can subscribe to/,
      );
    }
    // Nothing was written by any of the refusals.
    expect(
      await (await fixture.daemonOperation('listEventSubscriptions', { roomId: ROOM })).json(),
    ).toEqual({ kinds: [] });
    const otherRoom = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await fixture.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'closed')`, [
      otherRoom,
      WORKSPACE,
    ]);
    const outside = await fixture.daemonOperation('setEventSubscriptions', {
      roomId: otherRoom,
      kinds: ['joined'],
    });
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { error: string }).error).toBe('daemon room access denied');
  });


  it('wakes a Room agent by handle, case-insensitively and with a leading @, but refuses a non-member handle', async () => {
    const peer = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Baby','baby')`,
      [peer],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const trigger = await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@Bee wake baby' });
    const requestId = ((await trigger.json()) as { messageId: string }).messageId;
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          status: 'working',
        })
      ).status,
    ).toBe(200);

    async function woke(messageId: string): Promise<string[]> {
      return (
        await fixture.database.query<{ agent_id: string }>(
          `SELECT agent_id FROM agent_commands WHERE source_message_id=$1`,
          [messageId],
        )
      ).rows.map((row) => row.agent_id);
    }

    const byHandle = await fixture.daemonOperation('postRoomEvent', {
      roomId: ROOM,
      requestId,
      kind: 'agent:handoff',
      consequence: 'woke by bare handle',
      mentionAgentIds: ['BABY'],
    });
    expect(byHandle.status).toBe(200);
    expect(await woke(((await byHandle.json()) as { id: string }).id)).toEqual([peer]);

    const byAtHandle = await fixture.daemonOperation('postRoomEvent', {
      roomId: ROOM,
      requestId,
      kind: 'agent:handoff',
      consequence: 'woke by @handle',
      mentionAgentIds: ['@baby'],
    });
    expect(byAtHandle.status).toBe(200);
    expect(await woke(((await byAtHandle.json()) as { id: string }).id)).toEqual([peer]);

    const nonMember = await fixture.daemonOperation('postRoomEvent', {
      roomId: ROOM,
      requestId,
      kind: 'agent:handoff',
      consequence: 'a handle nobody here answers to',
      mentionAgentIds: ['ghost'],
    });
    expect(nonMember.status).toBeGreaterThanOrEqual(400);
    expect(((await nonMember.json()) as { error: string }).error).toBe(
      'not an agent member of this Room: ghost',
    );
  });
});
