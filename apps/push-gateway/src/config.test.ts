import { describe, expect, it } from 'vitest';
import { loadPushGatewayConfig } from './config.js';

describe('loadPushGatewayConfig', () => {
  it('configures one Postgres indexer and the existing push feed', () => {
    expect(loadPushGatewayConfig({ BUZZY_PUSH_DATABASE_URL: 'postgres://buzz@postgres/buzz' }))
      .toEqual({
        databaseUrl: 'postgres://buzz@postgres/buzz',
        host: '127.0.0.1',
        port: 8788,
        registryFile: '.data/registrations.json',
        pollIntervalMs: 1_500,
        feedHeartbeatIntervalMs: 60_000,
        indexerPublicOrigin: 'http://127.0.0.1:8788',
      });
  });

  it('requires HTTPS for a non-loopback production indexer origin', () => {
    expect(
      loadPushGatewayConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://test',
        BUZZY_INDEXER_PUBLIC_ORIGIN: 'https://usebeeline.app',
      }),
    ).toMatchObject({ indexerPublicOrigin: 'https://usebeeline.app' });
    expect(() => loadPushGatewayConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://test',
      BUZZY_INDEXER_PUBLIC_ORIGIN: 'http://usebeeline.app',
    })).toThrow('must use https');
    expect(loadPushGatewayConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://test',
      BUZZY_INDEXER_PUBLIC_ORIGIN: 'http://127.0.0.1:3010',
    })).toMatchObject({ indexerPublicOrigin: 'http://127.0.0.1:3010' });
  });

  it('fails fast without a database URL', () => {
    expect(() => loadPushGatewayConfig({})).toThrow(
      'set BUZZY_PUSH_DATABASE_URL or DATABASE_URL',
    );
  });
});
