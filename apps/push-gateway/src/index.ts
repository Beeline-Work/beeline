import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { createBuzzClient, createIdentity, queryEvents } from '@beeline/buzz-client';
import { PushGateway, RegisteredEventPoller } from './gateway.js';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer } from './server.js';

const RELAY_URL = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
const PORT = Number(process.env.PORT ?? '8788');
const HOST = process.env.BUZZY_PUSH_HOST ?? '127.0.0.1';
const REGISTRY_FILE = process.env.BUZZY_PUSH_REGISTRY_FILE ?? '.data/registrations.json';
const POLL_INTERVAL_MS = Number(process.env.BUZZY_PUSH_POLL_INTERVAL_MS ?? '1500');

async function main(): Promise<void> {
  const serviceAccountPath = process.env.BUZZY_PUSH_SA_FILE;
  if (serviceAccountPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('set GOOGLE_APPLICATION_CREDENTIALS or BUZZY_PUSH_SA_FILE');
  }

  const firebaseApp = getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: 'buzzy-e11e7',
  });
  const registry = await TokenRegistry.load(REGISTRY_FILE);
  const relayClient = createBuzzClient({
    baseUrl: RELAY_URL,
    identity: createIdentity('push-gateway'),
  });
  await relayClient.connect();

  const gateway = new PushGateway(registry, getMessaging(firebaseApp));
  const relayHttp = { baseUrl: RELAY_URL, host: new URL(RELAY_URL).host };
  const poller = new RegisteredEventPoller(
    registry,
    (pubkey) => ({
      // The gateway is co-located with the production relay and uses its
      // trusted X-Pubkey bridge to perform an ACL-scoped read. Do not point
      // this process at a public relay origin that requires a user's NIP-98 key.
      query: (filters) => queryEvents(relayHttp, filters, pubkey),
      disconnect: () => undefined,
    }),
    (event, recipientPubkey) => gateway.handleRelayEvent(event, recipientPubkey),
  );

  const pollRegisteredEvent = (): void => {
    void poller.pollNext().catch((error) => {
      console.error('[push] relay event poll failed:', error instanceof Error ? error.message : String(error));
    });
  };

  const unsubscribe = relayClient.socket!.subscribe(
    [{ kinds: [9], since: Math.floor(Date.now() / 1000) }],
    pollRegisteredEvent,
    { subId: 'buzzy-push-events' },
  );
  const pollTimer = setInterval(pollRegisteredEvent, POLL_INTERVAL_MS);
  pollRegisteredEvent();

  const server = createRegistrationServer(registry);
  server.listen(PORT, HOST, () => {
    console.log(`[push] gateway listening on http://${HOST}:${PORT}; relay=${RELAY_URL}; devices=${registry.tokenCount}`);
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
