/**
 * Live community proof against the real Buzz relay:
 * create community → linked channel → mint invite → redeem as identity B →
 * identity B becomes a direct channel member and publishes a message that the
 * owner reads from the existing channel.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createBuzzClient, createIdentity } from '@beeline/buzz-client';
import { BASE_URL, HOST } from './config.js';

const RELAY_PROBE_MS = 2500;

async function relayReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(RELAY_PROBE_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const reachable = await relayReachable();

(reachable ? describe : describe.skip)('live community + invite relay flow', () => {
  beforeAll(() => {
    console.log(`[live-community] relay reachable at ${BASE_URL} — running suite`);
  });

  it('invitee joins and steers an existing community channel', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = createIdentity('community-owner');
    const joiner = createIdentity('community-joiner');
    const ownerClient = createBuzzClient({ baseUrl: BASE_URL, host: HOST, identity: owner });
    const joinerClient = createBuzzClient({ baseUrl: BASE_URL, host: HOST, identity: joiner });

    const communityId = await ownerClient.createCommunity(`community-${runId}`);
    await ownerClient.waitUntilMember(communityId, owner.publicKey);
    const channelId = await ownerClient.createChannel(`general-${runId}`, { communityId });
    const invite = await ownerClient.createInvite(communityId, { expiresInSeconds: 3600 });

    const redemption = await joinerClient.redeemInvite(invite.token);
    expect(redemption).toMatchObject({
      communityId,
      joined: true,
      alreadyMember: false,
      mintedBy: owner.publicKey,
    });

    const repeated = await joinerClient.redeemInvite(invite.token);
    expect(repeated).toMatchObject({ joined: false, alreadyMember: true });

    const communities = await joinerClient.listCommunities();
    expect(communities.map((community) => community.communityId)).toContain(communityId);
    expect(communities.find((community) => community.communityId === communityId)).toMatchObject({
      name: `community-${runId}`,
      ownerPubkey: owner.publicKey,
      createdBy: owner.publicKey,
    });

    const channels = await joinerClient.communityChannels(communityId);
    expect(channels).toContain(channelId);
    expect(await joinerClient.getChannelCommunityId(channelId)).toBe(communityId);
    await joinerClient.waitUntilMember(channelId, joiner.publicKey);

    const messageText = `steer-existing-room-${runId}`;
    const publishedMessage = await joinerClient.messageSubmit(channelId, messageText);
    expect(publishedMessage.pubkey).toBe(joiner.publicKey);

    let visibleMessage = false;
    const deadline = Date.now() + 20_000;
    while (!visibleMessage && Date.now() < deadline) {
      const events = await ownerClient.sessionEventsBackfill(channelId, { limit: 100 });
      visibleMessage = events.some(
        (event) =>
          event.id === publishedMessage.id &&
          event.pubkey === joiner.publicKey &&
          event.content === messageText,
      );
      if (!visibleMessage) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(visibleMessage).toBe(true);

    const members = await joinerClient.communityMembers(communityId);
    expect(members).toEqual(
      expect.arrayContaining([
        { pubkey: owner.publicKey, role: 'owner' },
        { pubkey: joiner.publicKey, role: 'member' },
      ]),
    );

    console.log(
      `[live-community] PASS community=${communityId} channel=${channelId} ` +
        `owner=${owner.publicKey.slice(0, 12)} joiner=${joiner.publicKey.slice(0, 12)} ` +
        `communities=${communities.length} channels=${channels.length} members=${members.length} ` +
        `message=${publishedMessage.id.slice(0, 12)}`,
    );
  }, 90_000);
});
