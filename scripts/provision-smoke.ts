#!/usr/bin/env node
/**
 * Provision a Buzz identity + Workspace-linked Room + marker message for the emulator smoke test.
 */
import { createBuzzClient, createIdentity, identityNsec, identityNpub } from '@beeline/buzz-client';

const RELAY = process.env.RELAY_URL || 'https://relay.buzzrouter.com';

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

  // 4. Post a marker message
  await client.messageSubmit(channelId, '🚀 Buzzy v0.1.0 APK smoke test — marker message');
  console.log('Marker message posted.');

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

  client.disconnect();
}

main().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
