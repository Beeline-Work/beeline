import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
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
    let ready = false;
    const router = createNetworkRouterRuntime({
      instanceId: 'activation-test', publicOrigin: 'https://synthetic.invalid', listenerReady: () => ready });
    if (enabled) {
      expect(router?.policy.families).toEqual(ROUTER_FAMILIES);
      expect(router?.policy).toMatchObject({ needsYouRoomsV1: true, commandDedupV1: true,
        roomHeadContinuityV1: true, scheduledWorkCoverageV1: true });
      expect(router?.mediaMetadataV1).toBe(true);
      expect(router?.policy.listenerReady()).toBe(false);
      ready = true; expect(router?.policy.listenerReady()).toBe(true);
      await router?.close();
    } else expect(router).toBeUndefined();
  });
});
