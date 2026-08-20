#!/usr/bin/env node
/**
 * Provision a Buzz identity + Workspace-linked Room + long transcript for the emulator smoke test.
 */
import {
  createBuzzClient,
  createIdentity,
  identityNsec,
  identityNpub,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';

const RELAY = process.env.RELAY_URL || 'https://usebeeline.app';

async function main() {
  // 1. Create identity and persist to env for later import
  const identity = createIdentity('buzzy-smoke');
  console.log('Identity:');
  console.log('  NSEC:', identityNsec(identity));
  console.log('  NPUB:', identityNpub(identity));
  console.log('  Pubkey:', identity.publicKey);
  console.log('');

  // 2. Connect to relay
  const client = createBuzzClient({ baseUrl: RELAY, identity });
  await client.connect();
  console.log('Connected to relay:', RELAY);

  // 3. Create the same Workspace → Room shape that the mobile list renders.
  // A fresh identity owns both records, so this remains self-contained and does
  // not need a running agent or a pre-existing relay fixture.
  const workspaceId = await client.createCommunity('Buzzy Maestro Smoke Workspace');
  const channelId = await client.createChannel('Buzzy Maestro Smoke Room', {
    communityId: workspaceId,
  });
  console.log('Workspace created:', workspaceId);
  console.log('Room created:', channelId);

  // A genuine registered agent participant gives the UI flow a mention target
  // and a current presence lease.
  const agentIdentity = createIdentity('buzzy-smoke-agent');
  const agentClient = createBuzzClient({ baseUrl: RELAY, identity: agentIdentity });
  await agentClient.connect();
  await client.addMember(workspaceId, agentIdentity.publicKey, 'member');
  await agentClient.waitUntilMember(workspaceId, agentIdentity.publicKey);
  await agentClient.createAgent(workspaceId, { displayName: 'Beebee' });
  await client.setAgentSoul(workspaceId, agentIdentity.publicKey, {
    name: 'Beebee',
    soul: 'Relay fixture. Verify mobile message delivery.',
    avatarSeed: 'smoke-beebee',
  });
  await client.addMember(channelId, agentIdentity.publicKey, 'member');
  await agentClient.waitUntilMember(channelId, agentIdentity.publicKey);
  const cornerId = await agentClient.createSubchannel(channelId, 'Smoke agent corner', {
    communityId: workspaceId,
  });
  await agentClient.messageSubmit(channelId, 'Beebee opened a corner for the smoke session.', {
    extraTags: [
      ['t', 'body-control'],
      ['subchannel', cornerId],
      ['session', 'smoke-corner-session'],
      ['agent', agentIdentity.publicKey],
      ['mode', 'edit'],
      ['status', 'working'],
    ],
  });
  await agentClient.messageSubmit(cornerId, 'I am ready for a steering message.');
  // Beebee's current lease renders a filled presence light. Add a separate
  // offline Agent so the device fixture also proves the hollow state without
  // relying on an unknown/not-yet-loaded presence record.
  const offlineAgentIdentity = createIdentity('buzzy-smoke-offline-agent');
  const offlineAgentClient = createBuzzClient({ baseUrl: RELAY, identity: offlineAgentIdentity });
  await offlineAgentClient.connect();
  await client.addMember(workspaceId, offlineAgentIdentity.publicKey, 'member');
  await offlineAgentClient.waitUntilMember(workspaceId, offlineAgentIdentity.publicKey);
  await offlineAgentClient.createAgent(workspaceId, { displayName: 'Milo' });
  await client.setAgentSoul(workspaceId, offlineAgentIdentity.publicKey, {
    name: 'Milo',
    soul: 'Offline relay fixture. Verify offline presence rendering.',
    avatarSeed: 'smoke-milo',
  });
  await client.addMember(channelId, offlineAgentIdentity.publicKey, 'member');
  await offlineAgentClient.waitUntilMember(channelId, offlineAgentIdentity.publicKey);
  const presenceAt = Math.floor(Date.now() / 1_000);
  await agentClient.publish(
    signEvent(
      {
        pubkey: agentIdentity.publicKey,
        created_at: presenceAt,
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', `${TAG_AGENT_PRESENCE}:${channelId}`],
          ['h', channelId],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', agentIdentity.publicKey],
          ['status', 'online'],
        ],
        content: '',
      },
      agentIdentity.secretKey,
    ),
  );
  await offlineAgentClient.publish(
    signEvent(
      {
        pubkey: offlineAgentIdentity.publicKey,
        created_at: presenceAt,
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', `${TAG_AGENT_PRESENCE}:${channelId}`],
          ['h', channelId],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', offlineAgentIdentity.publicKey],
          ['status', 'offline'],
        ],
        content: '',
      },
      offlineAgentIdentity.secretKey,
    ),
  );
  console.log('Agent and corner created:', cornerId);

  // 4. Post enough messages to overflow the compact emulator. This makes the
  // opening-position assertion exercise the real FlatList tail, rather than a
  // transcript where every message happens to fit on screen.
  for (let index = 1; index <= 14; index += 1) {
    await client.messageSubmit(channelId, `Smoke history ${index}: retained transcript message.`);
  }
  // Relay ordering is second-granular. Put the tail marker in the next second
  // so the chat-open assertion tests scrolling, not an arbitrary same-second
  // ordering of the seeded history.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const latestMessage = await client.messageSubmit(
    channelId,
    'SMOKE LATEST MESSAGE — chat opened at the end',
  );
  console.log('Smoke transcript posted.');

  // 5. Verify by backfilling
  const events = await client.sessionEventsBackfill(channelId, { limit: 5 });
  console.log(`Backfilled ${events.length} events:`);
  for (const e of events) {
    console.log(`  [${e.kind}] ${e.content?.slice(0, 60)}`);
  }

  console.log('\n--- Provisioning complete ---');
  console.log('Import this NSEC into the app:');
  console.log(identityNsec(identity));
  console.log('');
  console.log('Set relay URL to:', RELAY);
  console.log('');
  // Keep the human-friendly transcript above while giving the Maestro runner
  // stable values to pass through without parsing prose.
  console.log(`MAESTRO_SMOKE_NSEC=${identityNsec(identity)}`);
  console.log(`MAESTRO_SMOKE_WORKSPACE_ID=${workspaceId}`);
  console.log(`MAESTRO_SMOKE_ROOM_ID=${channelId}`);
  console.log(`MAESTRO_SMOKE_AGENT_NSEC=${identityNsec(agentIdentity)}`);
  console.log(`MAESTRO_SMOKE_CORNER_ID=${cornerId}`);
  console.log(`MAESTRO_SMOKE_LATEST_MESSAGE_ID=${latestMessage.id}`);

  client.disconnect();
  offlineAgentClient.disconnect();
  agentClient.disconnect();
}

main().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
