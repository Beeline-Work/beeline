import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type RoomView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: membership', () => {
const fixture = monolithFixture();


  it('keeps workspace and Room mutations aligned with the phone HTTP contract', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const createdWorkspace = (await (
      await fixture.operation('createWorkspace', { workspaceId, name: 'Audit' })
    ).json()) as { id: string; roomId: string };
    expect(createdWorkspace).toEqual({ id: workspaceId, roomId: expect.any(String) });
    // A retry is idempotent and returns the same first Room.
    expect(
      await (await fixture.operation('createWorkspace', { workspaceId, name: 'Audit' })).json(),
    ).toEqual(createdWorkspace);
    const general = (await (
      await fixture.request(`/v1/phone/rooms/${createdWorkspace.roomId}`)
    ).json()) as {
      room: { name: string; visibility: string; workspaceId: string };
    };
    expect(general.room).toMatchObject({ name: 'general', visibility: 'public', workspaceId });
    expect(
      (
        await fixture.operation('updateWorkspace', {
          workspaceId,
          name: 'Audit renamed',
          visibility: 'public',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        (await (await fixture.request('/v1/phone/workspaces')).json()) as {
          workspaces: Array<{ id: string; name: string; visibility: string }>;
        }
      ).workspaces,
    ).toContainEqual(
      expect.objectContaining({ id: workspaceId, name: 'Audit renamed', visibility: 'public' }),
    );

    expect(
      await (
        await fixture.operation('addWorkspaceMember', {
          workspaceId,
          memberId: aliceId,
          role: 'owner',
        })
      ).json(),
    ).toEqual({ joined: true });
    const workspace = (await (await fixture.request(`/v1/phone/workspaces/${workspaceId}`)).json()) as {
      members: Array<{ identity: { pubkey: string }; role: string }>;
    };
    expect(workspace.members).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ pubkey: aliceId }),
        role: 'owner',
      }),
    );

    const created = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'public-by-default' })
    ).json()) as { id: string };
    expect(
      (await fixture.request(`/v1/phone/rooms/${created.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
    expect(
      (
        await fixture.operation('updateRoom', {
          roomId: created.id,
          name: 'renamed-room',
          visibility: 'invite-only',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        (await (
          await fixture.request(`/v1/phone/rooms/${created.id}`, 'GET', undefined, aliceToken)
        ).json()) as {
          room: { visibility: string };
        }
      ).room.visibility,
    ).toBe('invite-only');
    expect(
      (await fixture.request(`/v1/phone/rooms/${created.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
    expect(
      (await fixture.operation('removeRoomMember', { roomId: created.id, memberId: aliceId })).status,
    ).toBe(204);
    await fixture.operation('addRoomMember', { roomId: created.id, memberId: aliceId });
    expect((await fixture.operation('leaveRoom', { roomId: created.id }, aliceToken)).status).toBe(204);
    expect((await fixture.operation('deleteRoom', { roomId: created.id })).status).toBe(204);
    expect((await fixture.request(`/v1/phone/rooms/${created.id}`)).status).toBe(404);
    const chats = (await (await fixture.request(`/v1/phone/workspaces/${workspaceId}/chats`)).json()) as {
      chats: Array<{ room: { id: string } }>;
    };
    expect(chats.chats.some((chat) => chat.room.id === created.id)).toBe(false);

    expect((await fixture.operation('leaveWorkspace', { workspaceId })).status).toBe(204);
    expect((await fixture.request(`/v1/phone/workspaces/${workspaceId}`)).status).toBe(404);
  });


  it('propagates Workspace role changes to existing top-level shared Room memberships', async () => {
    const memberId = createHash('sha256').update('github:role-projection-member').digest('hex');
    await fixture.phoneToken('role-projection-member');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'admin' });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId });
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });

    const roles = await fixture.database.query<{ room_id: string | null; role: string }>(
      `SELECT room_id,role FROM memberships
       WHERE workspace_id=$1 AND identity_id=$2 AND (room_id IS NULL OR room_id=$3)
       ORDER BY room_id NULLS FIRST`,
      [WORKSPACE, memberId, ROOM],
    );
    expect(roles.rows).toEqual([
      { room_id: null, role: 'member' },
      { room_id: ROOM, role: 'member' },
    ]);
  });


  it('restores a tombstoned Workspace member when an invite-only Room becomes public', async () => {
    const memberToken = await fixture.phoneToken('publicize-tombstoned-member');
    const memberId = createHash('sha256')
      .update('github:publicize-tombstoned-member')
      .digest('hex');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    const room = (await (
      await fixture.operation('createRoom', {
        workspaceId: WORKSPACE,
        name: 'opening-after-an-explicit-removal',
        visibility: 'invite-only',
      })
    ).json()) as { id: string };

    expect((await fixture.operation('addRoomMember', { roomId: room.id, memberId })).status).toBe(200);
    expect((await fixture.operation('removeRoomMember', { roomId: room.id, memberId })).status).toBe(204);
    expect(
      (await fixture.request(`/v1/phone/rooms/${room.id}`, 'GET', undefined, memberToken)).status,
    ).toBe(404);

    expect((await fixture.operation('updateRoom', { roomId: room.id, visibility: 'public' })).status).toBe(
      204,
    );
    expect(
      (await fixture.request(`/v1/phone/rooms/${room.id}`, 'GET', undefined, memberToken)).status,
    ).toBe(200);
  });


  it('enforces unique Room slugs on create and rename', async () => {
    const created = await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'road-map' });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(
      (await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'Road Map' })).status,
    ).toBe(400);
    expect(
      (await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'road-map' })).status,
    ).toBe(409);
    expect((await fixture.operation('updateRoom', { roomId: id, name: 'road-map-2' })).status).toBe(204);
    expect((await fixture.operation('updateRoom', { roomId: id, name: 'Road Map 3' })).status).toBe(400);
    // Renaming frees the old slug; a later Room can claim it, and the renamed
    // Room can no longer take it back.
    expect(
      (await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'road-map' })).status,
    ).toBe(200);
    expect((await fixture.operation('updateRoom', { roomId: id, name: 'road-map' })).status).toBe(409);
  });


  it('restores a removed public-Room membership with its current Workspace role', async () => {
    const memberId = createHash('sha256').update('github:public-room-role-restore').digest('hex');
    await fixture.phoneToken('public-room-role-restore');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'admin' });
    const room = (await (
      await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'role-preserving-rejoin' })
    ).json()) as { id: string };

    expect((await fixture.operation('removeRoomMember', { roomId: room.id, memberId })).status).toBe(204);
    expect(await (await fixture.operation('addRoomMember', { roomId: room.id, memberId })).json()).toEqual({
      joined: true,
    });
    expect(
      (
        await fixture.database.query<{ role: string; removed: boolean }>(
          `SELECT role,removed_at IS NOT NULL removed FROM memberships WHERE room_id=$1 AND identity_id=$2`,
          [room.id, memberId],
        )
      ).rows,
    ).toEqual([{ role: 'admin', removed: false }]);
  });


  it('adds several current Workspace members with one phone write', async () => {
    const memberIds = ['batch-room-0', 'batch-room-1'].map((name) =>
      createHash('sha256').update(`github:${name}`).digest('hex'),
    );
    for (const [index, memberId] of memberIds.entries()) {
      await fixture.phoneToken(`batch-room-${index}`);
      await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    }
    const room = (await (
      await fixture.operation('createRoom', {
        workspaceId: WORKSPACE,
        name: 'batch-room-members',
        visibility: 'invite-only',
      })
    ).json()) as { id: string };
    expect(await (await fixture.operation('addRoomMember', { roomId: room.id, memberIds })).json())
      .toEqual({ joined: true, joinedIds: memberIds });
    expect((await fixture.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships WHERE room_id=$1 AND identity_id=ANY($2::text[])
         AND removed_at IS NULL ORDER BY identity_id`,
      [room.id, memberIds],
    )).rows.map((row) => row.identity_id)).toEqual([...memberIds].sort());
  });


  it('reserves workspace and Room management for workspace owners and admins', async () => {
    const memberToken = await fixture.phoneToken('room-member');
    const memberId = createHash('sha256').update('github:room-member').digest('hex');
    const adminToken = await fixture.phoneToken('room-admin');
    const adminId = createHash('sha256').update('github:room-admin').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId,
      role: 'member',
    });
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });

    for (const [name, input] of [
      ['updateWorkspace', { workspaceId: WORKSPACE, name: 'Member renamed' }],
      ['createRoom', { workspaceId: WORKSPACE, name: 'member-room' }],
      ['updateRoom', { roomId: ROOM, name: 'member-renamed-room' }],
      ['deleteRoom', { roomId: ROOM }],
    ] as const) {
      const response = await fixture.operation(name, input, memberToken);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'workspace admins only' });
    }

    expect(
      (
        await fixture.operation(
          'updateWorkspace',
          { workspaceId: WORKSPACE, name: 'Admin renamed' },
          adminToken,
        )
      ).status,
    ).toBe(204);
    const adminRoom = (await (
      await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'admin-room' }, adminToken)
    ).json()) as { id: string };
    expect(
      (
        await fixture.database.query<{ role: string }>(
          `SELECT role FROM memberships WHERE room_id=$1 AND identity_id=$2`,
          [adminRoom.id, adminId],
        )
      ).rows,
    ).toEqual([{ role: 'admin' }]);
    expect(
      (
        await fixture.operation(
          'updateRoom',
          { roomId: adminRoom.id, name: 'admin-renamed-room' },
          adminToken,
        )
      ).status,
    ).toBe(204);
    expect(
      (await fixture.request(`/v1/phone/rooms/${adminRoom.id}`, 'GET', undefined, adminToken)).status,
    ).toBe(200);
    expect(
      (
        (await (
          await fixture.request(`/v1/phone/rooms/${adminRoom.id}`, 'GET', undefined, adminToken)
        ).json()) as RoomView
      ).viewer.permissions.manage,
    ).toBe(true);
    expect((await fixture.operation('deleteRoom', { roomId: adminRoom.id }, adminToken)).status).toBe(204);
  });


  it('derives Room and corner management from the active Workspace role', async () => {
    const staleToken = await fixture.phoneToken('stale-room-owner');
    const staleId = createHash('sha256').update('github:stale-room-owner').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: staleId,
      role: 'admin',
    });
    const room = (await (
      await fixture.operation(
        'createRoom',
        { workspaceId: WORKSPACE, name: 'stale-owner-room' },
        staleToken,
      )
    ).json()) as { id: string };
    await fixture.database.query(
      `UPDATE memberships SET role='member' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, staleId],
    );
    expect(
      (
        (await (
          await fixture.request(`/v1/phone/rooms/${room.id}`, 'GET', undefined, staleToken)
        ).json()) as RoomView
      ).viewer.permissions.manage,
    ).toBe(false);
    expect(
      (
        (await (
          await fixture.request(`/v1/phone/rooms/${room.id}/corners`, 'GET', undefined, staleToken)
        ).json()) as { viewer: { permissions: { manage: boolean } } }
      ).viewer.permissions.manage,
    ).toBe(false);
  });


  it('lets a Workspace manager remove a stale Room owner', async () => {
    const staleToken = await fixture.phoneToken('stale-room-owner-removal');
    const staleId = createHash('sha256').update('github:stale-room-owner-removal').digest('hex');
    const adminToken = await fixture.phoneToken('room-removal-admin');
    const adminId = createHash('sha256').update('github:room-removal-admin').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: staleId,
      role: 'admin',
    });
    const room = (await (
      await fixture.operation(
        'createRoom',
        { workspaceId: WORKSPACE, name: 'stale-owner-removal' },
        staleToken,
      )
    ).json()) as { id: string };
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });
    await fixture.operation('addRoomMember', { roomId: room.id, memberId: adminId });
    await fixture.database.query(
      `UPDATE memberships SET role='member' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, staleId],
    );
    expect(
      (await fixture.operation('removeRoomMember', { roomId: room.id, memberId: staleId }, adminToken))
        .status,
    ).toBe(204);
  });


  it('lands new people nowhere and makes person invites single-use, retry-safe, and Room-complete', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const bobToken = await fixture.phoneToken('bob');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    // No shared Welcome Workspace: a new person has no Workspace until they
    // create one or redeem an invite.
    const aliceWorkspaces = (await (
      await fixture.request('/v1/phone/workspaces', 'GET', undefined, aliceToken)
    ).json()) as { workspaces: Array<{ name: string }> };
    expect(aliceWorkspaces.workspaces).toEqual([]);

    const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const created = (await (
      await fixture.operation('createWorkspace', { workspaceId, name: 'Invites' })
    ).json()) as { roomId: string };
    const room = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'existing-room' })
    ).json()) as { id: string };
    const invite = (await (await fixture.operation('createInvite', { workspaceId })).json()) as {
      token: string;
      expiresAt: number;
    };
    expect(invite.expiresAt).toBeLessThan(10_000_000_000);
    // The preview names the Workspace, who is inviting, and its size.
    expect(
      await (await fixture.operation('resolveInvite', { token: invite.token }, aliceToken)).json(),
    ).toEqual({
      name: 'Invites',
      expiresAt: invite.expiresAt,
      inviter: { name: 'Owner', handle: 'owner', role: 'owner' },
      memberCount: 1,
      agentCount: 0,
    });
    // Redeeming hands back the first Room to open: the Workspace's #general.
    expect(
      await (await fixture.operation('redeemInvite', { token: invite.token }, aliceToken)).json(),
    ).toEqual({ joined: true, workspaceId, roomId: created.roomId });
    expect(
      (await fixture.operation('resolveInvite', { token: invite.token }, aliceToken)).status,
    ).toBe(404);
    expect(
      await (await fixture.operation('redeemInvite', { token: invite.token }, aliceToken)).json(),
    ).toEqual({ joined: false, workspaceId, roomId: created.roomId });
    // The invite is spent on first use: a different person cannot redeem the
    // same token, whether previewing or joining with it.
    expect(
      (await fixture.operation('resolveInvite', { token: invite.token }, bobToken)).status,
    ).toBe(404);
    expect(
      (await fixture.operation('redeemInvite', { token: invite.token }, bobToken)).status,
    ).toBe(404);
    const bobInvite = (await (await fixture.operation('createInvite', { workspaceId })).json()) as {
      token: string;
    };
    expect(
      await (await fixture.operation('redeemInvite', { token: bobInvite.token }, bobToken)).json(),
    ).toEqual({ joined: true, workspaceId, roomId: created.roomId });
    expect(
      (await fixture.operation('resolveInvite', { token: invite.token }, bobToken)).status,
    ).toBe(404);

    const aliceChats = (await (
      await fixture.request(`/v1/phone/workspaces/${workspaceId}/chats`, 'GET', undefined, aliceToken)
    ).json()) as { chats: Array<{ room: { id: string } }> };
    expect(aliceChats.chats.map((chat) => chat.room.id)).toContain(room.id);
    const roomView = (await (await fixture.request(`/v1/phone/rooms/${room.id}`)).json()) as {
      members: Array<{ identity: { pubkey: string } }>;
    };
    expect(roomView.members.map((member) => member.identity.pubkey)).toEqual(
      expect.arrayContaining([HUMAN, aliceId, bobId]),
    );

    const laterRoom = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'later-room' })
    ).json()) as { id: string };
    expect(
      (await fixture.request(`/v1/phone/rooms/${laterRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);

    await fixture.operation('addWorkspaceMember', {
      workspaceId,
      memberId: aliceId,
      role: 'admin',
    });

    const privateRoom = (await (
      await fixture.operation('createRoom', {
        workspaceId,
        name: 'admins-invite-only',
        visibility: 'invite-only',
      })
    ).json()) as { id: string };
    expect(
      (await fixture.request(`/v1/phone/rooms/${privateRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(404);
    const aliceWorkspace = (await (
      await fixture.request(`/v1/phone/workspaces/${workspaceId}`, 'GET', undefined, aliceToken)
    ).json()) as {
      managerSettings?: {
        rooms?: Array<{ id: string; visibility: string }>;
        roomsTruncated?: boolean;
      };
    };
    expect(aliceWorkspace.managerSettings?.rooms).toContainEqual({
      id: privateRoom.id,
      name: 'admins-invite-only',
      visibility: 'invite-only',
      createdAt: expect.any(Number),
    });
    expect(
      (await fixture.operation('updateRoom', { roomId: privateRoom.id, visibility: 'public' }, bobToken))
        .status,
    ).toBe(403);
    expect(
      (await fixture.operation('updateRoom', { roomId: privateRoom.id, visibility: 'public' }, aliceToken))
        .status,
    ).toBe(204);
    expect(
      (await fixture.request(`/v1/phone/rooms/${privateRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,name)
       SELECT ('70000000-0000-4000-8000-' || lpad(value::text,12,'0'))::uuid,$1,
              'Bounded index ' || lpad(value::text,3,'0')
       FROM generate_series(1,201) value`,
      [workspaceId],
    );
    const boundedManagerWorkspace = (await (
      await fixture.request(`/v1/phone/workspaces/${workspaceId}`, 'GET', undefined, aliceToken)
    ).json()) as {
      managerSettings?: { rooms?: Array<{ id: string }>; roomsTruncated?: boolean };
    };
    expect(boundedManagerWorkspace.managerSettings?.rooms).toHaveLength(200);
    expect(boundedManagerWorkspace.managerSettings?.roomsTruncated).toBe(true);
    const openedRoom = (await (
      await fixture.operation('createRoom', {
        workspaceId,
        name: 'open-later',
        visibility: 'invite-only',
      })
    ).json()) as { id: string };
    expect(
      (await fixture.request(`/v1/phone/rooms/${openedRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(404);
    expect(
      (await fixture.operation('updateRoom', { roomId: openedRoom.id, visibility: 'public' })).status,
    ).toBe(204);
    expect(
      (await fixture.request(`/v1/phone/rooms/${openedRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);

    // An owner who is not in an invite-only Room joins it from Workspace settings.
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'owner' });
    const unjoinedRoom = (await (
      await fixture.operation('createRoom', {
        workspaceId,
        name: 'owner-self-join',
        visibility: 'invite-only',
      })
    ).json()) as { id: string };
    expect(
      (await fixture.request(`/v1/phone/rooms/${unjoinedRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(404);
    expect(
      await (
        await fixture.operation('addRoomMember', { roomId: unjoinedRoom.id, memberId: aliceId }, aliceToken)
      ).json(),
    ).toEqual({ joined: true });
    expect(
      (await fixture.request(`/v1/phone/rooms/${unjoinedRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
  });


  it('bounds Room membership and direct messages to current Workspace members', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const outsiderToken = await fixture.phoneToken('outsider');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const outsiderId = createHash('sha256').update('github:outsider').digest('hex');
    const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await fixture.operation('createWorkspace', { workspaceId, name: 'DMs' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'member' });
    const room = (await (await fixture.operation('createRoom', { workspaceId, name: 'room' })).json()) as {
      id: string;
    };

    expect(
      (await fixture.operation('addRoomMember', { roomId: room.id, memberId: outsiderId })).status,
    ).toBe(400);
    expect(
      (
        await fixture.operation(
          'resolveDirectMessage',
          { workspaceId, participantId: HUMAN },
          outsiderToken,
        )
      ).status,
    ).toBe(400);
    const first = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId, participantId: aliceId })
    ).json()) as { id: string; created: boolean };
    const retry = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId, participantId: HUMAN }, aliceToken)
    ).json()) as { id: string; created: boolean };
    expect(first).toEqual({ id: retry.id, created: true });
    expect(retry.created).toBe(false);
    const systemDm = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId, participantId: SYSTEM_IDENTITY_ID })
    ).json()) as { id: string; created: boolean };
    expect(systemDm.id).toBeTruthy();
    expect((await (
      await fixture.operation('resolveDirectMessage', { workspaceId, participantId: SYSTEM_IDENTITY_ID })
    ).json())).toEqual({ id: systemDm.id, created: false });
    const lastManagerLeave = await fixture.operation('leaveRoom', { roomId: room.id });
    expect(lastManagerLeave.status).toBe(400);
    expect(await lastManagerLeave.json()).toEqual({ error: 'last_admin_confirmation_required' });
    expect((await fixture.operation('removeRoomMember', { roomId: room.id, memberId: HUMAN })).status).toBe(
      403,
    );
    expect((await fixture.operation('leaveWorkspace', { workspaceId })).status).toBe(403);
  });


  it('reports one creator for concurrent first System direct-message resolutions', async () => {
    const workspaceId = '0d021e00-0000-4000-8000-000000000001';
    await fixture.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'System DM race')`, [workspaceId]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [workspaceId, HUMAN],
    );
    const query = fixture.database.query.bind(fixture.database);
    let releaseInserts!: () => void;
    const insertsReady = new Promise<void>((resolve) => { releaseInserts = resolve; });
    let roomInserts = 0;
    let preInsertReads = 0;
    const querySpy = vi.spyOn(fixture.database, 'query').mockImplementation(async (sql, values) => {
      if (sql.includes('SELECT 1 FROM rooms WHERE id=$1')) {
        const result = await query(sql, values);
        if (++preInsertReads === 2) releaseInserts();
        return result;
      }
      if (sql.includes('INSERT INTO rooms') && sql.includes("'Direct message'")) {
        if (++roomInserts === 2) releaseInserts();
        await insertsReady;
      }
      return query(sql, values);
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 2 }, async () => {
          const response = await fixture.operation('resolveDirectMessage', {
            workspaceId,
            participantId: SYSTEM_IDENTITY_ID,
          });
          expect(response.status).toBe(200);
          return (await response.json()) as { id: string; created: boolean };
        }),
      );
      expect(results[0]!.id).toBe(results[1]!.id);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    } finally {
      querySpy.mockRestore();
    }
  });


  it('leaves Rooms atomically while DM close stays non-destructive', async () => {
    const aliceToken = await fixture.phoneToken('chat-close-alice');
    const aliceId = createHash('sha256').update('github:chat-close-alice').digest('hex');
    const adminToken = await fixture.phoneToken('chat-close-admin');
    const adminId = createHash('sha256').update('github:chat-close-admin').digest('hex');
    const workspaceId = 'c105ed00-c105-4ed0-8105-c105ed00c105';
    await fixture.operation('createWorkspace', { workspaceId, name: 'Chat close' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'member' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: adminId, role: 'admin' });
    const room = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'preserved-room' })
    ).json()) as { id: string };
    await fixture.operation('sendRoomMessage', { roomId: room.id, text: 'history stays' });

    const chat = async (token: string | undefined, roomId: string) => {
      const view = (await (
        await fixture.request(`/v1/phone/workspaces/${workspaceId}/chats`, 'GET', undefined, token)
      ).json()) as {
        chats: Array<{ room: { id: string }; closed?: boolean; leaveDeletesRoom?: boolean }>;
      };
      return view.chats.find((item) => item.room.id === roomId);
    };

    expect((await fixture.operation('closeChat', { roomId: room.id }, aliceToken)).status).toBe(400);
    expect(await chat(aliceToken, room.id)).toBeDefined();

    // Workspace role is authoritative for a top-level Room. Repairing a stale
    // elevated Room role must not make an ordinary Workspace member unable to leave.
    await fixture.database.query(
      `UPDATE memberships SET role='admin' WHERE room_id=$1 AND identity_id=$2`,
      [room.id, aliceId],
    );
    expect((await fixture.operation('leaveRoom', { roomId: room.id }, aliceToken)).status).toBe(204);
    expect(await chat(aliceToken, room.id)).toBeUndefined();
    expect(
      (
        await fixture.database.query<{ active: boolean }>(
          `SELECT removed_at IS NULL active FROM memberships WHERE room_id=$1 AND identity_id=$2`,
          [room.id, aliceId],
        )
      ).rows,
    ).toEqual([{ active: false }]);
    await fixture.operation('sendRoomMessage', { roomId: room.id, text: 'room traffic does not rejoin' });
    expect(await chat(aliceToken, room.id)).toBeUndefined();

    const failedRoom = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'rollback-room' })
    ).json()) as { id: string };
    await fixture.database.query(`
      CREATE FUNCTION fail_member_left_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.card_type='member-left' THEN RAISE EXCEPTION 'forced member-left failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_member_left_insert BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION fail_member_left_insert()
    `);
    const failedLeave = await fixture.operation('leaveRoom', { roomId: failedRoom.id }, aliceToken);
    expect(failedLeave.status).toBe(503);
    expect(await failedLeave.json()).toEqual({ error: 'forced member-left failure' });
    await fixture.database.query(`
      DROP TRIGGER fail_member_left_insert ON messages;
      DROP FUNCTION fail_member_left_insert()
    `);
    expect(await chat(aliceToken, failedRoom.id)).toBeDefined();
    expect(
      (
        await fixture.database.query<{ active: boolean }>(
          `SELECT removed_at IS NULL active FROM memberships WHERE room_id=$1 AND identity_id=$2`,
          [failedRoom.id, aliceId],
        )
      ).rows,
    ).toEqual([{ active: true }]);

    // A non-last admin can leave without deleting the Room or asking to delete it.
    const adminLeave = await fixture.operation('leaveRoom', { roomId: failedRoom.id }, adminToken);
    expect(adminLeave.status).toBe(204);
    expect(await chat(undefined, failedRoom.id)).toBeDefined();
    expect(await chat(adminToken, failedRoom.id)).toBeUndefined();
    expect(
      (await fixture.database.query(`SELECT 1 FROM rooms WHERE id=$1`, [failedRoom.id])).rowCount,
    ).toBe(1);

    // The last manager's first attempt cannot delete before a destructive
    // confirmation, even if the UI's previous roster snapshot was stale.
    const unconfirmed = await fixture.operation('leaveRoom', { roomId: failedRoom.id });
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toEqual({ error: 'last_admin_confirmation_required' });
    expect(await chat(aliceToken, failedRoom.id)).toBeDefined();
    expect(
      (await fixture.operation('leaveRoom', { roomId: failedRoom.id, confirmDelete: true })).status,
    ).toBe(204);
    expect(
      (await fixture.database.query(`SELECT 1 FROM rooms WHERE id=$1`, [failedRoom.id])).rowCount,
    ).toBe(0);
    expect(await chat(aliceToken, failedRoom.id)).toBeUndefined();

    const adminLastRoom = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'admin-last-room' })
    ).json()) as { id: string };
    expect((await chat(adminToken, adminLastRoom.id))?.leaveDeletesRoom).toBe(false);
    expect((await fixture.operation('leaveRoom', { roomId: adminLastRoom.id })).status).toBe(204);
    expect((await chat(adminToken, adminLastRoom.id))?.leaveDeletesRoom).toBe(true);
    expect((await fixture.phone.readRoom(adminLastRoom.id, adminId))?.leaveDeletesRoom).toBe(true);
    expect(
      (await fixture.operation('leaveRoom', { roomId: adminLastRoom.id, confirmDelete: true }, adminToken))
        .status,
    ).toBe(204);
    expect(
      (await fixture.database.query(`SELECT 1 FROM rooms WHERE id=$1`, [adminLastRoom.id])).rowCount,
    ).toBe(0);
    expect(await chat(aliceToken, adminLastRoom.id)).toBeUndefined();

    const dm = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId, participantId: aliceId })
    ).json()) as { id: string };
    await fixture.operation('sendRoomMessage', { roomId: dm.id, text: 'dm history stays' });
    await fixture.operation('closeChat', { roomId: dm.id });
    expect(await chat(undefined, dm.id)).toMatchObject({ closed: true });
    expect(
      (await fixture.operation('resolveDirectMessage', { workspaceId, participantId: aliceId })).status,
    ).toBe(200);
    expect((await chat(undefined, dm.id))?.closed).toBeUndefined();

    await fixture.operation('closeChat', { roomId: dm.id });
    await fixture.operation('sendRoomMessage', { roomId: dm.id, text: 'new dm' }, aliceToken);
    expect((await chat(undefined, dm.id))?.closed).toBeUndefined();

    const memberships = await fixture.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships
       WHERE room_id=$1 AND removed_at IS NULL ORDER BY identity_id`,
      [dm.id],
    );
    expect(memberships.rows).toHaveLength(2);
    const preserved = (await (await fixture.request(`/v1/phone/rooms/${room.id}`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(preserved.messages.map((message) => message.text)).toContain('history stays');
    expect(preserved.messages.map((message) => message.text)).toContain(
      'room traffic does not rejoin',
    );
  });


  it('lets a Workspace manager remove a person from the Workspace and every live Room', async () => {
    const aliceToken = await fixture.phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    await fixture.phoneToken('bob');
    const workspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await fixture.operation('createWorkspace', { workspaceId, name: 'Removals' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'admin' });
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: bobId, role: 'admin' });
    const room = (await (
      await fixture.operation('createRoom', { workspaceId, name: 'shared' })
    ).json()) as { id: string };
    await fixture.operation('addRoomMember', { roomId: room.id, memberId: bobId });
    await fixture.operation('addRoomMember', { roomId: room.id, memberId: aliceId });

    // Owners are protected, peers may remove peers, and agents use their own path.
    expect(
      (await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: HUMAN })).status,
    ).toBe(403);
    expect(
      (await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: HUMAN }, aliceToken))
        .status,
    ).toBe(403);
    expect(
      (await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: bobId }, aliceToken))
        .status,
    ).toBe(204);
    await fixture.operation('addWorkspaceMember', { workspaceId, memberId: bobId, role: 'admin' });
    expect(
      (await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: AGENT })).status,
    ).toBe(400);

    expect(
      (await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: bobId })).status,
    ).toBe(204);
    const workspace = (await (await fixture.request(`/v1/phone/workspaces/${workspaceId}`)).json()) as {
      members: Array<{ identity: { pubkey: string } }>;
    };
    expect(workspace.members.map((member) => member.identity.pubkey)).not.toContain(bobId);
    const view = (await (await fixture.request(`/v1/phone/rooms/${room.id}`)).json()) as {
      members: Array<{ identity: { pubkey: string } }>;
      messages: Array<{ text: string; presentation: string; systemEvent?: { verb: string } }>;
    };
    expect(view.members.map((member) => member.identity.pubkey)).not.toContain(bobId);
    expect(view.messages).not.toContainEqual(
      expect.objectContaining({
        presentation: 'system',
        text: expect.stringMatching(/ removed /),
        systemEvent: expect.objectContaining({
          verb: 'removed',
          object: expect.objectContaining({ id: bobId }),
        }),
      }),
    );
    const removalDms = await fixture.database.query<{ author_id: string; text: string; count: number }>(
      `SELECT message.author_id,message.text,count(*)::int count
       FROM messages message JOIN rooms room ON room.id=message.room_id
       WHERE room.workspace_id=$1 AND room.direct_participants IS NOT NULL
         AND message.card_type='member-removed'
       GROUP BY message.author_id,message.text`,
      [workspaceId],
    );
    expect(removalDms.rows).toEqual([]);
    // Gone means gone: the second removal has no membership to act on.
    expect(
      (await fixture.operation('removeWorkspaceMember', { workspaceId, memberId: bobId })).status,
    ).toBe(400);
  });
});
