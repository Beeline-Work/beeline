import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { createBuzzClient, createIdentity } from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import { PushGateway } from './gateway.js';
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

  const gateway = new PushGateway(relayClient, registry, getMessaging(firebaseApp));
  const queryKey = createIdentity('push-gateway-query');
  const seenEvents = new Map<string, number>();
  let querySince = Math.floor(Date.now() / 1000) - 5;
  let polling = false;

  const pollRegisteredEvents = async (): Promise<void> => {
    if (polling || registry.pubkeyCount === 0) return;
    polling = true;
    const since = querySince;
    let newestCreatedAt = since;
    try {
      for (const pubkey of registry.pubkeys()) {
        // The local relay bridge authorizes reads with X-Pubkey. A query-only
        // client lets the gateway see exactly the channels of each registered
        // identity without collecting that identity's secret key.
        const reader = createBuzzClient({
          baseUrl: RELAY_URL,
          identity: { ...queryKey, publicKey: pubkey },
        });
        try {
          const events = (await reader.query([{ kinds: [9], since }])) as NostrEvent[];
          events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
          for (const event of events) {
            newestCreatedAt = Math.max(newestCreatedAt, event.created_at);
            if (seenEvents.has(event.id)) continue;
            seenEvents.set(event.id, event.created_at);
            try {
              await gateway.handleRelayEvent(event, reader);
            } catch (error) {
              seenEvents.delete(event.id);
              throw error;
            }
          }
        } finally {
          reader.disconnect();
        }
      }
      querySince = Math.max(querySince, newestCreatedAt - 1);
      const expiry = Math.floor(Date.now() / 1000) - 600;
      for (const [eventId, createdAt] of seenEvents) {
        if (createdAt < expiry) seenEvents.delete(eventId);
      }
    } finally {
      polling = false;
    }
  };

  const unsubscribe = relayClient.socket!.subscribe(
    [{ kinds: [9], since: Math.floor(Date.now() / 1000) }],
    () => {
      void pollRegisteredEvents().catch((error) => {
        console.error('[push] relay event poll failed:', error instanceof Error ? error.message : String(error));
      });
    },
    { subId: 'buzzy-push-events' },
  );
  const pollTimer = setInterval(() => {
    void pollRegisteredEvents().catch((error) => {
      console.error('[push] relay event poll failed:', error instanceof Error ? error.message : String(error));
    });
  }, POLL_INTERVAL_MS);
  void pollRegisteredEvents();

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
