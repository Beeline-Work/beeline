/**
 * Live proof that a late Workspace invitee can discover and read every existing
 * top-level Room. The broad message query mirrors the push gateway's per-reader
 * polling shape; listMyChannels + backfill mirror the mobile Room list/open path.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_HOST,
  isRelayUp,
  uniqueMarker,
  waitFor,
} from './live-helpers.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live late Workspace invitee Room visibility', () => {
  it('lists an existing Room and backfills its existing messages', async () => {
    const runId = uniqueMarker('invite-visibility');
    const owner = createIdentity('invite-owner');
    const friend = createIdentity('invite-friend');
    const ownerClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });
    const friendClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: friend,
    });
    let roomId = '';
    onTestFinished(async () => {
      if (roomId) await ownerClient.archiveRoom(roomId).catch(() => undefined);
      ownerClient.disconnect();
      friendClient.disconnect();
    });

    const communityId = await ownerClient.createCommunity(`workspace-${runId}`);
    await ownerClient.waitUntilMember(communityId, owner.publicKey);
    roomId = await ownerClient.createChannel(`room-${runId}`, { communityId });
    const existingText = `existing-${runId}`;
    const notificationText = `notification-${runId}`;
    await ownerClient.messageSubmit(roomId, existingText);
    const invite = await ownerClient.createInvite(communityId, { expiresInSeconds: 3600 });

    await expect(friendClient.redeemInvite(invite.token)).resolves.toMatchObject({
      communityId,
      joined: true,
      alreadyMember: false,
    });
    const notificationEvent = await ownerClient.messageSubmit(roomId, notificationText);

    let broadVisible = false;
    await waitFor(
      async () => {
        const events = await friendClient.query([
          { kinds: [9], since: notificationEvent.created_at - 1, limit: 100 },
        ]);
        broadVisible = events.some((event) => event.id === notificationEvent.id);
        return broadVisible;
      },
      { label: 'friend broad recipient-scoped query sees notification event' },
    );

    const memberships = await friendClient.listMyChannels();
    const backfill = await friendClient.sessionEventsBackfill(roomId, { limit: 100 });
    const roomListed = memberships.some(({ channelId }) => channelId === roomId);
    const existingVisible = backfill.some((event) => event.content === existingText);
    const notificationVisible = backfill.some((event) => event.id === notificationEvent.id);

    console.log(
      `[live-invite-visibility] workspace=${communityId} room=${roomId} ` +
        `friend=${friend.publicKey.slice(0, 12)} broad=${broadVisible} listed=${roomListed} ` +
        `existing=${existingVisible} notification=${notificationVisible} backfill=${backfill.length}`,
    );

    expect(broadVisible).toBe(true);
    expect(roomListed).toBe(true);
    expect(existingVisible).toBe(true);
    expect(notificationVisible).toBe(true);
  }, 90_000);

  it('repairs a Workspace member whose existing Room projection is missing', async () => {
    const runId = uniqueMarker('invite-repair');
    const owner = createIdentity('repair-owner');
    const friend = createIdentity('repair-friend');
    const ownerClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });
    const friendClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: friend,
    });
    let roomId = '';
    onTestFinished(async () => {
      if (roomId) await ownerClient.archiveRoom(roomId).catch(() => undefined);
      ownerClient.disconnect();
      friendClient.disconnect();
    });

    const communityId = await ownerClient.createCommunity(`workspace-${runId}`);
    await ownerClient.waitUntilMember(communityId, owner.publicKey);
    roomId = await ownerClient.createChannel(`room-${runId}`, { communityId });
    const existingText = `existing-${runId}`;
    const notificationText = `notification-${runId}`;
    await ownerClient.messageSubmit(roomId, existingText);

    // Model the production divergence left by a historical or partial invite:
    // the friend belongs to the Workspace, but never reached this Room's 39002.
    await friendClient.addMember(communityId, friend.publicKey, 'member');
    await friendClient.waitUntilMember(communityId, friend.publicKey);
    expect(await friendClient.isMember(roomId, friend.publicKey)).toBe(false);

    const notificationEvent = await ownerClient.messageSubmit(roomId, notificationText);
    await waitFor(
      async () => {
        const events = await friendClient.query([
          { kinds: [9], since: notificationEvent.created_at - 1, limit: 100 },
        ]);
        return events.some((event) => event.id === notificationEvent.id);
      },
      { label: 'partial member broad recipient-scoped query sees notification event' },
    );

    const beforeMemberships = await friendClient.listMyChannels();
    const beforeBackfill = await friendClient.sessionEventsBackfill(roomId, { limit: 100 });
    const beforeListed = beforeMemberships.some(({ channelId }) => channelId === roomId);
    const beforeExisting = beforeBackfill.some((event) => event.content === existingText);
    const beforeNotification = beforeBackfill.some((event) => event.id === notificationEvent.id);
    console.log(
      `[live-invite-repair-before] workspace=${communityId} room=${roomId} ` +
        `friend=${friend.publicKey.slice(0, 12)} listed=${beforeListed} existing=${beforeExisting} ` +
        `notification=${beforeNotification} backfill=${beforeBackfill.length}`,
    );

    const communities = await friendClient.listCommunities();
    expect(communities.map((community) => community.communityId)).toContain(communityId);

    const afterMemberships = await friendClient.listMyChannels();
    const afterBackfill = await friendClient.sessionEventsBackfill(roomId, { limit: 100 });
    const afterListed = afterMemberships.some(({ channelId }) => channelId === roomId);
    const afterExisting = afterBackfill.some((event) => event.content === existingText);
    const afterNotification = afterBackfill.some((event) => event.id === notificationEvent.id);
    console.log(
      `[live-invite-repair-after] workspace=${communityId} room=${roomId} ` +
        `friend=${friend.publicKey.slice(0, 12)} listed=${afterListed} existing=${afterExisting} ` +
        `notification=${afterNotification} backfill=${afterBackfill.length}`,
    );
    expect(afterMemberships.map(({ channelId }) => channelId)).toContain(roomId);
    expect(afterBackfill.map((event) => event.content)).toEqual(
      expect.arrayContaining([existingText, notificationText]),
    );
  }, 90_000);
});

describe.runIf(!reachable)('live late Workspace invitee Room visibility (skipped)', () => {
  it('soft-skips when relay is unreachable', () => {
    console.log(`[live-invite-visibility] SKIP relay unreachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
