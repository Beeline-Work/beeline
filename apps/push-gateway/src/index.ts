import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { loadEventsServiceConfig, runRepositoryEventsService } from '@beeline/body/events-service';
import { RepositoryEventsState, type EventsStateData } from '@beeline/body/events-state';
import { loadPushGatewayConfig } from './config.js';
import { PostgresMaterializerStore } from './database.js';
import { DeliveryState, type DeliveryStateFile } from './delivery-state.js';
import { PushEventFeed } from './feed.js';
import { PushGateway, RegisteredEventPoller } from './gateway.js';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer } from './server.js';
import { ChannelSnapshotStore } from './snapshot-store.js';
import { createSnapshotMaterializer } from './snapshot-materializer.js';
import { SnapshotSuccessionClient } from './succession.js';
import { startHostedRepositoryEvents } from './hosted-events.js';

async function main(): Promise<void> {
  const config = loadPushGatewayConfig();
  const registry = await TokenRegistry.load(config.registryFile);
  const materializerStore = new PostgresMaterializerStore(config.databaseUrl);
  const shutdownController = new AbortController();
  let gateway: PushGateway | undefined;
  let feed: PushEventFeed | undefined;
  let materializer: ReturnType<typeof createSnapshotMaterializer> | undefined;
  let hostedEvents: Awaited<ReturnType<typeof startHostedRepositoryEvents>> | undefined;
  let server: ReturnType<typeof createRegistrationServer> | undefined;
  let drainPromise: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      shutdownController.abort();
      materializer?.stop();
      feed?.stop();
      if (server?.listening) server.close();
      await hostedEvents?.completed.catch(() => undefined);
      await materializerStore.close();
    })();
    return drainPromise;
  };

  let pushHealth: { ok: boolean; reason?: string } = {
    ok: false,
    reason: 'firebase_initializing',
  };
  try {
    await materializerStore.connect();
    await materializerStore.migrateReservations();
    const deliveryState = await DeliveryState.load(
      materializerStore.reservation<DeliveryStateFile>('push-delivery', config.deliveryStateFile),
    );
    const snapshotStore = new ChannelSnapshotStore(materializerStore);
    await snapshotStore.migrate();
    const succession = new SnapshotSuccessionClient({
      baseUrl: config.snapshotAuthBaseUrl,
      token: config.snapshotInternalToken,
    });
    materializer = createSnapshotMaterializer(snapshotStore, succession, {
      pollIntervalMs: config.snapshotPollIntervalMs,
      burstCoalesceMs: config.snapshotBurstCoalesceMs,
    });
    await materializer.start();

    const eventsConfig = loadEventsServiceConfig();
    const eventsState = new RepositoryEventsState(
      materializerStore.reservation<EventsStateData>('repository-events', eventsConfig.stateFile),
    );
    hostedEvents = await startHostedRepositoryEvents({
      config: eventsConfig,
      state: eventsState,
      signal: shutdownController.signal,
      run: runRepositoryEventsService,
    });
    void hostedEvents.completed.catch((error) => {
      if (shutdownController.signal.aborted) return;
      console.error(
        '[events] hosted consumer failed:',
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
      void drain();
    });

    server = createRegistrationServer(registry, {
      sendTest: async (pubkey) => {
        if (!gateway) throw new Error('push delivery unavailable');
        return gateway.sendTestNotification(pubkey);
      },
      pushHealth: () => pushHealth,
      snapshot: {
        publicOrigin: config.snapshotPublicOrigin,
        readForViewer: (channelId, pubkey) => snapshotStore.readForViewer(channelId, pubkey),
        claimNip98Event: (eventId) => snapshotStore.claimNip98Event(eventId),
        status: async () => ({ ...(await snapshotStore.status()), warmed: materializer!.ready }),
      },
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.port, config.host, () => {
        server!.off('error', reject);
        resolve();
      });
    });
    console.log(
      `[materializer] server listening on http://${config.host}:${config.port}; consumers=push,events,snapshot; store=postgres`,
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
        (pubkey) => materializerStore.readerFor(pubkey),
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

    process.once('SIGINT', () => void drain());
    process.once('SIGTERM', () => void drain());
  } catch (error) {
    await drain();
    throw error;
  }
}

main().catch((error) => {
  console.error(
    '[materializer] startup failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
