import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { loadPushGatewayConfig } from './config.js';
import { PostgresEventStore } from './database.js';
import { DeliveryState } from './delivery-state.js';
import { PushEventFeed } from './feed.js';
import { PushGateway, RegisteredEventPoller } from './gateway.js';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer } from './server.js';

async function main(): Promise<void> {
  const config = loadPushGatewayConfig();
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
  const registry = await TokenRegistry.load(config.registryFile);
  const deliveryState = await DeliveryState.load(config.deliveryStateFile);
  const eventStore = new PostgresEventStore(config.databaseUrl);
  await eventStore.connect();

  const gateway = new PushGateway(registry, getMessaging(firebaseApp), deliveryState);
  let feed: PushEventFeed;
  const poller = new RegisteredEventPoller(
    registry,
    (pubkey) => eventStore.readerFor(pubkey),
    (event, recipientPubkey, reader) => {
      feed.noteEvent();
      return gateway.handleRelayEvent(event, recipientPubkey, reader);
    },
    deliveryState,
    Date.now,
  );
  feed = new PushEventFeed(poller, {
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.feedHeartbeatIntervalMs,
  });
  feed.start();

  const server = createRegistrationServer(registry, {
    sendTest: (pubkey) => gateway.sendTestNotification(pubkey),
  });
  server.listen(config.port, config.host, () => {
    console.log(
      `[push] gateway listening on http://${config.host}:${config.port}; ` +
        `feed=postgres-tail; devices=${registry.tokenCount}`,
    );
  });

  const shutdown = () => {
    feed.stop();
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
