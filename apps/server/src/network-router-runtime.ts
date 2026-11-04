import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import { networkRouterEnabled } from './network-router-rollout.js';
import { RouterBuildCoordinator } from './router-build-coordinator.js';
import type { RouterProjectionPolicy } from './router-socket.js';

/** Production composition, shared by all sockets. No cohort or identity filter.
 * Committed listener health gates the existing socket owners. */
export function createNetworkRouterRuntime(options: {
  instanceId: string;
  publicOrigin: string;
  listenerReady: () => boolean;
}) {
  if (!networkRouterEnabled()) return undefined;
  const { listenerReady } = options;
  const coordinator = new RouterBuildCoordinator();
  const policy: RouterProjectionPolicy = {
    families: ROUTER_FAMILIES, listenerReady,
    needsYouRoomsV1: true, commandDedupV1: true, roomHeadContinuityV1: true,
    scheduledWorkCoverageV1: true,
    sharedBuilds: { coordinator, basis: {
      schema: 1, databaseScope: options.instanceId, version: 'router-production-v1',
      publicOrigin: options.publicOrigin, clockVersion: 'stored-fields-v1',
    } },
  };
  return {
    policy, mediaMetadataV1: true as const,
    async close() { coordinator.clear(); },
  };
}
