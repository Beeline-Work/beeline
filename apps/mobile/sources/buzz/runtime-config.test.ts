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

  it('uses the usebeeline.app push route by default', () => {
    mocks.loadAppConfig.mockReturnValue({});

    expect(getBuzzRuntimeConfig().pushGatewayUrl).toBe('https://usebeeline.app/push');
  });

  it('preserves the permanent push.buzzrouter.com alias when configured', () => {
    mocks.loadAppConfig.mockReturnValue({
      buzzyPushGatewayUrl: 'https://push.buzzrouter.com/',
    });

    expect(getBuzzRuntimeConfig().pushGatewayUrl).toBe('https://push.buzzrouter.com');
  });
});
