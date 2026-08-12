/** Live relay proof for deterministic, private, exactly-two-member DMs. */
import { describe, expect, it } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker, waitFor } from './live-helpers.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live direct messages', () => {
  it('converges both participants on one Room and refuses a third member', async () => {
    const marker = uniqueMarker('dm');
    const alice = createIdentity('dm-alice');
    const bob = createIdentity('dm-bob');
    const outsider = createIdentity('dm-outsider');
    const aliceClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: alice,
    });
    const bobClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: bob,
    });
    const outsiderClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: outsider,
    });

    const communityId = await aliceClient.createCommunity(`DM ${marker}`);
    await aliceClient.waitUntilMember(communityId, alice.publicKey);
    await aliceClient.addMember(communityId, bob.publicKey);
    await aliceClient.waitUntilMember(communityId, bob.publicKey);
    await aliceClient.addMember(communityId, outsider.publicKey);
    await aliceClient.waitUntilMember(communityId, outsider.publicKey);

    const first = await aliceClient.resolveDirectMessage(communityId, bob.publicKey);
    const reopened = await aliceClient.resolveDirectMessage(communityId, bob.publicKey);
    const fromBob = await bobClient.resolveDirectMessage(communityId, alice.publicKey);
    expect(first.created).toBe(true);
    expect(reopened.created).toBe(false);
    expect(fromBob.created).toBe(false);
    expect(reopened.directMessage.channelId).toBe(first.directMessage.channelId);
    expect(fromBob.directMessage.channelId).toBe(first.directMessage.channelId);

    const channelId = first.directMessage.channelId;
    expect((await aliceClient.listMembers(channelId)).map((member) => member.pubkey).sort()).toEqual(
      [alice.publicKey, bob.publicKey].sort(),
    );
    await expect(aliceClient.addMember(channelId, outsider.publicKey)).rejects.toThrow(
      'cannot add a third member',
    );

    await aliceClient.messageSubmit(channelId, `hello Bob ${marker}`);
    await bobClient.messageSubmit(channelId, `hello Alice ${marker}`);
    await waitFor(
      async () => {
        const contents = (await aliceClient.sessionEventsBackfill(channelId)).map(
          (event) => event.content,
        );
        return contents.includes(`hello Bob ${marker}`) && contents.includes(`hello Alice ${marker}`);
      },
      { label: 'both DM messages visible' },
    );
    expect(await aliceClient.listDirectMessages(communityId)).toHaveLength(1);
    expect(await bobClient.listDirectMessages(communityId)).toHaveLength(1);
    expect(await outsiderClient.listDirectMessages(communityId)).toHaveLength(0);
    expect(
      (await outsiderClient.sessionEventsBackfill(channelId)).map((event) => event.content),
    ).not.toContain(`hello Bob ${marker}`);
  });
});

describe.runIf(!reachable)('live direct messages (skipped — relay down)', () => {
  it('soft-skips when relay unreachable', () => expect(true).toBe(true));
});
