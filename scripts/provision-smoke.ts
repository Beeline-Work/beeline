#!/usr/bin/env node
/**
 * Provision a Buzz identity + channel + marker message for the emulator smoke test.
 */
import { createBuzzClient, createIdentity, identityNsec, identityNpub } from '@buzzy/buzz-client';

const RELAY = process.env.RELAY_URL || 'https://buzz.trustysquire.ai';

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

  // 3. Create a channel
  const channelId = await client.createChannel('Buzzy Smoke Test');
  console.log('Channel created:', channelId);

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

  client.disconnect();
}

main().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
