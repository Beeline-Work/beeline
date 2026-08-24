import { describe, expect, it } from 'vitest';
import { loadPushGatewayConfig } from './config.js';

describe('loadPushGatewayConfig', () => {
  it('configures the authoritative Postgres feed', () => {
    expect(
      loadPushGatewayConfig({
        BUZZY_PUSH_DATABASE_URL: 'postgres://buzz@postgres:5432/buzz',
      }),
    ).toMatchObject({
      databaseUrl: 'postgres://buzz@postgres:5432/buzz',
      deliveryStateFile: '.data/deliveries.json',
      feedHeartbeatIntervalMs: 60_000,
    });
  });

  it('accepts DATABASE_URL and fails fast when no database is reachable by configuration', () => {
    expect(
      loadPushGatewayConfig({ DATABASE_URL: 'postgres://buzz@127.0.0.1:5433/buzz' }),
    ).toMatchObject({
      databaseUrl: 'postgres://buzz@127.0.0.1:5433/buzz',
      host: '127.0.0.1',
      port: 8788,
      deliveryStateFile: '.data/deliveries.json',
      feedHeartbeatIntervalMs: 60_000,
    });
    expect(() => loadPushGatewayConfig({})).toThrow('set BUZZY_PUSH_DATABASE_URL or DATABASE_URL');
  });

  it('places delivery state beside a custom registry unless explicitly overridden', () => {
    expect(
      loadPushGatewayConfig({
        DATABASE_URL: 'postgres://test',
        BUZZY_PUSH_REGISTRY_FILE: '/srv/push/registrations.json',
      }),
    ).toMatchObject({ deliveryStateFile: '/srv/push/deliveries.json' });
    expect(
      loadPushGatewayConfig({
        DATABASE_URL: 'postgres://test',
        BUZZY_PUSH_REGISTRY_FILE: '/srv/push/registrations.json',
        BUZZY_PUSH_DELIVERY_STATE_FILE: '/durable/dedup.json',
      }),
    ).toMatchObject({ deliveryStateFile: '/durable/dedup.json' });
  });
});
