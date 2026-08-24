import { describe, expect, it } from 'vitest';
import { loadPushGatewayConfig } from './config.js';

describe('loadPushGatewayConfig', () => {
  it('configures the trusted recipient-scoped query feed', () => {
    expect(
      loadPushGatewayConfig({
        BUZZY_RELAY_URL: 'http://127.0.0.1:3410',
        BUZZY_RELAY_HOST: 'usebeeline.app',
      }),
    ).toMatchObject({
      queryRelayUrl: 'http://127.0.0.1:3410',
      relayHost: 'usebeeline.app',
      deliveryStateFile: '.data/deliveries.json',
      feedHeartbeatIntervalMs: 60_000,
    });
  });

  it('keeps the existing single-origin development defaults', () => {
    expect(loadPushGatewayConfig({})).toMatchObject({
      queryRelayUrl: 'http://127.0.0.1:3010',
      relayHost: '127.0.0.1:3010',
      host: '127.0.0.1',
      port: 8788,
      deliveryStateFile: '.data/deliveries.json',
      feedHeartbeatIntervalMs: 60_000,
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
