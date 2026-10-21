import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 123,
  getItemAsync: vi.fn<(key: string, options?: unknown) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string, options?: unknown) => Promise<void>>(),
  deleteItemAsync: vi.fn<(key: string, options?: unknown) => Promise<void>>(),
}));

const buzzClient = vi.hoisted(() => ({
  loadIdentityFromNsec: vi.fn(),
  identityNpub: vi.fn(),
}));

const runtimeConfig = vi.hoisted(() => ({
  getBuzzRuntimeConfig: vi.fn(() => ({
    relayUrl: 'https://usebeeline.app',
    pushGatewayUrl: 'https://server.usebeeline.app',
    monolithUrl: 'https://server.usebeeline.app',
  })),
}));

vi.mock('expo-secure-store', () => secureStore);
vi.mock('@beeline/buzz-client', () => buzzClient);
vi.mock('@/buzz/runtime-config', () => runtimeConfig);

import {
  clearBuzzIdentity,
  clearPendingGitHubIdentity,
  getEffectiveRelayUrl,
  loadPendingGitHubIdentity,
} from './buzz-identity-storage';

describe('Buzz identity storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
  });

  it('reads every Room and Workspace surface from the configured server', async () => {
    runtimeConfig.getBuzzRuntimeConfig.mockReturnValueOnce({
      relayUrl: 'https://usebeeline.app',
      pushGatewayUrl: 'https://server.usebeeline.app',
      monolithUrl: 'http://127.0.0.1:8787',
    });

    await expect(getEffectiveRelayUrl()).resolves.toBe('http://127.0.0.1:8787');
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
  });

  it('reads and clears the sealed pending GitHub key so a callback remount can reuse it', async () => {
    const identity = { name: 'pending' };
    buzzClient.loadIdentityFromNsec.mockReturnValue(identity);
    secureStore.getItemAsync.mockResolvedValue('nsec1pending');

    await expect(loadPendingGitHubIdentity()).resolves.toBe(identity);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith('buzzy.identity.githubPendingNsec', {
      keychainAccessible: 123,
    });
    expect(buzzClient.loadIdentityFromNsec).toHaveBeenCalledWith('nsec1pending', 'buzzy-mobile');

    await clearPendingGitHubIdentity();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('buzzy.identity.githubPendingNsec', {
      keychainAccessible: 123,
    });
  });

  it('forgets both device keys on sign-out', async () => {
    await clearBuzzIdentity();

    const options = { keychainAccessible: 123 };
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('buzzy.identity.nsec', options);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'buzzy.identity.githubPendingNsec',
      options,
    );
  });
});
