import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { createNetworkRouterRuntime } from './network-router-runtime.js';
describe('universal production router admission', () => {
  it('always composes every installed family and preserves committed listener readiness', async () => {
    const query = vi.fn(async () => { throw new Error('Composition must not access data'); });
    const database = { query, transaction: vi.fn() } as unknown as SqlDatabase;
    let ready = false;
    const router = createNetworkRouterRuntime({ database, jobsDatabase: database, live: new LiveHub(),
      instanceId: 'activation-test', publicOrigin: 'https://synthetic.invalid', listenerReady: () => ready,
      wake: vi.fn(), retireOwner: vi.fn() });
      expect(router?.policy.families).toEqual(ROUTER_FAMILIES);
      expect(router?.policy).toMatchObject({ needsYouRoomsV1: true, commandDedupV1: true,
        roomHeadContinuityV1: true, scheduledWorkCoverageV1: true });
      expect(router?.mediaMetadataV1).toBe(true);
      expect(router?.policy.listenerReady()).toBe(false);
      ready = true; expect(router?.policy.listenerReady()).toBe(true);
      await router?.close();
    expect(query).not.toHaveBeenCalled();
  });
});
