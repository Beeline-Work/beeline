#!/usr/bin/env node
/** One-off relay fixture for the owner-required Room-update emulator capture. */
import {
  createBuzzClient,
  createIdentity,
  identityNsec,
  KIND_CORNER_STATE,
  TAG_CORNER_STATE,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';

const relay = process.env.RELAY_URL || 'https://usebeeline.app';
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_100));

async function main() {
  const maya = createIdentity('Maya');
  const alan = createIdentity('Alan');
  const clara = createIdentity('Clara');
  const mayaClient = createBuzzClient({ baseUrl: relay, identity: maya });
  const alanClient = createBuzzClient({ baseUrl: relay, identity: alan });
  const claraClient = createBuzzClient({ baseUrl: relay, identity: clara });
  await Promise.all([mayaClient.connect(), alanClient.connect(), claraClient.connect()]);

  const workspaceId = await mayaClient.createCommunity('Room update verification');
  await Promise.all([
    mayaClient.setPersonProfile(workspaceId, { name: 'Maya' }),
    alanClient.setPersonProfile(workspaceId, { name: 'Alan' }),
  ]);
  await mayaClient.addMember(workspaceId, alan.publicKey, 'member');
  await alanClient.waitUntilMember(workspaceId, alan.publicKey);
  const roomId = await mayaClient.createChannel('Launch room', { communityId: workspaceId });
  await mayaClient.messageSubmit(roomId, 'Morning — the launch checklist is ready.');

  await mayaClient.addMember(workspaceId, clara.publicKey, 'member');
  await claraClient.waitUntilMember(workspaceId, clara.publicKey);
  await claraClient.createAgent(workspaceId, { displayName: 'Clara' });
  await mayaClient.setAgentSoul(workspaceId, clara.publicKey, {
    name: 'Clara',
    soul: 'Verification fixture agent.',
    avatarSeed: 'room-update-clara',
  });
  await pause();
  await mayaClient.addMember(roomId, clara.publicKey, 'member');
  await claraClient.waitUntilMember(roomId, clara.publicKey);
  await pause();
  await claraClient.messageSubmit(roomId, 'I’ll keep the release notes concise.');

  await pause();
  const cornerId = await claraClient.createSubchannel(roomId, 'Polish release notes', {
    communityId: workspaceId,
  });
  await pause();
  await mayaClient.messageSubmit(roomId, 'Perfect. Ship it when the review is green.');
  const tip = '4f3c2a1b9d8e7f60514233221100ffeeddccbbaa';
  await pause();
  await claraClient.messageSubmit(
    roomId,
    'Merge summary\n\nPolished release notes and added focused transcript regression coverage.',
    {
      extraTags: [
        ['t', 'merge-summary'],
        ['subchannel', cornerId],
        ['branch', 'main'],
        ['tip', tip],
      ],
    },
  );
  await pause();
  const closedAt = Math.floor(Date.now() / 1_000);
  await claraClient.publish(
    signEvent(
      {
        pubkey: clara.publicKey,
        created_at: closedAt,
        kind: KIND_CORNER_STATE,
        tags: [
          ['d', `${TAG_CORNER_STATE}:${cornerId}`],
          ['h', roomId],
          ['t', TAG_CORNER_STATE],
          ['state', 'closed'],
          ['at', String(closedAt)],
        ],
        content: '',
      },
      clara.secretKey,
    ),
  );

  console.log(`VERIFY_NSEC=${identityNsec(maya)}`);
  console.log(`VERIFY_ROOM_ID=${roomId}`);
  mayaClient.disconnect();
  alanClient.disconnect();
  claraClient.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
