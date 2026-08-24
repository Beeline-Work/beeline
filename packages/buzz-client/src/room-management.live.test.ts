/** Live role-by-role proof for Room membership and retained-data archive management. */
import { describe, expect, it } from 'vitest';
import { signEvent } from '@beeline/nostr';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import {
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_REMOVE_USER,
  TAG_ROOM_LIFECYCLE,
} from './kinds.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker } from './live-helpers.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live Room membership management', () => {
  it('enforces remove, delete, leave, and non-admin refusal at the relay', async () => {
    const runId = uniqueMarker('room-manage');
    const owner = createIdentity('room-owner');
    const member = createIdentity('room-member');
    const other = createIdentity('room-other');
    const ownerClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });
    const memberClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: member,
    });

    const permissionsRoom = await ownerClient.createChannel(`permissions-${runId}`);
    await ownerClient.addMember(permissionsRoom, member.publicKey, 'member');
    await ownerClient.waitUntilMemberRole(permissionsRoom, member.publicKey, 'member');
    await ownerClient.addMember(permissionsRoom, member.publicKey, 'admin');
    await ownerClient.waitUntilMemberRole(permissionsRoom, member.publicKey, 'admin');
    expect(await ownerClient.getChannelRole(permissionsRoom, member.publicKey)).toBe('admin');

    const renamedRoomName = `renamed-${runId}`;
    await expect(ownerClient.renameChannel(permissionsRoom, renamedRoomName)).resolves.toMatchObject({
      name: renamedRoomName,
    });

    const removalRoom = await ownerClient.createChannel(`remove-${runId}`);
    await ownerClient.addMember(removalRoom, member.publicKey);
    await ownerClient.waitUntilMember(removalRoom, member.publicKey);
    await ownerClient.removeRoomMember(removalRoom, member.publicKey);
    expect(await ownerClient.isMember(removalRoom, member.publicKey)).toBe(false);
    // Relay-side kind:9 enforcement after membership removal is tracked separately.
    // This scope proves the authoritative roster projections no longer contain the member.

    const lifecycleRoom = await ownerClient.createChannel(`delete-${runId}`);
    await ownerClient.addMember(lifecycleRoom, member.publicKey);
    await ownerClient.waitUntilMember(lifecycleRoom, member.publicKey);
    await expect(memberClient.archiveRoom(lifecycleRoom)).rejects.toThrow(
      'only a Room owner or admin',
    );
    const unauthorizedArchive = signEvent(
      {
        pubkey: member.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_EDIT_METADATA,
        tags: [
          ['h', lifecycleRoom],
          ['archived', 'true'],
        ],
        content: '',
      },
      member.secretKey,
    );
    await expect(memberClient.publish(unauthorizedArchive)).rejects.toThrow();

    await ownerClient.archiveRoom(lifecycleRoom);
    expect((await ownerClient.getChannelMetadata(lifecycleRoom))?.archived).toBe(true);
    const lifecycleEvents = await ownerClient.query([
      { kinds: [KIND_EDIT_METADATA], '#h': [lifecycleRoom], limit: 20 },
    ]);
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pubkey: owner.publicKey,
          tags: expect.arrayContaining([
            ['archived', 'true'],
            ['t', TAG_ROOM_LIFECYCLE],
            ['action', 'admin-archive'],
          ]),
        }),
      ]),
    );
    const deletionRoom = await ownerClient.createChannel(`delete-${runId}`);
    await ownerClient.addMember(deletionRoom, member.publicKey);
    await ownerClient.waitUntilMember(deletionRoom, member.publicKey);
    await expect(memberClient.deleteRoom(deletionRoom)).rejects.toThrow('only a Room owner');
    await ownerClient.deleteRoom(deletionRoom);
    expect((await ownerClient.listMyChannels()).map(({ channelId }) => channelId)).not.toContain(
      deletionRoom,
    );
    expect(await ownerClient.getChannelMetadata(deletionRoom)).toBeNull();
    expect(
      await ownerClient.query([
        { kinds: [KIND_CREATE_GROUP], '#h': [deletionRoom], limit: 20 },
      ]),
    ).toEqual([]);
    const leaveRoom = await ownerClient.createChannel(`leave-${runId}`);
    await ownerClient.addMember(leaveRoom, member.publicKey);
    await ownerClient.waitUntilMember(leaveRoom, member.publicKey);
    await ownerClient.addMember(leaveRoom, other.publicKey);
    await ownerClient.waitUntilMember(leaveRoom, other.publicKey);
    const unauthorizedRemoval = signEvent(
      {
        pubkey: member.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_REMOVE_USER,
        tags: [
          ['h', leaveRoom],
          ['p', other.publicKey],
        ],
        content: '',
      },
      member.secretKey,
    );
    await expect(memberClient.publish(unauthorizedRemoval)).rejects.toThrow();
    await memberClient.leaveRoom(leaveRoom);
    expect((await memberClient.listMyChannels()).map(({ channelId }) => channelId)).not.toContain(
      leaveRoom,
    );
    expect(await ownerClient.isMember(leaveRoom, owner.publicKey)).toBe(true);
    expect(await ownerClient.isMember(leaveRoom, other.publicKey)).toBe(true);

    console.log(
      `[live-room-management] run=${runId} removed=${member.publicKey.slice(0, 8)} archived=${lifecycleRoom} left=${leaveRoom}`,
    );
  }, 90_000);
});

describe.runIf(!reachable)('live Room membership management (skipped)', () => {
  it('soft-skips when relay is unreachable', () => {
    console.log(`[live-room-management] SKIP relay unreachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
