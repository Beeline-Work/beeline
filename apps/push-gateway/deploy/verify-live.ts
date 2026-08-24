import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBuzzClient,
  createChannel,
  createIdentity,
  type Identity,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';
import type { BatchResponse, Messaging, MulticastMessage } from 'firebase-admin/messaging';
import { PostgresEventStore } from '../src/database.js';
import { DeliveryState } from '../src/delivery-state.js';
import { PushGateway, RegisteredEventPoller, type RelayEventReader } from '../src/gateway.js';
import { TokenRegistry } from '../src/registry.js';

const publicRelayUrl =
  process.env.BUZZY_RELAY_PUBLIC_URL ??
  process.env.BUZZY_RELAY_SUBSCRIPTION_URL ??
  'https://usebeeline.app';
const relayHost = process.env.BUZZY_RELAY_HOST ?? 'usebeeline.app';
const databaseUrl = process.env.BUZZY_PUSH_DATABASE_URL ?? process.env.DATABASE_URL;

function client(identity: Identity) {
  return createBuzzClient({ baseUrl: publicRelayUrl, host: relayHost, identity });
}

async function main(): Promise<void> {
  if (!databaseUrl) throw new Error('set BUZZY_PUSH_DATABASE_URL or DATABASE_URL');
  const eventStore = new PostgresEventStore(databaseUrl);
  await eventStore.connect();
  const reader = (pubkey: string): RelayEventReader => eventStore.readerFor(pubkey);

  const marker = randomUUID().slice(0, 8);
  const sender = createIdentity(`push-sender-${marker}`);
  const recipient = createIdentity(`push-recipient-${marker}`);
  const outsider = createIdentity(`push-outsider-${marker}`);
  const senderClient = client(sender);
  const workspaceName = `Capture Isolation ${marker}`;
  const roomName = `Persistent Product Room ${marker}`;
  const fixtureRoomName = `research-no-findings-${marker}`;
  const senderName = `Push Tester ${marker}`;
  const messageText = `Private push proof ${marker}`;
  let realChannelId = '';
  let fixtureChannelId = '';

  try {
    const communityId = await senderClient.createCommunity(workspaceName);
    await senderClient.addMember(communityId, recipient.publicKey, 'member');
    await senderClient.waitUntilMember(communityId, recipient.publicKey, { timeoutMs: 15_000 });
    const channelContext = {
      identity: sender,
      http: { baseUrl: publicRelayUrl, host: relayHost, identity: sender },
    };
    realChannelId = await createChannel(channelContext, roomName, {
      communityId,
      visibility: 'private',
      repository: {
        key: `capture/real-${marker}`,
        name: `real-${marker}`,
        localOnly: false,
      },
    });
    fixtureChannelId = await createChannel(channelContext, fixtureRoomName, {
      communityId,
      visibility: 'private',
      repository: {
        key: `capture/${fixtureRoomName}`,
        name: fixtureRoomName,
        localOnly: false,
      },
    });
    await senderClient.waitUntilMember(realChannelId, recipient.publicKey, {
      timeoutMs: 15_000,
    });
    await senderClient.waitUntilMember(fixtureChannelId, recipient.publicKey, {
      timeoutMs: 15_000,
    });

    const workspaceMembers = await senderClient.communityMembers(communityId);
    const expectedMembers = new Set([sender.publicKey, recipient.publicKey]);
    if (
      workspaceMembers.length !== expectedMembers.size ||
      workspaceMembers.some((member) => !expectedMembers.has(member.pubkey))
    ) {
      throw new Error('test identity isolation failed: unexpected Workspace member');
    }

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
    const fixtureEvent = await senderClient.messageSubmit(
      fixtureChannelId,
      `Fixture message that must never reach FCM ${marker}`,
    );
    const messageEvent = await senderClient.messageSubmit(realChannelId, messageText);

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
    const runPoll = async (state: DeliveryState, count: number): Promise<PushGateway> => {
      const gateway = new PushGateway(registry, messaging, state);
      const poller = new RegisteredEventPoller(
        registry,
        () => reader(recipient.publicKey),
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
        `fixture/duplicate poll proof failed: expected one real FCM payload, got ${captured.length}`,
      );
    }
    if (captured[0]?.data?.channelId !== realChannelId) {
      throw new Error('fixture suppression proof failed: captured payload was not the real Room');
    }

    const restartedState = await DeliveryState.load(deliveryStateFile);
    await runPoll(restartedState, 1);
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
        feed: 'postgres-tail',
        publicRelay: publicRelayUrl,
        event: messageEvent.id.slice(0, 12),
        acl: { recipient: recipientEvents.length, outsider: outsiderEvents.length },
        publicRelayUnauthenticatedQueryStatus: unauthenticatedPublicQuery.status,
        fcmPayloadCount: captured.length,
        fixture: { roomName: fixtureRoomName, fcmPayloadCount: 0 },
        real: { roomName, fcmPayloadCount: 1 },
        dedup: { firstPoll: 1, duplicatePollAdditional: 0, restartReplayAdditional: 0 },
        notification: payload.notification,
        roomName: payload.data?.roomName,
      }),
    );
  } finally {
    if (fixtureChannelId) await senderClient.archiveRoom(fixtureChannelId).catch(() => undefined);
    if (realChannelId) await senderClient.archiveRoom(realChannelId).catch(() => undefined);
    senderClient.disconnect();
    await eventStore.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
