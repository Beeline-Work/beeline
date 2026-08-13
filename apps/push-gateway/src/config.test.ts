import { describe, expect, it } from 'vitest';
import { loadPushGatewayConfig } from './config.js';

describe('loadPushGatewayConfig', () => {
  it('can split the private query origin from the public subscription origin', () => {
    expect(
      loadPushGatewayConfig({
        BUZZY_RELAY_URL: 'http://127.0.0.1:3410',
        BUZZY_RELAY_HOST: 'relay.buzzrouter.com',
        BUZZY_RELAY_SUBSCRIPTION_URL: 'https://relay.buzzrouter.com',
      }),
    ).toMatchObject({
      queryRelayUrl: 'http://127.0.0.1:3410',
      relayHost: 'relay.buzzrouter.com',
      subscriptionRelayUrl: 'https://relay.buzzrouter.com',
      deliveryStateFile: '.data/deliveries.json',
    });
  });

  it('keeps the existing single-origin development defaults', () => {
    expect(loadPushGatewayConfig({})).toMatchObject({
      queryRelayUrl: 'http://127.0.0.1:3010',
      relayHost: '127.0.0.1:3010',
      subscriptionRelayUrl: 'http://127.0.0.1:3010',
      host: '127.0.0.1',
      port: 8788,
      deliveryStateFile: '.data/deliveries.json',
    });
  });

  it('places delivery state beside a custom registry unless explicitly overridden', () => {
    expect(
      loadPushGatewayConfig({ BUZZY_PUSH_REGISTRY_FILE: '/srv/push/registrations.json' }),
    ).toMatchObject({ deliveryStateFile: '/srv/push/deliveries.json' });
    expect(
      loadPushGatewayConfig({
        BUZZY_PUSH_REGISTRY_FILE: '/srv/push/registrations.json',
        BUZZY_PUSH_DELIVERY_STATE_FILE: '/durable/dedup.json',
      }),
    ).toMatchObject({ deliveryStateFile: '/durable/dedup.json' });
  });
});
