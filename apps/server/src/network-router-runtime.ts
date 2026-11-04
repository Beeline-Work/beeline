import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import type { LeaderConnection } from './background-leader.js';
import { BackgroundOwnership } from './background-ownership.js';
import type { LiveHub } from './live.js';
import { RouterBuildCoordinator } from './router-build-coordinator.js';
import type { RouterProjectionPolicy } from './router-socket.js';
import { TrayClockAvailability } from './tray-clock-availability.js';
import { TrayClockWork } from './tray-clock-work.js';

/** Production composition, shared by all sockets. No cohort or identity filter.
 * The existing leader, aggregate lease and committed listener own its lifetime. */
export function createNetworkRouterRuntime(options: {
  database: SqlDatabase;
  jobsDatabase: SqlDatabase & { onRecovery?(listener: () => void): () => void };
  live: LiveHub;
  instanceId: string;
  publicOrigin: string;
  listenerReady: () => boolean;
  wake: () => void;
  retireOwner: (connection: LeaderConnection) => void;
}) {
  const { database, jobsDatabase, live, listenerReady } = options;
  const coordinator = new RouterBuildCoordinator();
  const availability = new TrayClockAvailability(database, live, { listenerReady, unavailable: () => {} });
  const work = new TrayClockWork(jobsDatabase, live, new BackgroundOwnership(jobsDatabase, options.instanceId), {
    listenerReady, wake: options.wake, retireOwner: options.retireOwner,
    unavailable: () => { live.trayClockUnavailable(); },
  });
  const policy: RouterProjectionPolicy = {
    families: ROUTER_FAMILIES, listenerReady, trayClockAvailability: availability,
    needsYouRoomsV1: true, commandDedupV1: true, roomHeadContinuityV1: true,
    scheduledWorkCoverageV1: true,
    sharedBuilds: { coordinator, basis: {
      schema: 1, databaseScope: options.instanceId, version: 'router-production-v1',
      publicOrigin: options.publicOrigin, clockVersion: 'stored-fields-v1',
    } },
  };
  return {
    policy, mediaMetadataV1: true as const, work,
    start: () => availability.start(),
    async close() { await work.close(); await availability.close(); coordinator.clear(); },
  };
}
