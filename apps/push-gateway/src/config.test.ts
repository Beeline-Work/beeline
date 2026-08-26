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
      snapshotPublicOrigin: 'http://127.0.0.1:8788',
      snapshotAuthBaseUrl: 'http://127.0.0.1:8789',
    });
  });

  it('requires exact HTTPS snapshot/auth boundaries in production', () => {
    expect(
      loadPushGatewayConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://test',
        BUZZY_SNAPSHOT_PUBLIC_ORIGIN: 'https://usebeeline.app',
        BUZZY_SNAPSHOT_AUTH_BASE_URL: 'http://auth:8789',
        BUZZY_SNAPSHOT_INTERNAL_TOKEN: 'shared-secret',
      }),
    ).toMatchObject({
      snapshotPublicOrigin: 'https://usebeeline.app',
      snapshotAuthBaseUrl: 'http://auth:8789',
      snapshotInternalToken: 'shared-secret',
      snapshotPollIntervalMs: 1_000,
      snapshotBurstCoalesceMs: 75,
    });
    expect(() =>
      loadPushGatewayConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://test',
        BUZZY_SNAPSHOT_PUBLIC_ORIGIN: 'http://usebeeline.app',
        BUZZY_SNAPSHOT_INTERNAL_TOKEN: 'shared-secret',
      }),
    ).toThrow('must use https');
    expect(() =>
      loadPushGatewayConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://test',
        BUZZY_SNAPSHOT_PUBLIC_ORIGIN: 'https://usebeeline.app',
      }),
    ).toThrow('BUZZY_SNAPSHOT_INTERNAL_TOKEN is required');
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
