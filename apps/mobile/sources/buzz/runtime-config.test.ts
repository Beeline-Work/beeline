import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAppConfig: vi.fn(),
}));

vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: mocks.loadAppConfig,
}));

import { getBuzzRuntimeConfig } from './runtime-config';

describe('getBuzzRuntimeConfig', () => {
  beforeEach(() => {
    mocks.loadAppConfig.mockReset();
  });

  it('uses the Fly monolith for every API path', () => {
    mocks.loadAppConfig.mockReturnValue({});

    expect(getBuzzRuntimeConfig().pushGatewayUrl).toBe('https://server.usebeeline.app');
    expect(getBuzzRuntimeConfig()).toMatchObject({
      monolithEnabled: true,
      monolithUrl: 'https://server.usebeeline.app',
    });
  });

  it('lets an OTA bundle point at an explicit monolith without changing transport kind', () => {
    mocks.loadAppConfig.mockReturnValue({
      buzzyMonolithUrl: 'https://monolith.example/',
    });
    expect(getBuzzRuntimeConfig()).toMatchObject({
      monolithEnabled: true,
      monolithUrl: 'https://monolith.example',
    });
  });

  it('ignores retired relay and push overrides', () => {
    mocks.loadAppConfig.mockReturnValue({
      buzzyPushGatewayUrl: 'https://push.buzzrouter.com/',
    });

    expect(getBuzzRuntimeConfig().pushGatewayUrl).toBe('https://server.usebeeline.app');
    expect(getBuzzRuntimeConfig().relayUrl).toBe('https://usebeeline.app');
  });
});
