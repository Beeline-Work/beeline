/**
 * Live verification script for Buzz mobile wire (P1).
 *
 * 1. Creates a fresh identity key A (simulating what the phone generates).
 * 2. Creates a channel (out-of-band, as if by buzzy's backend).
 * 3. Sends several messages to that channel.
 * 4. Prints the channel id + nsec so the verification transcript is self-documenting.
 *
 * Usage: npx tsx scripts/live-verify.ts
 */
import {
  createIdentity,
  createBuzzClient,
  identityNsec,
  identityNpub,
} from '@buzzy/buzz-client';

const RELAY_URL = 'http://127.0.0.1:3010';

async function main() {
  console.log('=== Buzzy P1 Live Verification Setup ===\n');
  console.log(`Relay: ${RELAY_URL}\n`);

  // (a) Create identity A — simulating phone-side key generation
  const identityA = createIdentity('verify-user-A');
  console.log(`Identity A created:`);
  console.log(`  npub: ${identityNpub(identityA)}`);
  const nsecA = identityNsec(identityA);
  console.log(`  nsec: ${nsecA}`);
  console.log(`  (paste this nsec into the phone onboarding)\n`);

  const clientA = createBuzzClient({
    baseUrl: RELAY_URL,
    identity: identityA,
  });

  // Create a channel
  const channelName = `verify-channel-${Date.now()}`;
  const channelId = await clientA.createChannel(channelName);
  console.log(`Channel created:`);
  console.log(`  name: ${channelName}`);
  console.log(`  id: ${channelId}\n`);

  // Wait for membership to materialize
  const members = await clientA.listMembers(channelId);
  console.log(`Members in channel: ${members.length} (expected >= 1)\n`);

  // (c) Send several messages out-of-band
  const messages = [
    'Hello from the out-of-band setup!',
    'This is message 2 — the phone should see this live.',
    'Agent, please analyze the project structure.',
  ];
  for (const msg of messages) {
    const ev = await clientA.messageSubmit(channelId, msg);
    console.log(`Published message: "${msg}"`);
    console.log(`  event id: ${ev.id}\n`);
  }

  console.log('=== Setup complete ===');
  console.log('');
  console.log('Now open Expo web, paste the nsec above, and verify:');
  console.log('(a) Identity A loaded → channel list shows verify-channel');
  console.log('(b) The verify-channel is visible in the list');
  console.log('(c) The three published messages appear LIVE in the chat');
  console.log('(d) Type a message in the input and press Send — verify on relay via query');
  console.log('');
  console.log(`Channel ID for reference: ${channelId}`);
  console.log(`Nsec for import: ${nsecA}`);

  // (d) Also set up a second identity to verify the sent message arrives
  const identityB = createIdentity('verify-user-B');
  const clientB = createBuzzClient({
    baseUrl: RELAY_URL,
    identity: identityB,
  });
  await clientA.addMember(channelId, identityB.publicKey, 'member');

  console.log(`\nIdentity B (monitor) created to verify relay state:`);
  console.log(`  npub: ${identityNpub(identityB)}`);
  console.log(`  Added as member of channel ${channelId}\n`);

  // Wait a beat for membership to materialize
  await new Promise((r) => setTimeout(r, 2000));

  // Query latest messages from the channel
  const backfill = await clientB.sessionEventsBackfill(channelId, { limit: 10 });
  console.log(`Backfill shows ${backfill.length} messages (expected >= 3):`);
  for (const ev of backfill) {
    console.log(`  [${new Date(ev.createdAt * 1000).toISOString()}] ${ev.content}`);
  }

  // Keep running for live subscribe demo
  console.log('\nLive subscribe test — waiting 10s for any new messages...');

  const clientC = createBuzzClient({
    baseUrl: RELAY_URL,
    identity: identityB,
  });
  await clientC.connect();
  const unsub = await clientC.sessionEventsSubscribe(channelId, (ev) => {
    if (ev.kind === 'message') {
      console.log(`LIVE: [${new Date(ev.createdAt * 1000).toISOString()}] ${ev.content}`);
    }
  });

  // Publish one more message from identity A via the verify script to show live delivery
  const liveMsg = await clientA.messageSubmit(channelId, 'This is a LIVE message sent after subscribe!');
  console.log(`Published live test message: "${liveMsg.content ?? liveMsg.id}"`);

  await new Promise((r) => setTimeout(r, 2000));
  unsub();
  clientC.disconnect();

  console.log('\n=== Live verification of publish success ===');
  console.log(`Event ID: ${liveMsg.id}`);
  console.log(`Relay URL: ${RELAY_URL}`);

  // Cleanup
  clientA.disconnect();
  clientB.disconnect();

  // Print final reference for the PR
  console.log('\n--- PR EVIDENCE (paste into PR body) ---');
  console.log(`Relay: ${RELAY_URL}`);
  console.log(`Channel ID: ${channelId}`);
  console.log(`Channel name: ${channelName}`);
  console.log(`Nsec for import: ${nsecA}`);
  console.log(`Npub: ${identityNpub(identityA)}`);
  console.log(`Messages published: ${messages.length + 1} (including live test)`);
  console.log(`Backfill count from reader: ${backfill.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});