import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { cornerObjectiveSql } from '.././corner-objective.js';
import { cornerCommissionerSql, cornerKindSql } from '.././corner-opening.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from '.././postgres-live.js';
import { PhoneService } from '.././phone-service.js';
import { LiveHub } from '.././live.js';
import { PushDeliveryLoop } from '.././background.js';
import { isCommunityInviteToken, isRoomView, type RoomView } from '@beeline/api-contract/phone';
import { monolithFixture, taggedBy, HUMAN, AGENT, WORKSPACE, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: membership', () => {
const fixture = monolithFixture();


  it('requires a fresh invite after removing a person who joined through a spent link', async () => {
    const bobToken = await fixture.phoneToken('bob');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    const workspaceId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddde';
    await fixture.operation('createWorkspace', { workspaceId, name: 'Fresh invites' });
    const first = (await (await fixture.operation('createInvite', { workspaceId })).json()) as {
      token: string;
    };
    expect((await fixture.operation('redeemInvite', { token: first.token }, bobToken)).status).toBe(200);
    expect((await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: bobId })).status)
      .toBe(204);
    expect((await fixture.operation('redeemInvite', { token: first.token }, bobToken)).status).toBe(404);
    expect((await fixture.operation('resolveInvite', { token: first.token }, bobToken)).status).toBe(404);
    expect((await phoneFetch(`${fixture.origin}/v1/public/invite-preview?token=${first.token}`)).status)
      .toBe(404);
    const fresh = (await (await fixture.operation('createInvite', { workspaceId })).json()) as {
      token: string;
    };
    expect((await fixture.operation('redeemInvite', { token: fresh.token }, bobToken)).status).toBe(200);
    const membership = await fixture.database.query<{ removed_at: Date | null }>(
      `SELECT removed_at FROM memberships WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,
      [workspaceId, bobId],
    );
    expect(membership.rows).toEqual([{ removed_at: null }]);
  });


  it('removes an owner-deleted workspace for an online member and on the next offline load', async () => {
    const memberToken = await fixture.phoneToken('alice');
    const memberId = createHash('sha256').update('github:alice').digest('hex');
    const outsiderToken = await fixture.phoneToken('bob');
    const offlineToken = await fixture.phoneToken('offline');
    const offlineId = createHash('sha256').update('github:offline').digest('hex');
    const workspaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await fixture.operation('createWorkspace', { workspaceId, name: 'Beeline Welcome' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId, role: 'member' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: offlineId, role: 'member' });
    const before = await (await fixture.request('/v1/phone/workspaces', 'GET', undefined, memberToken)).json();
    expect(before.workspaces.map((workspace: { id: string }) => workspace.id)).toContain(workspaceId);

    let unlisten: (() => Promise<void>) | undefined;
    const pgClient = new EventEmitter() as EventEmitter & LivePgClient;
    pgClient.connect = async () => undefined;
    pgClient.query = async () => {
      unlisten = await fixture.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) => {
        pgClient.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload });
      });
    };
    pgClient.end = async () => { await unlisten?.(); };
    const listener = new PostgresLiveListener(fixture.database, fixture.live, () => pgClient);
    const sockets = [memberToken, outsiderToken].map((token) =>
      new WebSocket(`${fixture.origin.replace('http', 'ws')}/v1/phone/live`, [`bearer.${token}`]));
    const opened = Promise.all(sockets.map((socket) => new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    })));
    try {
      void listener.run();
      await vi.waitFor(() => expect(listener.projectionHealth().connected).toBe(true));
      await opened;
      const outsiderEvents: unknown[] = [];
      sockets[1]!.on('message', (raw) => outsiderEvents.push(JSON.parse(raw.toString())));
      // The workspace rail has no Room subscriptions. Deletion must still
      // reach it after the membership rows have cascaded away.
      const invalidated = next(sockets[0]!, 'invalidate');
      expect((await fixture.operation('deleteWorkspace', { workspaceId })).status).toBe(204);
      expect(await invalidated).toMatchObject({ roomId: '', reason: 'postgres:memberships' });
      const after = await (await fixture.request('/v1/phone/workspaces', 'GET', undefined, memberToken)).json();
      expect(after.workspaces).toEqual([]);
      expect(after.deletedNotices).toEqual([{ workspaceId, workspaceName: 'Beeline Welcome' }]);
      const nextLoad = await (await fixture.request('/v1/phone/workspaces', 'GET', undefined, offlineToken)).json();
      expect(nextLoad.workspaces).toEqual([]);
      expect((await fixture.request(`/v1/phone/workspaces/${workspaceId}/chats`, 'GET', undefined, memberToken)).status).toBe(404);
      expect(outsiderEvents).toEqual([]);
      console.log('Reproduction workspace-removal: owner deleted Beeline Welcome; member received live removal, next load has no workspace, deleted rooms refused, outsider received nothing');
    } finally {
      sockets.forEach((socket) => socket.terminate());
      await listener.stop();
    }
  });


  it('lets only the Workspace owner delete it, as a real cascade that leaves no orphan rows and retires bound helpers', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    const bobToken = await fixture.phoneToken('bob');
    const workspaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    // A fresh agent whose ONLY membership is in this doomed Workspace, so the
    // daemon-token revocation below is unambiguous — AGENT from the shared
    // fixture also belongs to WORKSPACE and would not qualify.
    const soleAgentId = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Wasp','wasp')`,
      [soleAgentId],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      soleAgentId,
      HUMAN,
    ]);
    await fixture.operation('createWorkspace', { workspaceId, name: 'Doomed' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'admin' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: bobId, role: 'member' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: soleAgentId, role: 'member' });
    const room = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'shared' })
    ).json()) as { id: string };
    await fixture.operation('addRoomMember', { roomId: room.id, memberId: aliceId });
    await fixture.operation('sendRoomMessage', { roomId: room.id, text: 'last words' });
    await fixture.operation('createInvite', { workspaceId });

    const agentExchange = await fixture.auth.createDaemonExchange(soleAgentId);
    const agentDaemonToken = (await fixture.auth.exchangeDaemonToken(agentExchange.exchangeToken))!
      .daemonToken;

    // Admins and members cannot delete the Workspace, only its owner can.
    expect((await fixture.operation('deleteWorkspace', { workspaceId }, aliceToken)).status).toBe(403);
    expect((await fixture.operation('deleteWorkspace', { workspaceId }, bobToken)).status).toBe(403);

    const deleted = await fixture.operation('deleteWorkspace', { workspaceId });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    // A real cascade: nothing keyed to this Workspace or its Rooms survives.
    expect(
      (await fixture.database.query(`SELECT 1 FROM workspaces WHERE id=$1`, [workspaceId])).rowCount,
    ).toBe(0);
    expect(
      (await fixture.database.query(`SELECT 1 FROM rooms WHERE workspace_id=$1`, [workspaceId])).rowCount,
    ).toBe(0);
    expect(
      (await fixture.database.query(`SELECT 1 FROM memberships WHERE workspace_id=$1`, [workspaceId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await fixture.database.query(`SELECT 1 FROM invites WHERE workspace_id=$1`, [workspaceId])).rowCount,
    ).toBe(0);
    expect(
      (await fixture.database.query(`SELECT 1 FROM messages WHERE room_id=$1`, [room.id])).rowCount,
    ).toBe(0);

    // Audited: who deleted it and when, surviving the workspace row itself.
    expect(
      (
        await fixture.database.query<{ deleted_by: string; workspace_name: string }>(
          `SELECT deleted_by,workspace_name FROM workspace_deletions WHERE workspace_id=$1`,
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ deleted_by: HUMAN, workspace_name: 'Doomed' });

    // Idempotent: a doubled/retried call by the very same owner resolves
    // quietly even though its own owner membership row is now gone too.
    const retried = await fixture.operation('deleteWorkspace', { workspaceId });
    expect(retried.status).toBe(204);

    // Other members learn about it on their next sync.
    const aliceWorkspaces = (await (
      await fixture.request('/v1/phone/workspaces', 'GET', undefined, aliceToken)
    ).json()) as { deletedNotices?: Array<{ workspaceId: string; workspaceName: string }> };
    expect(aliceWorkspaces.deletedNotices).toEqual([{ workspaceId, workspaceName: 'Doomed' }]);
    // Consumed once: a second read carries no notice.
    const aliceWorkspacesAgain = (await (
      await fixture.request('/v1/phone/workspaces', 'GET', undefined, aliceToken)
    ).json()) as { deletedNotices?: unknown };
    expect(aliceWorkspacesAgain.deletedNotices).toBeUndefined();

    // The bound helper's daemon token answers with the one settled fact it
    // may retire itself on, instead of a 401 it would retry against forever.
    const refused = await fixture.daemonOperation(
      'getDaemonBootstrap',
      { agentId: soleAgentId },
      agentDaemonToken,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'agent_removed' });
  });


  it('projects a human DM peer online, then falls back to their newest activity', async () => {
    const peerId = createHash('sha256').update('github:dm-peer').digest('hex');
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject)
       VALUES($1,'human','Ada','ada','dm-peer')`,
      [peerId],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, peerId],
    );
    const dm = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: peerId })
    ).json()) as { id: string };
    const live = new LiveHub();
    live.humanConnected(peerId, Date.UTC(2026, 8, 12, 16));
    const presencePhone = new PhoneService(
      fixture.database,
      'http://placeholder',
      undefined,
      undefined,
      live,
    );
    expect(
      (await presencePhone.readChats(WORKSPACE, HUMAN))?.chats.find(
        (chat) => chat.room.id === dm.id,
      )?.directMessage?.presence,
    ).toEqual({
      status: 'online',
      observedAt: Math.floor(Date.UTC(2026, 8, 12, 16) / 1_000),
    });

    live.humanDisconnected(peerId, Date.UTC(2026, 8, 12, 17));
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,'hello','2026-09-10T12:00:00Z')`,
      ['human-presence-message', dm.id, peerId],
    );
    await fixture.database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
       VALUES($1,$2,'2026-09-10T12:00:00Z',$3,'2026-09-11T12:00:00Z')`,
      [dm.id, peerId, 'human-presence-message'],
    );
    expect(
      (
        await new PhoneService(fixture.database, 'http://placeholder').readChats(WORKSPACE, HUMAN)
      )?.chats.find((chat) => chat.room.id === dm.id)?.directMessage?.presence,
    ).toEqual({
      status: 'offline',
      observedAt: Math.floor(Date.parse('2026-09-11T12:00:00Z') / 1_000),
    });
  });


  it('does not let a Workspace manager delete a message in a Room they cannot access', async () => {
    const firstMember = '1'.repeat(64);
    const secondMember = '2'.repeat(64);
    const directRoomId = '33333333-3333-4333-8333-333333333333';
    const messageId = '3'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','First','first'),($2,'human','Second','second')`,
      [firstMember, secondMember],
    );
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,name,direct_participants)
       VALUES($1,$2,'private',jsonb_build_array($3::text,$4::text))`,
      [directRoomId, WORKSPACE, firstMember, secondMember],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$2,'member'),($1,NULL,$3,'member'),
        ($1,$4,$2,'member'),($1,$4,$3,'member')`,
      [WORKSPACE, firstMember, secondMember, directRoomId],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'private message')`,
      [messageId, directRoomId, firstMember],
    );

    expect(await fixture.phone.readRoom(directRoomId, HUMAN)).toBeNull();
    await expect(
      fixture.phone.execute('deleteRoomMessage', { roomId: directRoomId, messageId }, HUMAN),
    ).rejects.toThrow('message is not available for deletion');
    expect((await fixture.phone.readRoom(directRoomId, firstMember))?.messages[0]?.text).toBe(
      'private message',
    );
  });


  it('keeps private bookmarks in the Workspace index and projects their message marker', async () => {
    const messageId = '8'.repeat(64);
    expect(
      (await fixture.operation('sendRoomMessage', { roomId: ROOM, messageId, text: 'Return here' })).status,
    ).toBe(200);
    expect(
      (
        await fixture.operation('setMessageBookmark', {
          roomId: ROOM,
          messageId,
          bookmarked: true,
        })
      ).status,
    ).toBe(200);

    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(room.messages.find((message) => message.id === messageId)?.bookmarked).toBe(true);
    const listed = (await (
      await fixture.operation('listMessageBookmarks', { workspaceId: WORKSPACE })
    ).json()) as {
      bookmarks: Array<{ messageId: string; roomId: string; text?: string; available: boolean }>;
    };
    expect(listed.bookmarks).toContainEqual(
      expect.objectContaining({ messageId, roomId: ROOM, text: 'Return here', available: true }),
    );

    expect(
      (
        await fixture.operation('setMessageBookmark', {
          roomId: ROOM,
          messageId,
          bookmarked: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await fixture.operation('listMessageBookmarks', { workspaceId: WORKSPACE })).json()) as {
        bookmarks: unknown[];
      },
    ).toEqual({ bookmarks: [] });
  });


  it('silently records a Workspace arrival and auto-joins public Rooms', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const workspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await fixture.operation('createWorkspace', { workspaceId, name: 'Tubing Crew' });
    const room = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'planning' })
    ).json()) as { id: string };
    await fixture.operation('registerPushDevice', {
      token: 'owner-explicit-add-device-token-1234567890',
      platform: 'android',
      environment: 'physical',
    });
    // Member lifecycle rides the Full level.
    await fixture.database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [HUMAN]);
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    expect(await loop.runOnce()).toBe(0);

    expect(
      await (
        await fixture.operation('addWorkspaceMember', {
          workspaceId,
          memberId: aliceId,
          role: 'member',
        })
      ).json(),
    ).toEqual({ joined: true });
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();

    expect(
      await (await fixture.operation('addRoomMember', { roomId: room.id, memberId: aliceId })).json(),
    ).toEqual({ joined: false });
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const roomView = (await (
      await fixture.request(`/v1/phone/rooms/${room.id}`, 'GET', undefined, aliceToken)
    ).json()) as { messages: Array<{ text: string; presentation: string }> };
    expect(roomView.messages).not.toContainEqual(
      expect.objectContaining({
        text: '@alice joined · invited by @owner',
        presentation: 'system',
      }),
    );
    const chats = (await (await fixture.request(`/v1/phone/workspaces/${workspaceId}/chats`)).json()) as {
      chats: Array<{ room: { id: string }; latestMessage?: { text: string }; unread: boolean }>;
    };
    expect(chats.chats).toContainEqual(
      expect.objectContaining({
        room: expect.objectContaining({ id: room.id }),
        unread: false,
      }),
    );
  });


  it('lets a Workspace member open a corner inherited from a public Room', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: aliceId,
      role: 'member',
    });
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-before-late-join',
      name: 'Existing-corner',
      objective: 'Keep this corner readable through inherited public Room access',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };

    expect(
      (await fixture.request(`/v1/phone/rooms/${cornerId}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
    const parent = (await (
      await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET', undefined, aliceToken)
    ).json()) as RoomView;
    // Inherited access still opens the corner, but a source-free turn posts no opening line.
    expect(parent.messages).not.toContainEqual(
      expect.objectContaining({
        daemonFact: expect.objectContaining({ type: 'corner-open', cornerId }),
      }),
    );

    const corner = await fixture.request(`/v1/phone/rooms/${cornerId}`, 'GET', undefined, aliceToken);
    expect(corner.status).toBe(200);
    expect(isRoomView(await corner.json())).toBe(true);
  });


  it('stores, projects, and pushes a current human member typed without a picker', async () => {
    const recipient = createHash('sha256').update('github:recipient').digest('hex');
    const recipientToken = (await fixture.auth.exchangeGitHubOidc('recipient-proof')).accessToken;
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, recipient, ROOM],
    );
    const send = vi.fn(async () => undefined);
    const pushes = new PushDeliveryLoop(fixture.database, { send });
    await pushes.runOnce();
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('recipient-device-token-12345678901234567890',$1,'android','physical')`,
      [recipient],
    );

    const messageId = '6'.repeat(64);
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId,
      text: '@recipient try',
      mentions: [],
    });
    expect(sent.status).toBe(200);
    expect(await taggedBy(fixture.database, messageId)).toEqual([recipient]);

    const recipientRoom = await fixture.request(
      `/v1/phone/rooms/${ROOM}`,
      'GET',
      undefined,
      recipientToken,
    );
    expect(recipientRoom.status).toBe(200);
    const projected = (await recipientRoom.json()) as RoomView;
    expect(projected.messages.find((message) => message.id === messageId)?.mentionPubkeys).toEqual([
      recipient,
    ]);
    expect(await pushes.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'recipient-device-token-12345678901234567890',
      expect.objectContaining({ roomId: ROOM, text: 'Owner: @recipient try' }),
    );
  });


  it('mints, resolves, and redeems an invite through the phone HTTP surface', async () => {
    const created = await fixture.request('/v1/phone/operations/createInvite', 'POST', {
      workspaceId: WORKSPACE,
    });
    expect(created.status).toBe(200);
    const invite = (await created.json()) as { token: string; expiresAt: number };
    expect(isCommunityInviteToken(invite.token)).toBe(true);
    expect(invite.token).toMatch(/^inv_[0-9a-f]{64}$/);

    const publicPreview = await phoneFetch(
      `${fixture.origin}/v1/public/invite-preview?token=${encodeURIComponent(invite.token)}`,
    );
    expect(publicPreview.status).toBe(200);
    expect(publicPreview.headers.get('access-control-allow-origin')).toBe('*');
    expect(await publicPreview.json()).toEqual({
      valid: true,
      workspaceName: 'Hive',
      inviterName: 'Owner',
      expiresAt: invite.expiresAt,
    });

    const recipient = await fixture.auth.exchangeGitHubOidc('recipient-proof');
    const resolved = await fixture.request(
      '/v1/phone/operations/resolveInvite',
      'POST',
      { token: invite.token },
      recipient.accessToken,
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      name: 'Hive',
      expiresAt: invite.expiresAt,
    });

    const redeemed = await fixture.request(
      '/v1/phone/operations/redeemInvite',
      'POST',
      { token: invite.token },
      recipient.accessToken,
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ joined: true, workspaceId: WORKSPACE, roomId: ROOM });
    const membership = await fixture.database.query<{ role: string; invited_by: string | null }>(
      `SELECT role,invited_by FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, recipient.identityId],
    );
    expect(membership.rows).toEqual([{ role: 'member', invited_by: HUMAN }]);
  });


  it('collapses unknown, expired, consumed, and malformed public invites without authentication', async () => {
    const created = await fixture.request('/v1/phone/operations/createInvite', 'POST', {
      workspaceId: WORKSPACE,
    });
    const invite = (await created.json()) as { token: string };
    await fixture.database.query(
      `UPDATE invites SET expires_at=now()-interval '1 second' WHERE token_hash=$1`,
      [createHash('sha256').update(invite.token).digest('hex')],
    );
    const consumedCreated = await fixture.request('/v1/phone/operations/createInvite', 'POST', {
      workspaceId: WORKSPACE,
    });
    const consumedInvite = (await consumedCreated.json()) as { token: string };
    await fixture.database.query(`UPDATE invites SET consumed_at=now() WHERE token_hash=$1`, [
      createHash('sha256').update(consumedInvite.token).digest('hex'),
    ]);

    const paths = [
      `/v1/public/invite-preview?token=${invite.token}`,
      `/v1/public/invite-preview?token=${consumedInvite.token}`,
      `/v1/public/invite-preview?token=inv_${'f'.repeat(64)}`,
      '/v1/public/invite-preview?token=not-an-invite',
    ];
    for (const path of paths) {
      const response = await phoneFetch(`${fixture.origin}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ valid: false });
    }
  });


  it('rate-limits anonymous public invite previews per client', async () => {
    const path = `${fixture.origin}/v1/public/invite-preview?token=not-an-invite`;
    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1)
      expect((await phoneFetch(path)).status).toBe(404);

    const limited = await phoneFetch(path);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'too_many_requests' });
  });


  it('retains a Workspace join silently without System DMs or pushes', async () => {
    const recipient = await fixture.auth.exchangeGitHubOidc('recipient-proof');
    const secondRoom = (await (
      await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'workshop' })
    ).json()) as { id: string };
    await fixture.operation('registerPushDevice', {
      token: 'owner-person-join-device-token-1234567890',
      platform: 'android',
      environment: 'physical',
    });
    await fixture.database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [HUMAN]);
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    expect(await loop.runOnce()).toBe(0);
    const invite = (await (await fixture.operation('createInvite', { workspaceId: WORKSPACE })).json()) as {
      token: string;
    };

    const redeemed = await fixture.request(
      '/v1/phone/operations/redeemInvite',
      'POST',
      { token: invite.token },
      recipient.accessToken,
    );
    expect(redeemed.status).toBe(200);

    const roomNotes = await fixture.database.query<{
      room_id: string;
      text: string;
      presentation: string;
    }>(
      `SELECT room_id,text,presentation FROM messages
       WHERE author_id=$1 AND card_type='member-joined' AND room_id=ANY($2::uuid[])
      ORDER BY room_id`,
      [recipient.identityId, [ROOM, secondRoom.id]],
    );
    expect(roomNotes.rows).toEqual([]);

    const systemDms = await fixture.database.query<{
      id: string;
      room_id: string;
      author_id: string;
      text: string;
      presentation: string;
      direct_participants: string[];
      visibility: 'public' | 'invite-only';
    }>(
      `SELECT message.id,message.room_id,message.author_id,message.text,message.presentation,
              room.direct_participants,room.visibility
       FROM messages message JOIN rooms room ON room.id=message.room_id
       WHERE room.workspace_id=$1 AND message.card_type='workspace-member-joined'
         AND room.direct_participants IS NOT NULL
       ORDER BY message.room_id`,
      [WORKSPACE],
    );
    expect(systemDms.rows).toEqual([]);
    expect((await fixture.database.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`, [WORKSPACE, recipient.identityId])).rowCount).toBe(1);
    expect((await fixture.database.query(`SELECT 1 FROM workspace_join_notification_devices device JOIN workspace_join_notifications notification ON notification.id=device.notification_id WHERE notification.workspace_id=$1`, [WORKSPACE])).rowCount).toBe(0);
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();

  });


  it('creates title-only human corners that only their creator or a Workspace owner or admin can close', async () => {
    const created = await fixture.operation('createHumanCorner', {
      roomId: ROOM,
      title: 'Release-notes',
    });
    expect(created.status).toBe(200);
    const { id: cornerId } = (await created.json()) as { id: string };
    const stored = (
      await fixture.database.query<{
        name: string;
        created_by: string;
        commissioned_by: string;
        objective: string;
        kind: string;
        commands: number;
      }>(
        `SELECT room.name,room.created_by,${cornerCommissionerSql('room.id')} commissioned_by,${cornerObjectiveSql('room')} objective,${cornerKindSql('room.id')} kind,
          (SELECT count(*)::integer FROM agent_commands WHERE room_id=room.id) commands
         FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`,
        [cornerId],
      )
    ).rows[0];
    expect(stored).toEqual({
      name: 'Release-notes',
      created_by: HUMAN,
      commissioned_by: HUMAN,
      objective: '',
      kind: 'human',
      commands: 0,
    });
    const listed = await fixture.phone.readCorners(ROOM, HUMAN);
    expect(listed?.corners.find((corner) => corner.corner.id === cornerId)).toMatchObject({
      corner: { name: 'Release-notes' },
      initiator: { pubkey: HUMAN, kind: 'human' },
    });
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      cornerId,
      objective: '',
      title: 'Release-notes',
      kind: 'human',
    });

    const taggedMessageId = '4'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: cornerId,
          messageId: taggedMessageId,
          text: '@bee draft the release notes',
          mentions: [AGENT],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ agent_id: string; reason: string; state: string }>(
          `SELECT agent_id,reason,state FROM agent_commands WHERE source_message_id=$1`,
          [taggedMessageId],
        )
      ).rows,
    ).toEqual([{ agent_id: AGENT, reason: 'human_tag', state: 'pending' }]);

    const otherLogin = 'human-corner-member';
    const otherId = createHash('sha256').update(`github:${otherLogin}`).digest('hex');
    const otherToken = await fixture.phoneToken(otherLogin);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($1,$3,$2,'member') `,
      [WORKSPACE, otherId, ROOM],
    );
    const refused = await fixture.operation('requestCornerClose', { roomId: cornerId }, otherToken);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error:
        'corner close access denied: only the creator or a workspace owner or admin can close this corner',
    });

    // A Workspace admin controls every corner in the Workspace, including one
    // another person created.
    const adminLogin = 'human-corner-admin';
    const adminId = createHash('sha256').update(`github:${adminLogin}`).digest('hex');
    const adminToken = await fixture.phoneToken(adminLogin);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'admin'),($1,$3,$2,'member') `,
      [WORKSPACE, adminId, ROOM],
    );
    expect((await fixture.operation('requestCornerClose', { roomId: cornerId }, adminToken)).status).toBe(
      204,
    );
    expect(
      (
        await fixture.database.query<{ archived: boolean }>(
          `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
          [cornerId],
        )
      ).rows[0]?.archived,
    ).toBe(true);
  });


  it('lets a Workspace admin stop another requester’s turn whatever their Room role', async () => {
    const requestId = 'e'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: '@bee help',
      mentions: [AGENT],
    });
    await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    const token = await fixture.phoneToken('alice');
    const id = createHash('sha256').update('github:alice').digest('hex');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId: id, role: 'admin' });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: id });
    await fixture.database.query(
      `UPDATE memberships SET role='member' WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, id],
    );
    expect(
      (await fixture.operation('cancelAgentTurn', { roomId: ROOM, requestId, agentId: AGENT }, token))
        .status,
    ).toBe(204);
  });
});
