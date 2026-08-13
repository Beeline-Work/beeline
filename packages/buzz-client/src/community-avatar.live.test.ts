import { describe, expect, it } from 'vitest';
import { verifyEvent } from '@beeline/nostr';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { KIND_CHANNEL_METADATA, KIND_EDIT_METADATA, TAG_COMMUNITY } from './kinds.js';
import { tagValue } from './parse.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker } from './live-helpers.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live Workspace picture projection', () => {
  it('projects admin-authored picture metadata to every Workspace member', async () => {
    const runId = uniqueMarker('workspace-avatar');
    const owner = createIdentity('workspace-avatar-owner');
    const admin = createIdentity('workspace-avatar-admin');
    const member = createIdentity('workspace-avatar-member');
    const ownerClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });
    const adminClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: admin,
    });
    const memberClient = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: member,
    });

    const communityId = await ownerClient.createCommunity(`Workspace picture ${runId}`);
    await ownerClient.waitUntilMember(communityId, owner.publicKey, { timeoutMs: 15_000 });
    await ownerClient.addMember(communityId, admin.publicKey, 'admin');
    await ownerClient.addMember(communityId, member.publicKey, 'member');
    await ownerClient.waitUntilMember(communityId, admin.publicKey, { timeoutMs: 15_000 });
    await ownerClient.waitUntilMember(communityId, member.publicKey, { timeoutMs: 15_000 });

    const avatar = `https://media.example.test/${runId}.png`;
    await expect(adminClient.setCommunityAvatar(communityId, avatar)).resolves.toMatchObject({
      communityId,
      avatar,
      ownerPubkey: owner.publicKey,
    });
    await expect(memberClient.getCommunity(communityId)).resolves.toMatchObject({
      communityId,
      avatar,
      ownerPubkey: owner.publicKey,
    });
    await expect(
      memberClient.setCommunityAvatar(
        communityId,
        `https://media.example.test/${runId}-unauthorized.png`,
      ),
    ).rejects.toThrow('only a Workspace owner or admin');

    const records = await memberClient.query([
      { kinds: [KIND_CHANNEL_METADATA], '#d': [communityId], limit: 20 },
    ]);
    const pictureRecord = records.find(
      (event) => tagValue(event, 'purpose') === `buzz-workspace-avatar:${avatar}`,
    );
    expect(pictureRecord).toBeDefined();
    expect(verifyEvent(pictureRecord!)).toBe(true);
    expect(tagValue(pictureRecord!, 'd')).toBe(communityId);

    const commands = await memberClient.query([
      { kinds: [KIND_EDIT_METADATA], '#h': [communityId], limit: 20 },
    ]);
    const authenticatedCommand = commands.find((event) => tagValue(event, 'avatar') === avatar);
    expect(authenticatedCommand).toBeDefined();
    expect(verifyEvent(authenticatedCommand!)).toBe(true);
    expect(authenticatedCommand!.pubkey).toBe(admin.publicKey);
    expect(tagValue(authenticatedCommand!, TAG_COMMUNITY)).toBe(communityId);

    console.log(
      `[live] Workspace picture OK workspace=${communityId} command=${authenticatedCommand!.id} projection=${pictureRecord!.id} avatar=${avatar}`,
    );
  });
});

describe.runIf(!reachable)('live Workspace picture projection (skipped, relay down)', () => {
  it('soft-skips when relay unreachable', () => {
    console.log(`[live] SKIP Workspace picture: relay not reachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
