#!/usr/bin/env node
/**
 * Fixture-only remote participant for the mobile Maestro smoke. It waits for
 * the device's real relay events, then replies through the same relay so the
 * assertions cover subscription delivery rather than preloaded transcript UI.
 */
import {
  AGENT_PRESENCE_HEARTBEAT_MS,
  createBuzzClient,
  KIND_AGENT_PRESENCE,
  KIND_CORNER_STATE,
  loadIdentityFromNsec,
  TAG_AGENT_PRESENCE,
  TAG_CORNER_STATE,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';

const [agentNsec, roomId, cornerId] = process.argv.slice(2);
const RELAY = process.env.RELAY_URL || 'https://usebeeline.app';
const FIRST_DEVICE_MESSAGE_TIMEOUT_MS = 180_000;
const FOLLOW_UP_MESSAGE_TIMEOUT_MS = 90_000;

if (!agentNsec || !roomId || !cornerId) {
  throw new Error('usage: publish-smoke-replies <agent-nsec> <room-id> <corner-id>');
}

async function waitForMessage(
  client: ReturnType<typeof createBuzzClient>,
  channelId: string,
  needle: string,
  timeoutMs = FOLLOW_UP_MESSAGE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await client.sessionEventsBackfill(channelId, { limit: 100 });
    if (events.some((event) => event.content?.includes(needle))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${needle}`);
}

/** The device event is the proof: retries must preserve one relay event id. */
async function requireExactlyOneMessage(
  client: ReturnType<typeof createBuzzClient>,
  channelId: string,
  content: string,
): Promise<void> {
  // Give an accidental second tap or resume flush enough time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const events = await client.sessionEventsBackfill(channelId, { limit: 100 });
  const matches = events.filter((event) => event.content === content);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${JSON.stringify(content)} event, found ${matches.length}`);
  }
}

async function main() {
  const identity = loadIdentityFromNsec(agentNsec, 'buzzy-smoke-agent');
  const client = createBuzzClient({
    baseUrl: RELAY,
    identity,
  });
  await client.connect();
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const publishPresence = () =>
    client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: KIND_AGENT_PRESENCE,
          tags: [
            ['d', `${TAG_AGENT_PRESENCE}:${roomId}`],
            ['h', roomId],
            ['t', TAG_AGENT_PRESENCE],
            ['agent', identity.publicKey],
            ['status', 'online'],
          ],
          content: '',
        },
        identity.secretKey,
      ),
    );
  const publishCornerWorkingState = () => {
    const stateAt = Math.floor(Date.now() / 1_000);
    return client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: stateAt,
          kind: KIND_CORNER_STATE,
          tags: [
            ['d', `${TAG_CORNER_STATE}:${cornerId}`],
            ['h', roomId],
            ['t', TAG_CORNER_STATE],
            ['state', 'working'],
            ['at', String(stateAt)],
          ],
          content: JSON.stringify({ state: 'working', at: stateAt }),
        },
        identity.secretKey,
      ),
    );
  };
  const schedulePresenceHeartbeat = () => {
    if (stopped) return;
    heartbeatTimer = setTimeout(() => {
      void publishPresence()
        .catch((error) => console.warn('Smoke presence heartbeat failed:', error))
        .finally(schedulePresenceHeartbeat);
    }, AGENT_PRESENCE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };

  try {
    await publishPresence();
    schedulePresenceHeartbeat();
    // This first wait spans onboarding and the full pre-send smoke path. Later
    // waits begin at the device action they coordinate with and stay tighter.
    await waitForMessage(client, roomId, 'SMOKE ROOM SEND', FIRST_DEVICE_MESSAGE_TIMEOUT_MS);
    await client.messageSubmit(roomId, 'SMOKE AGENT ROOM REPLY — delivered live');
    // The smoke performs a separate picker/responsiveness send before its
    // exact Beebee mention. Use that relay-backed action as the phase boundary
    // so time spent navigating and exercising the first mention cannot consume
    // the timeout for an action the device has not reached yet.
    await waitForMessage(client, roomId, 'mention picker stayed responsive');
    await waitForMessage(client, roomId, "@beebee what's up");
    await requireExactlyOneMessage(client, roomId, "@beebee what's up");
    await client.messageSubmit(roomId, "SMOKE AGENT MENTION REPLY — @beebee what's up");
    await waitForMessage(client, roomId, 'SMOKE KEYBOARD PIN TRIGGER');
    await publishCornerWorkingState();
    await client.messageSubmit(roomId, 'SMOKE AGENT KEYBOARD REPLY — newest above keyboard');
    await waitForMessage(client, roomId, 'SMOKE CORNER PHASE READY');
    await waitForMessage(client, cornerId, 'SMOKE CORNER STEER');
    await client.messageSubmit(cornerId, 'SMOKE AGENT CORNER REPLY — steering delivered live');
  } finally {
    stopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    client.disconnect();
  }
}

main().catch((error) => {
  console.error('Smoke reply fixture failed:', error);
  process.exit(1);
});
