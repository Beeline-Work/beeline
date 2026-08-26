import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { loadPushGatewayConfig } from './config.js';
import { PostgresEventStore } from './database.js';
import { DeliveryState } from './delivery-state.js';
import { PushEventFeed } from './feed.js';
import { PushGateway, RegisteredEventPoller } from './gateway.js';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer } from './server.js';
import { ChannelSnapshotStore } from './snapshot-store.js';
import { createSnapshotMaterializer } from './snapshot-materializer.js';
import { SnapshotSuccessionClient } from './succession.js';

async function main(): Promise<void> {
  const config = loadPushGatewayConfig();
  const registry = await TokenRegistry.load(config.registryFile);
  const deliveryState = await DeliveryState.load(config.deliveryStateFile);
  const eventStore = new PostgresEventStore(config.databaseUrl);
  await eventStore.connect();
  const snapshotStore = new ChannelSnapshotStore(eventStore);
  await snapshotStore.migrate();
  const succession = new SnapshotSuccessionClient({
    baseUrl: config.snapshotAuthBaseUrl,
    token: config.snapshotInternalToken,
  });
  const materializer = createSnapshotMaterializer(snapshotStore, succession, {
    pollIntervalMs: config.snapshotPollIntervalMs,
    burstCoalesceMs: config.snapshotBurstCoalesceMs,
  });
  await materializer.start();

  let gateway: PushGateway | undefined;
  let feed: PushEventFeed | undefined;
  let pushHealth: { ok: boolean; reason?: string } = {
    ok: false,
    reason: 'firebase_initializing',
  };
  const server = createRegistrationServer(registry, {
    sendTest: async (pubkey) => {
      if (!gateway) throw new Error('push delivery unavailable');
      return gateway.sendTestNotification(pubkey);
    },
    pushHealth: () => pushHealth,
    snapshot: {
      publicOrigin: config.snapshotPublicOrigin,
      readForViewer: (channelId, pubkey) => snapshotStore.readForViewer(channelId, pubkey),
      claimNip98Event: (eventId) => snapshotStore.claimNip98Event(eventId),
      status: async () => ({ ...(await snapshotStore.status()), warmed: materializer.ready }),
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(
    `[snapshot] server listening on http://${config.host}:${config.port}; materializer=postgres-dirty-tail`,
  );

  try {
    const serviceAccountPath = process.env.BUZZY_PUSH_SA_FILE;
    if (serviceAccountPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error('set GOOGLE_APPLICATION_CREDENTIALS or BUZZY_PUSH_SA_FILE');
    }
    const firebaseApp =
      getApps()[0] ??
      initializeApp({
        credential: applicationDefault(),
        projectId: 'buzzy-e11e7',
      });
    gateway = new PushGateway(registry, getMessaging(firebaseApp), deliveryState);
    const poller = new RegisteredEventPoller(
      registry,
      (pubkey) => eventStore.readerFor(pubkey),
      (event, recipientPubkey, reader) => {
        feed?.noteEvent();
        return gateway!.handleRelayEvent(event, recipientPubkey, reader);
      },
      deliveryState,
      Date.now,
    );
    feed = new PushEventFeed(poller, {
      pollIntervalMs: config.pollIntervalMs,
      heartbeatIntervalMs: config.feedHeartbeatIntervalMs,
    });
    feed.start();
    pushHealth = { ok: true };
    console.log(`[push] gateway ready; feed=postgres-tail; devices=${registry.tokenCount}`);
  } catch (error) {
    pushHealth = { ok: false, reason: 'firebase_unavailable' };
    console.error(
      '[push] Firebase unavailable; snapshot serving remains active:',
      error instanceof Error ? error.message : String(error),
    );
  }

  const shutdown = () => {
    materializer.stop();
    feed?.stop();
    server.close();
    void eventStore.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[push] startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
