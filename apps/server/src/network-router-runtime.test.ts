import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { createNetworkRouterRuntime } from './network-router-runtime.js';
import { networkRouterEnabled } from './network-router-rollout.js';
import { helperActivationEnabled } from './helper-activation.js';
import { helperOverlayEnabled } from './helper-overlay.js';
import { helperUsageEnabled } from './helper-usage.js';
import { turnOwnershipEnabled } from './turn-ownership.js';
import { memberStreamEnabled } from './rooms-mcp-stream.js';
afterEach(() => vi.unstubAllEnvs());
describe('universal production router admission', () => {
  it.each([undefined, '1', '0'])('shares the default and rollback across every consumer (%s)', async setting => {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', setting);
    const enabled = setting !== '0';
    for (const read of [networkRouterEnabled, helperActivationEnabled, helperOverlayEnabled, helperUsageEnabled, turnOwnershipEnabled, memberStreamEnabled]) expect(read()).toBe(enabled);
    const query = vi.fn(async () => { throw new Error('Composition must not access data'); });
    const database = { query, transaction: vi.fn() } as unknown as SqlDatabase;
    let ready = false;
    const router = createNetworkRouterRuntime({ database, jobsDatabase: database, live: new LiveHub(),
      instanceId: 'activation-test', publicOrigin: 'https://synthetic.invalid', listenerReady: () => ready,
      wake: vi.fn(), retireOwner: vi.fn() });
    if (enabled) {
      expect(router?.policy.families).toEqual(ROUTER_FAMILIES);
      expect(router?.policy).toMatchObject({ needsYouRoomsV1: true, commandDedupV1: true,
        roomHeadContinuityV1: true, scheduledWorkCoverageV1: true });
      expect(router?.mediaMetadataV1).toBe(true);
      expect(router?.policy.listenerReady()).toBe(false);
      ready = true; expect(router?.policy.listenerReady()).toBe(true);
      await router?.close();
    } else expect(router).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
