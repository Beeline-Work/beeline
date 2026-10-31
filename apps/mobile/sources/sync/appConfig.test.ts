import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ n: 0 }));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      reads.n += 1;
      return { extra: { app: { buzzyMonolithUrl: 'https://server.usebeeline.app/' } } };
    },
  },
}));

describe('loadAppConfig', () => {
  beforeEach(() => {
    reads.n = 0;
    delete process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
    delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
    vi.resetModules();
  });

  it('reads and parses the embedded config once per session, not again on a second open', async () => {
    const { loadAppConfig } = await import('@/sync/appConfig');
    const { getBuzzRuntimeConfig } = await import('@/buzz/runtime-config');
    // One Room open asks several call sites for the same config.
    for (let call = 0; call < 13; call += 1) getBuzzRuntimeConfig();
    expect(reads.n).toBe(1);
    expect(getBuzzRuntimeConfig().monolithUrl).toBe('https://server.usebeeline.app');
    expect(loadAppConfig()).toBe(loadAppConfig());
    // A later open in the same process must not read the manifest again.
    for (let call = 0; call < 13; call += 1) getBuzzRuntimeConfig();
    expect(reads.n).toBe(1);
  });
});
