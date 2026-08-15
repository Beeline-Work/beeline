#!/usr/bin/env node
/**
 * Fixture-only remote participant for the mobile Maestro smoke. It waits for
 * the device's real relay events, then replies through the same relay so the
 * assertions cover subscription delivery rather than preloaded transcript UI.
 */
import { createBuzzClient, loadIdentityFromNsec } from '@beeline/buzz-client';

const [agentNsec, roomId, cornerId] = process.argv.slice(2);
const RELAY = process.env.RELAY_URL || 'https://relay.buzzrouter.com';

if (!agentNsec || !roomId || !cornerId) {
  throw new Error('usage: publish-smoke-replies <agent-nsec> <room-id> <corner-id>');
}

async function waitForMessage(
  client: ReturnType<typeof createBuzzClient>,
  channelId: string,
  needle: string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const events = await client.sessionEventsBackfill(channelId, { limit: 100 });
    if (events.some((event) => event.content?.includes(needle))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${needle}`);
}

async function main() {
  const client = createBuzzClient({
    baseUrl: RELAY,
    identity: loadIdentityFromNsec(agentNsec, 'buzzy-smoke-agent'),
  });
  await client.connect();
  await waitForMessage(client, roomId, 'SMOKE ROOM SEND');
  await client.messageSubmit(roomId, 'SMOKE AGENT ROOM REPLY — delivered live');
  await waitForMessage(client, cornerId, 'SMOKE CORNER STEER');
  await client.messageSubmit(cornerId, 'SMOKE AGENT CORNER REPLY — steering delivered live');
  client.disconnect();
}

main().catch((error) => {
  console.error('Smoke reply fixture failed:', error);
  process.exit(1);
});
