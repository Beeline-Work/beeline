import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuzzClient, createIdentity, queryEvents, type Identity } from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';
import type { BatchResponse, Messaging, MulticastMessage } from 'firebase-admin/messaging';
import { DeliveryState } from '../src/delivery-state.js';
import { PushGateway, RegisteredEventPoller, type RelayEventReader } from '../src/gateway.js';
import { TokenRegistry } from '../src/registry.js';

const publicRelayUrl = process.env.BUZZY_RELAY_SUBSCRIPTION_URL ?? 'https://relay.buzzrouter.com';
const privateRelayUrl = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3410';
const relayHost = process.env.BUZZY_RELAY_HOST ?? 'relay.buzzrouter.com';

function client(identity: Identity) {
  return createBuzzClient({ baseUrl: publicRelayUrl, host: relayHost, identity });
}

function reader(pubkey: string): RelayEventReader {
  return {
    query: (filters) => queryEvents({ baseUrl: privateRelayUrl, host: relayHost }, filters, pubkey),
    disconnect: () => undefined,
  };
}

async function main(): Promise<void> {
  if (privateRelayUrl.includes('127.0.0.1:3010')) {
    throw new Error('refusing local test relay');
  }

  const marker = randomUUID().slice(0, 8);
  const sender = createIdentity(`push-sender-${marker}`);
  const recipient = createIdentity(`push-recipient-${marker}`);
  const outsider = createIdentity(`push-outsider-${marker}`);
  const senderClient = client(sender);
  const roomName = `Push Proof ${marker}`;
  const senderName = `Push Tester ${marker}`;
  const messageText = `Private push proof ${marker}`;
  let channelId = '';

  try {
    channelId = await senderClient.createChannel(roomName, { visibility: 'private' });
    await senderClient.addMember(channelId, recipient.publicKey, 'member');
    await senderClient.waitUntilMember(channelId, recipient.publicKey, { timeoutMs: 15_000 });

    const profile = signEvent(
      {
        pubkey: sender.publicKey,
        created_at: Math.floor(Date.now() / 1_000),
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: senderName }),
      },
      sender.secretKey,
    );
    await senderClient.publish(profile);
    const messageEvent = await senderClient.messageSubmit(channelId, messageText);

    const filter = [{ ids: [messageEvent.id] }];
    const recipientEvents = await reader(recipient.publicKey).query(filter);
    const outsiderEvents = await reader(outsider.publicKey).query(filter);
    if (recipientEvents.length !== 1 || outsiderEvents.length !== 0) {
      throw new Error(
        `ACL proof failed: recipient=${recipientEvents.length} outsider=${outsiderEvents.length}`,
      );
    }

    const unauthenticatedPublicQuery = await fetch(`${publicRelayUrl}/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: relayHost,
        'x-pubkey': recipient.publicKey,
      },
      body: JSON.stringify(filter),
    });
    if (unauthenticatedPublicQuery.status !== 401) {
      throw new Error(
        `public relay auth proof failed: expected HTTP 401, got ${unauthenticatedPublicQuery.status}`,
      );
    }

    const registry = await TokenRegistry.load();
    await registry.register(recipient.publicKey, `throwaway-capture-only-${marker}-not-fcm`);
    const captured: MulticastMessage[] = [];
    const messaging = {
      sendEachForMulticast: async (message: MulticastMessage): Promise<BatchResponse> => {
        captured.push(message);
        return {
          successCount: 1,
          failureCount: 0,
          responses: [{ success: true }],
        };
      },
    } as unknown as Messaging;

    const directory = await mkdtemp(join(tmpdir(), 'buzzy-push-live-proof-'));
    const deliveryStateFile = join(directory, 'deliveries.json');
    const replayingReader = (): RelayEventReader => ({
      query: async (filters) => {
        const isRegisteredEventPoll =
          filters.length === 2 &&
          (filters[0]?.kinds as number[] | undefined)?.includes(9) &&
          (filters[1]?.kinds as number[] | undefined)?.includes(30078);
        return isRegisteredEventPoll ? [messageEvent] : reader(recipient.publicKey).query(filters);
      },
      disconnect: () => undefined,
    });
    const runPoll = async (state: DeliveryState, count: number): Promise<PushGateway> => {
      const gateway = new PushGateway(registry, messaging, state);
      const poller = new RegisteredEventPoller(
        registry,
        replayingReader,
        (event, pubkey, scopedReader) => gateway.handleRelayEvent(event, pubkey, scopedReader),
        state,
        Date.now,
      );
      for (let index = 0; index < count; index += 1) await poller.pollNext();
      return gateway;
    };

    const firstState = await DeliveryState.load(deliveryStateFile);
    await runPoll(firstState, 2);
    if (captured.length !== 1) {
      throw new Error(
        `duplicate poll proof failed: expected one FCM payload, got ${captured.length}`,
      );
    }

    const restartedState = await DeliveryState.load(deliveryStateFile);
    const restartedGateway = await runPoll(restartedState, 1);
    await restartedGateway.handleRelayEvent(messageEvent, recipient.publicKey, replayingReader());
    if (captured.length !== 1) {
      throw new Error(
        `restart/replay proof failed: expected one FCM payload, got ${captured.length}`,
      );
    }
    const payload = captured[0]!;
    if (
      payload.notification?.title !== senderName ||
      payload.notification?.body !== messageText ||
      payload.data?.roomName !== roomName
    ) {
      throw new Error(`incorrect captured notification: ${JSON.stringify(payload.notification)}`);
    }

    console.log(
      JSON.stringify({
        ok: true,
        deliveryMode: 'captured-no-fcm-network-call',
        queryRelay: privateRelayUrl,
        publicRelay: publicRelayUrl,
        event: messageEvent.id.slice(0, 12),
        acl: { recipient: recipientEvents.length, outsider: outsiderEvents.length },
        publicRelayUnauthenticatedQueryStatus: unauthenticatedPublicQuery.status,
        fcmPayloadCount: captured.length,
        dedup: { firstPoll: 1, duplicatePollAdditional: 0, restartReplayAdditional: 0 },
        notification: payload.notification,
        roomName: payload.data?.roomName,
      }),
    );
  } finally {
    if (channelId) await senderClient.archiveRoom(channelId).catch(() => undefined);
    senderClient.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
