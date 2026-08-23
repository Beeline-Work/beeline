import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { createBuzzClient, createIdentity, queryEvents } from '@beeline/buzz-client';
import { loadPushGatewayConfig } from './config.js';
import { DeliveryState } from './delivery-state.js';
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
  const relayClient = createBuzzClient({
    baseUrl: config.subscriptionRelayUrl,
    identity: createIdentity('push-gateway'),
  });
  await relayClient.connect();

  const gateway = new PushGateway(registry, getMessaging(firebaseApp), deliveryState);
  const relayHttp = { baseUrl: config.queryRelayUrl, host: config.relayHost };
  const poller = new RegisteredEventPoller(
    registry,
    (pubkey) => ({
      // The gateway is co-located with the production relay and uses its
      // trusted X-Pubkey bridge to perform an ACL-scoped read. Do not point
      // this process at a public relay origin that requires a user's NIP-98 key.
      query: (filters) => queryEvents(relayHttp, filters, pubkey),
      disconnect: () => undefined,
    }),
    (event, recipientPubkey, reader) => gateway.handleRelayEvent(event, recipientPubkey, reader),
    deliveryState,
    Date.now,
  );

  const pollRegisteredEvent = (): void => {
    void poller.pollNext().catch((error) => {
      console.error(
        '[push] relay event poll failed:',
        error instanceof Error ? error.message : String(error),
      );
    });
  };

  const unsubscribe = relayClient.socket!.subscribe(
    [{ kinds: [9], since: Math.floor(Date.now() / 1000) }],
    pollRegisteredEvent,
    { subId: 'buzzy-push-events' },
  );
  const pollTimer = setInterval(pollRegisteredEvent, config.pollIntervalMs);
  pollRegisteredEvent();

  const server = createRegistrationServer(registry, {
    sendTest: (pubkey) => gateway.sendTestNotification(pubkey),
  });
  server.listen(config.port, config.host, () => {
    console.log(
      `[push] gateway listening on http://${config.host}:${config.port}; ` +
        `queryRelay=${config.queryRelayUrl}; subscriptionRelay=${config.subscriptionRelayUrl}; ` +
        `devices=${registry.tokenCount}`,
    );
  });

  const shutdown = () => {
    clearInterval(pollTimer);
    unsubscribe();
    relayClient.disconnect();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[push] startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
