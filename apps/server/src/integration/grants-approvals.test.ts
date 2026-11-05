import { createAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PhoneService } from '.././phone-service.js';
import { PushDeliveryLoop } from '.././background.js';
import { isAgentDetailView, isRoomView, type RoomView } from '@beeline/api-contract/phone';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: grants-approvals', () => {
const fixture = monolithFixture();

  it.each(['parent', 'self'])(
    'keeps parent/self approval scope when the first brief is from %s',
    async (source) => {
      const create = async (title: string) =>
        ((await fixture.phone.execute('createHumanCorner', { roomId: ROOM, title }, HUMAN)) as { id: string })
          .id;
      const cornerId = await create('Unbriefed-work');
      const unrelated = await create('Other-work');
      const approvals = new Map<string, string>();
      for (const roomId of [ROOM, cornerId, unrelated]) {
        const messageId = createHash('sha256').update(roomId).digest('hex');
        await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
          messageId,
          roomId,
          HUMAN,
          'Approve this work.',
        ]);
        approvals.set(roomId, messageId);
      }
      const revise = (roomId: string, expectedRevision: number) =>
        fixture.daemonOperation('reviseCornerBrief', {
          roomId: ROOM,
          cornerId,
          expectedRevision,
          brief: {
            spec: 'Complete the approved work.',
            change: 'Record the approved scope.',
            approval: { sourceMessageId: approvals.get(roomId)! },
          },
        });
      const firstSource = source === 'parent' ? ROOM : cornerId;
      const first = await revise(firstSource, 0);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ revision: 1, sourceRoomId: firstSource });
      const secondSource = source === 'parent' ? cornerId : ROOM;
      const second = await revise(secondSource, 1);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ revision: 2, sourceRoomId: secondSource });
      const refused = await revise(unrelated, 2);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: "brief.approval.sourceMessageId must cite a human message from a current Room member or an active order from this corner's commander; use the delivered order ID or its forwarded root human message ID",
      });
      expect(
        (
          await fixture.database.query<{ count: number }>(
            `SELECT count(*)::integer count FROM corner_brief_revisions WHERE corner_id=$1`,
            [cornerId],
          )
        ).rows[0]?.count,
      ).toBe(2);
    },
  );


  it('projects a member grant ledger while keeping personal grants owner-private', async () => {
    const adminToken = await fixture.phoneToken('member-grants-admin');
    const adminId = createHash('sha256').update('github:member-grants-admin').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });
    const repositoryGrant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secretGrant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await fixture.database.query(
      `INSERT INTO agent_grants(
         id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,decided_by,decided_at
       ) VALUES
         ($1,$3,$4,'repository','beeline-work/beeline','ship it',$5,$6,'approved',$5,now()),
         ($2,$3,$4,'secret','FLY_API_TOKEN','deploy it',$5,$6,'approved',$5,now())`,
      [repositoryGrant, secretGrant, AGENT, WORKSPACE, HUMAN, ROOM],
    );

    const profile = async (token: string) =>
      (await (
        await fixture.request(
          `/v1/phone/workspaces/${WORKSPACE}/members?memberId=${HUMAN}`,
          'GET',
          undefined,
          token,
        )
      ).json()) as {
        grants: Array<{ grantId: string; agent: { pubkey: string } }>;
      };

    expect((await profile(adminToken)).grants).toEqual([
      expect.objectContaining({
        grantId: repositoryGrant,
        agent: expect.objectContaining({ pubkey: AGENT }),
      }),
    ]);
    expect((await profile(fixture.accessToken)).grants.map((grant) => grant.grantId).sort()).toEqual(
      [repositoryGrant, secretGrant].sort(),
    );
  });


  it('projects exact mention and approval reasons onto Room-list rows', async () => {
    const mentionId = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@owner please review')`,
      [mentionId, ROOM, AGENT],
    );
    const readRoomItem = async () => {
      const response = await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`);
      expect(response.status).toBe(200);
      return (
        (await response.json()) as {
          chats: Array<{
            room: { id: string };
            latestMessage?: { mentionsViewer?: true };
            agentState?: string;
            attentionReason?: { kind: string; actor?: string };
          }>;
        }
      ).chats.find((item) => item.room.id === ROOM);
    };
    expect((await readRoomItem())?.latestMessage?.mentionsViewer).toBe(true);

    const permissionId = 'room-list-permission';
    await fixture.database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
       VALUES($1,$2,$3,'request','{"type":"operation.execute"}'::jsonb,'pending')`,
      [permissionId, ROOM, HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'Bee needs your approval','card','permission',$4::jsonb)`,
      ['e'.repeat(64), ROOM, AGENT, JSON.stringify({ permissionId, agent: { pubkey: AGENT } })],
    );
    expect(await readRoomItem()).toMatchObject({
      agentState: 'needs-you',
      attentionReason: { kind: 'approval', actor: 'Bee' },
    });
  });


  it('forwards a message into a human corner and starts someone else’s yolo agent without a grant', async () => {
    const bbcOwner = 'bananaman614305';
    await fixture.phoneToken(bbcOwner);
    const bbcOwnerId = createHash('sha256').update(`github:${bbcOwner}`).digest('hex');
    const bbcAgentId = 'd'.repeat(64);
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: bbcOwnerId,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: bbcOwnerId });
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','BBC','bbc')`,
      [bbcAgentId],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$2,true)`, [
      bbcAgentId,
      bbcOwnerId,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, bbcAgentId, ROOM],
    );
    const sourceId = '7'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: ROOM,
          messageId: sourceId,
          text: 'This deserves its own corner',
        })
      ).status,
    ).toBe(200);
    const opened = await fixture.operation('createHumanCorner', {
      roomId: ROOM,
      title: 'BBC-follow-up',
      sourceMessageId: sourceId,
    });
    expect(opened.status).toBe(200);
    const { id: cornerId } = (await opened.json()) as { id: string };
    const taggedId = '8'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: cornerId,
          messageId: taggedId,
          text: '@bbc answer this here',
          mentions: [bbcAgentId],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ agent_id: string; reason: string; state: string }>(
          `SELECT agent_id,reason,state FROM agent_commands WHERE source_message_id=$1`,
          [taggedId],
        )
      ).rows,
    ).toEqual([{ agent_id: bbcAgentId, reason: 'human_tag', state: 'pending' }]);
    expect(
      (await fixture.database.query(`SELECT 1 FROM agent_grants WHERE agent_id=$1`, [bbcAgentId])).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='grant-request'`,
          [cornerId],
        )
      ).rows,
    ).toEqual([]);
  });


  it('expires an ordinary tag while unresolved questions and grants keep waiting', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-owed-expiry',
      name: 'Pick-a-box',
      objective: 'Pick a box for the widget',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.settleCornerWorkPastGap(cornerId);
    const state = async () =>
      (await new PhoneService(fixture.database, fixture.origin).readCorners(ROOM, HUMAN))?.corners.find(
        (item) => item.corner.id === cornerId,
      )?.state;
    const old = "now()-interval '25 hours'";
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('expiry-tag',$1,$2,'@owner big or small?',${old})`,
      [cornerId, AGENT],
    );
    expect(await state()).toBe('idle');

    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES('expiry-question',$1,$2,'Big or small?','card','choice',$3::jsonb,${old})`,
      [
        cornerId,
        AGENT,
        JSON.stringify({ mode: 'question', status: 'open', requester: { pubkey: HUMAN } }),
      ],
    );
    expect(await state()).toBe('waiting');
    await fixture.database.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"closed"') WHERE id='expiry-question'`,
    );
    expect(await state()).toBe('idle');

    const grantId = '99999999-9999-4999-8999-999999999991';
    await fixture.database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,created_at)
       VALUES($1,$2,$3,'host','example.com','fetch docs',$2,$4,'pending',${old})`,
      [grantId, AGENT, WORKSPACE, cornerId],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES('expiry-grant',$1,$2,'Allow Bee to reach example.com','card','grant-request',$3::jsonb,${old})`,
      [cornerId, AGENT, JSON.stringify({ grants: [{ grantId, kind: 'host', target: 'example.com' }] })],
    );
    expect(await state()).toBe('waiting');
    await fixture.database.query(`UPDATE agent_grants SET status='approved' WHERE id=$1`, [grantId]);
    expect(await state()).toBe('idle');

    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES('expiry-blocked',$1,$2,'Agent could not be reached','system','corner-agent-unreachable',$3::jsonb,${old})`,
      [cornerId, AGENT, JSON.stringify({ recipientIds: [HUMAN], status: 'open' })],
    );
    expect(await state()).toBe('idle');
  });


  it('forces yolo off in public workspaces without overwriting the stored preference', async () => {
    await fixture.database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [AGENT]);
    expect(
      await (
        await fixture.daemonOperation('getAgentConfiguration', { agentId: AGENT, roomId: ROOM })
      ).json(),
    ).toEqual(expect.objectContaining({ yoloMode: true }));

    expect(
      (
        await fixture.operation('updateWorkspace', {
          workspaceId: WORKSPACE,
          visibility: 'public',
        })
      ).status,
    ).toBe(204);
    const publicConfiguration = await fixture.daemonOperation('getAgentConfiguration', {
      agentId: AGENT,
      roomId: ROOM,
    });
    expect(await publicConfiguration.json()).toEqual(expect.objectContaining({ yoloMode: false }));
    expect(
      await (await fixture.daemonOperation('getAgentConfiguration', { agentId: AGENT })).json(),
    ).toEqual(expect.objectContaining({ yoloMode: true }));
    const publicView = (await (
      await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as { yolo: unknown };
    expect(publicView.yolo).toEqual(
      expect.objectContaining({ enabled: false, forcedOff: true, canChange: true }),
    );
    expect(
      (await fixture.database.query(`SELECT yolo_mode FROM agents WHERE agent_id=$1`, [AGENT])).rows,
    ).toEqual([{ yolo_mode: true }]);
    expect(
      await (
        await fixture.daemonOperation('requestAgentGrant', {
          roomId: ROOM,
          kind: 'command',
          target: 'git status',
          reason: 'inspect the checkout',
        })
      ).json(),
    ).toEqual(expect.objectContaining({ status: 'approved', auto: true }));

    const rejected = await fixture.operation('updateAgentYolo', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      enabled: true,
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({
      error: 'yolo cannot be enabled in a public workspace',
    });

    await fixture.operation('updateWorkspace', { workspaceId: WORKSPACE, visibility: 'invite-only' });
    expect(
      await (
        await fixture.daemonOperation('getAgentConfiguration', { agentId: AGENT, roomId: ROOM })
      ).json(),
    ).toEqual(expect.objectContaining({ yoloMode: true }));
  });


  it.each([undefined, '', '   ', 'x'.repeat(241)])('rejects a grant without a valid purpose (%s)', async (purpose) => {
    const result = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, kind: 'command', target: 'git status', reason: 'inspect', purpose,
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('grant purpose is required') }));
  });


  it('stores the purpose and declared facts with the approval request', async () => {
    await fixture.database.query('UPDATE agents SET machine_name=$2 WHERE agent_id=$1', [AGENT, 'squire']);
    const result = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, kind: 'shared_asset', target: 'package-cache', reason: 'repair corrupt cache',
      purpose: 'Use a private cache so dependency installation can finish', touches: 'Package cache', capabilities: 'Isolate this cache',
    });
    expect(result.status).toBe(200);
    const { grantId, messageId, status } = await result.json();
    expect(status).toBe('pending');
    const facts = { purpose: 'Use a private cache so dependency installation can finish', touches: 'Package cache', capabilities: 'Isolate this cache' };
    expect((await fixture.database.query('SELECT purpose,touches,capabilities FROM agent_grants WHERE id=$1', [grantId])).rows).toEqual([facts]);
    const view = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(view)).toBe(true);
    expect(view.messages.find(message => message.id === messageId)?.grantRequest?.grants[0]).toMatchObject({ ...facts, machine: 'squire', status: 'pending' });
    expect((await fixture.operation('decideAgentGrant', { grantId, decision: 'always' })).status).toBe(200);
    const decided = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(decided.messages.find(message => message.id === messageId)?.grantRequest?.grants[0]).toMatchObject({ ...facts, status: 'approved', decidedAt: expect.any(Number) });
  });


  it('gates the agent yolo switch to its owner and posts one system line per Room', async () => {
    const adminToken = await fixture.phoneToken('admin');
    const adminId = createHash('sha256').update('github:admin').digest('hex');
    const memberToken = await fixture.phoneToken('member');
    const memberId = createHash('sha256').update('github:member').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    // A second live Room the agent sits in, plus an archived one it must not touch.
    const second = (await (
      await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'second' })
    ).json()) as { id: string };
    await fixture.operation('addRoomMember', { roomId: second.id, memberId: AGENT });
    const archived = (await (
      await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'archived' })
    ).json()) as { id: string };
    await fixture.operation('addRoomMember', { roomId: archived.id, memberId: AGENT });
    await fixture.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [archived.id]);
    // A DM between the admin and the agent: the only Room where a plain line
    // authored by the owner would push to the admin's device.
    const dm = (await (
      await fixture.operation(
        'resolveDirectMessage',
        { workspaceId: WORKSPACE, participantId: AGENT },
        adminToken,
      )
    ).json()) as { id: string };
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
       VALUES('yolo-admin-device',$1,'android','physical',now()-interval '1 hour')`,
      [adminId],
    );
    await fixture.database.query(
      `INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 hour')
       ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at`,
    );
    // New agents default to yolo on; this test exercises the OFF-to-ON toggle,
    // so it starts from an agent an owner had explicitly turned off.
    await fixture.database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);

    const before = (await (
      await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      yolo: unknown;
    };
    expect(before.yolo).toEqual({ enabled: false, canChange: true });
    const memberView = (await (
      await fixture.request(
        `/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`,
        'GET',
        undefined,
        memberToken,
      )
    ).json()) as { yolo: unknown };
    expect(memberView.yolo).toEqual({ enabled: false, canChange: false });

    // A plain member is refused with the plain message and nothing changes.
    const refused = await fixture.operation(
      'updateAgentYolo',
      { workspaceId: WORKSPACE, agentId: AGENT, enabled: true },
      memberToken,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the agent's owner can change this",
    });
    expect(
      (await fixture.database.query(`SELECT yolo_mode FROM agents WHERE agent_id=$1`, [AGENT])).rows,
    ).toEqual([{ yolo_mode: false }]);

    // The owner (the identity that connected the agent) flips it on.
    const owner = await fixture.operation('updateAgentYolo', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      enabled: true,
    });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual(expect.objectContaining({
      yolo: expect.objectContaining({ enabled: true }),
    }));
    const on = (await (
      await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      yolo: { enabled: boolean; setBy?: { name: string }; setAt?: number; canChange: boolean };
    };
    expect(on.yolo).toEqual({
      enabled: true,
      setBy: { name: 'Owner' },
      setAt: expect.any(Number),
      canChange: true,
    });
    expect(
      isAgentDetailView(
        await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)).json(),
      ),
    ).toBe(true);
    const onLines = await fixture.database.query<{
      room_id: string;
      text: string;
      presentation: string;
      tagged_ids: string[];
      author_id: string;
    }>(
      `SELECT room_id,text,presentation,${taggedIdentityIdsSql('messages')} tagged_ids,author_id
       FROM messages WHERE card_type='agent-yolo' ORDER BY created_at`,
    );
    expect(onLines.rows.map((row) => row.room_id).sort()).toEqual([ROOM, second.id, dm.id].sort());
    for (const row of onLines.rows) {
      expect(row).toEqual(
        expect.objectContaining({
          text: '@owner turned yolo on for @bee · grant requests are now approved automatically',
          presentation: 'system',
          tagged_ids: [],
          author_id: HUMAN,
        }),
      );
    }
    // The line reads as a system notice on the Room surface.
    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ text: string; presentation: string }>;
    };
    expect(room.messages).toContainEqual(
      expect.objectContaining({
        text: '@owner turned yolo on for @bee · grant requests are now approved automatically',
        presentation: 'system',
      }),
    );
    // Repeating the same state is a no-op: no second line.
    expect(
      (
        await fixture.operation('updateAgentYolo', {
          workspaceId: WORKSPACE,
          agentId: AGENT,
          enabled: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query(
          `SELECT count(*)::int count FROM messages WHERE card_type='agent-yolo'`,
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    // The yolo line never pushes, even in the DM where a plain owner line would.
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(fixture.database, { send }).runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();

    // The daemon-side agent view carries the flag.
    const configuration = await fixture.daemonOperation('getAgentConfiguration', {
      agentId: AGENT,
      roomId: ROOM,
    });
    expect(await configuration.json()).toEqual(expect.objectContaining({ yoloMode: true }));

    // A workspace admin who does not own the agent cannot flip it off.
    const admin = await fixture.operation(
      'updateAgentYolo',
      { workspaceId: WORKSPACE, agentId: AGENT, enabled: false },
      adminToken,
    );
    expect(admin.status).toBe(403);
    expect(await admin.json()).toEqual({ error: "Only the agent's owner can change this" });
    const adminView = (await (
      await fixture.request(
        `/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`,
        'GET',
        undefined,
        adminToken,
      )
    ).json()) as { yolo: { enabled: boolean; canChange: boolean } };
    expect(adminView.yolo).toEqual(expect.objectContaining({ enabled: true, canChange: false }));
    expect(
      (
        await fixture.database.query(
          `SELECT text FROM messages WHERE card_type='agent-yolo' AND room_id=$1 ORDER BY created_at`,
          [ROOM],
        )
      ).rows.map((row) => row.text),
    ).toEqual(['@owner turned yolo on for @bee · grant requests are now approved automatically']);
  });

  it.each([
    ['repository', false],
    ['repository', true],
    ['scratch', false],
    ['scratch', true],
  ] as const)(
    'opens a fresh %s corner for a non-owner requester without a grant (yolo=%s)',
    async (cornerKind, yolo) => {
      await fixture.database.query(`UPDATE agents SET yolo_mode=$2 WHERE agent_id=$1`, [AGENT, yolo]);
      const token = await fixture.phoneToken(`corner-requester-${cornerKind}-${yolo}`);
      const member = createHash('sha256')
        .update(`github:corner-requester-${cornerKind}-${yolo}`)
        .digest('hex');
      await fixture.operation('addWorkspaceMember', {
        workspaceId: WORKSPACE,
        memberId: member,
        role: 'member',
      });
      await fixture.operation('addRoomMember', { roomId: ROOM, memberId: member });
      const source = (await (
        await fixture.operation(
          'sendRoomMessage',
          { roomId: ROOM, text: '@bee open this corner', mentions: [AGENT] },
          token,
        )
      ).json()) as { messageId: string };
      const opened = await fixture.daemonOperation('createCorner', {
        roomId: ROOM,
        requestId: source.messageId,
        name: `${cornerKind}-work`,
        objective: 'Answer this request',
        ...(cornerKind === 'scratch' ? {} : { repository: 'owner/widgets', targetBranch: 'main' }),
        ...(cornerKind === 'scratch'
          ? {}
          : {
              brief: {
                spec: 'Answer this request',
                approval: { sourceMessageId: source.messageId },
              },
            }),
      });
      expect(opened.status).toBe(200);
      const { cornerId } = (await opened.json()) as { cornerId: string };
      expect(
        (
          await fixture.database.query(
            `SELECT 1 FROM room_access WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
            [cornerId, member],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await fixture.database.query(
            `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='corner_objective'`,
            [cornerId, AGENT],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await fixture.database.query(`SELECT 1 FROM agent_grants WHERE room_id IN ($1,$2)`, [
            ROOM,
            cornerId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await fixture.database.query(
            `SELECT 1 FROM messages WHERE room_id IN ($1,$2) AND card_type IN ('grant-request','grant-auto')`,
            [ROOM, cornerId],
          )
        ).rows,
      ).toEqual([]);
    },
  );


  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'lets an agent use its own owner resource (yolo=%s ownerRequester=%s)',
    async (yolo, ownerRequester) => {
      await fixture.database.query(`UPDATE agents SET yolo_mode=$2 WHERE agent_id=$1`, [AGENT, yolo]);
      const token = await fixture.phoneToken('matrix-member');
      const member = createHash('sha256').update('github:matrix-member').digest('hex');
      await fixture.operation('addWorkspaceMember', {
        workspaceId: WORKSPACE,
        memberId: member,
        role: 'admin',
      });
      await fixture.operation('addRoomMember', { roomId: ROOM, memberId: member });
      const source = (await (
        await fixture.operation(
          'sendRoomMessage',
          {
            roomId: ROOM,
            text: '@bee perform this task',
            mentions: [AGENT],
          },
          ownerRequester ? fixture.accessToken : token,
        )
      ).json()) as { messageId: string };
      const context = { roomId: ROOM, requestId: source.messageId };
      const resource = await (
        await fixture.daemonOperation('authorizeResourceCall', { ...context, target: 'paid-api' })
      ).json();
      expect(resource.allowed).toBe(true);
      expect(
        (
          await (
            await fixture.daemonOperation('authorizeResourceCall', {
              ...context,
              target: 'openaiDeveloperDocs',
            })
          ).json()
        ).allowed,
      ).toBe(true);
      expect(
        (
          await fixture.database.query(
            `SELECT id FROM agent_grants WHERE target IN ('paid-api','openaiDeveloperDocs')`,
          )
        ).rows,
      ).toEqual([]);
      expect((await (await fixture.daemonOperation('authorizeSquireCall', context)).json()).allowed).toBe(
        true,
      );
      expect(
        (await fixture.database.query(`SELECT id FROM agent_grants WHERE kind='budget'`)).rows,
      ).toEqual([]);
    },
  );


  it('lets an agent use its owner tool when another person’s agent started the turn', async () => {
    const OTHER_AGENT = 'e'.repeat(64);
    const OTHER_OWNER = 'f'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other Owner','other-owner'),($2,'agent','Other Agent','other-agent')`,
      [OTHER_OWNER, OTHER_AGENT],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$2,false)`, [
      OTHER_AGENT,
      OTHER_OWNER,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, OTHER_AGENT, ROOM],
    );
    const sourceId = createHash('sha256').update('other-agent-root-resource').digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'@bee use your docs','message')`,
      [sourceId, ROOM, OTHER_AGENT],
    );
    await createAgentCommand(fixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: sourceId,
      reason: 'agent_mention',
    });
    await fixture.database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);
    const result = (await (
      await fixture.daemonOperation('authorizeResourceCall', {
        roomId: ROOM,
        requestId: sourceId,
        target: 'openaiDeveloperDocs',
      })
    ).json()) as { allowed: boolean };
    expect(result.allowed).toBe(true);
    expect(
      (await fixture.database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows,
    ).toEqual([]);
  });


  it('GRANT-CURRENT-1: successive command requests paint and resume only the current grant', async () => {
    const source = await (await fixture.operation('sendRoomMessage', {
      roomId: ROOM, text: '@bee run the checks', mentions: [AGENT],
    })).json() as { messageId: string };
    const ask = async (reason: string) => {
      const response = await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM, requestId: source.messageId, kind: 'command',
        target: 'python3 check.py', reason,
        script: { path: 'check.py', contents: 'print(1)', bytes: 8,
          sha256: createHash('sha256').update('print(1)').digest('hex') },
      });
      expect(response.status).toBe(200);
      return await response.json() as { grantId: string; messageId: string };
    };
    const first = await ask('First attempt');
    const current = await ask('Current attempt');
    expect(current.grantId).not.toBe(first.grantId);
    const cardRoom = (await fixture.database.query<{ room_id: string }>(
      'SELECT room_id FROM messages WHERE id=$1', [current.messageId],
    )).rows[0]!.room_id;
    const view = await (await fixture.request(`/v1/phone/rooms/${cardRoom}`, 'GET', undefined, fixture.accessToken)).json() as RoomView;
    const card = view.messages.find(row => row.id === current.messageId)!.grantRequest!;
    expect(card.grants.map(grant => grant.grantId)).toEqual([current.grantId]);
    const tray = await (await fixture.operation('readNeedsYou', { workspaceId: WORKSPACE })).json();
    expect(JSON.stringify(tray)).toContain(current.grantId);
    expect(JSON.stringify(tray)).not.toContain(first.grantId);
    const inspected = await (await fixture.daemonOperation('listAgentGrantRequests', { roomId: ROOM })).json();
    expect(inspected.grants.map((grant: { grantId: string }) => grant.grantId)).toEqual([current.grantId]);
    const stale = await fixture.operation('decideAgentGrant', { grantId: first.grantId, decision: 'once' });
    expect(stale.status).toBe(409);
    expect((await fixture.database.query(`SELECT status FROM agent_grants WHERE id=$1`, [first.grantId])).rows)
      .toEqual([{ status: 'pending' }]);
    expect((await fixture.database.query(`SELECT 1 FROM messages WHERE card_type='grant-decision'`)).rows).toEqual([]);
    expect((await fixture.operation('decideAgentGrant', { grantId: current.grantId, decision: 'once' })).status).toBe(200);
    const wake = (await fixture.database.query<{ card: { grantId: string }; action: string }>(
      `SELECT message.card,command.action FROM messages message JOIN agent_commands command
       ON command.source_message_id=message.id WHERE message.card_type='grant-decision'`,
    )).rows;
    expect(wake).toEqual([{ card: { grantId: current.grantId, status: 'once' }, action: 'resume' }]);
  });
});
