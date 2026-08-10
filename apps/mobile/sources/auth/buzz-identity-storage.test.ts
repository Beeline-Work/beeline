import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 123,
  getItemAsync: vi.fn<(key: string, options?: unknown) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string, options?: unknown) => Promise<void>>(),
  deleteItemAsync: vi.fn<(key: string, options?: unknown) => Promise<void>>(),
}));

const buzzClient = vi.hoisted(() => ({
  createIdentity: vi.fn(),
  loadIdentityFromNsec: vi.fn(),
  identityNsec: vi.fn(() => 'nsec1test'),
  identityNpub: vi.fn(),
}));

vi.mock('expo-secure-store', () => secureStore);
vi.mock('@beeline/buzz-client', () => buzzClient);

import {
  loadBuzzIdentity,
  loadBuzzIdentityNsecForExport,
  loadRelayUrl,
  saveBuzzIdentity,
  saveRelayUrl,
} from './buzz-identity-storage';

describe('Buzz identity storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
  });

  it('uses SecureStore-compatible keys for relay persistence', async () => {
    secureStore.getItemAsync.mockResolvedValue('http://relay.example');

    await expect(loadRelayUrl()).resolves.toBe('http://relay.example');
    await saveRelayUrl('http://relay.example');

    const keys = [
      secureStore.getItemAsync.mock.calls[0]?.[0],
      secureStore.setItemAsync.mock.calls[0]?.[0],
    ];
    expect(keys).toEqual(['buzzy.identity.relayUrl', 'buzzy.identity.relayUrl']);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('uses the same SecureStore-compatible key to save and load identities', async () => {
    const identity = { name: 'reviewer' };
    secureStore.getItemAsync.mockResolvedValue('nsec1test');
    buzzClient.loadIdentityFromNsec.mockReturnValue(identity);

    await saveBuzzIdentity(identity as never);
    await expect(loadBuzzIdentity()).resolves.toBe(identity);

    const keys = [
      secureStore.setItemAsync.mock.calls[0]?.[0],
      secureStore.getItemAsync.mock.calls[0]?.[0],
    ];
    expect(keys).toEqual(['buzzy.identity.nsec', 'buzzy.identity.nsec']);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('seals identity secrets as unlocked-device-only keychain items', async () => {
    const identity = { name: 'reviewer' };
    secureStore.getItemAsync.mockResolvedValue('nsec1test');

    await saveBuzzIdentity(identity as never);
    await expect(loadBuzzIdentityNsecForExport()).resolves.toBe('nsec1test');

    const options = { keychainAccessible: 123 };
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'buzzy.identity.nsec',
      'nsec1test',
      options,
    );
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(
      'buzzy.identity.nsec',
      options,
    );
  });

  it('propagates native write failures so onboarding can show them', async () => {
    secureStore.setItemAsync.mockRejectedValue(
      new Error('SecureStore is unavailable'),
    );

    await expect(saveRelayUrl('http://relay.example')).rejects.toThrow(
      'SecureStore is unavailable',
    );
  });
});
