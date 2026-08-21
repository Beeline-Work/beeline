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
  loadPendingGitHubIdentity,
  loadBuzzIdentityNsecForExport,
  importBuzzIdentity,
  loadRelayUrl,
  getEffectiveRelayUrl,
  saveBuzzIdentity,
  savePendingGitHubIdentity,
  clearPendingGitHubIdentity,
  saveRelayUrl,
  generateBuzzIdentity,
  DEFAULT_RELAY_URL,
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

  it('defaults new devices to the usebeeline.app apex without rewriting stored URLs', async () => {
    expect(DEFAULT_RELAY_URL).toBe('https://usebeeline.app');
    await expect(getEffectiveRelayUrl()).resolves.toBe('https://usebeeline.app');

    secureStore.getItemAsync.mockResolvedValue('https://relay.buzzrouter.com');
    await expect(getEffectiveRelayUrl()).resolves.toBe('https://relay.buzzrouter.com');
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
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
    expect(secureStore.getItemAsync).toHaveBeenCalledWith('buzzy.identity.nsec', options);
  });

  it('round-trips an exported nsec through the Advanced import path', async () => {
    const identity = { name: 'portable' };
    buzzClient.loadIdentityFromNsec.mockReturnValue(identity);
    buzzClient.identityNsec.mockReturnValue('nsec1portable');

    await expect(importBuzzIdentity('nsec1portable')).resolves.toBe(identity);
    expect(buzzClient.loadIdentityFromNsec).toHaveBeenCalledWith(
      'nsec1portable',
      'buzzy-mobile',
    );
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'buzzy.identity.nsec',
      'nsec1portable',
      { keychainAccessible: 123 },
    );

    secureStore.getItemAsync.mockResolvedValue('nsec1portable');
    await expect(loadBuzzIdentityNsecForExport()).resolves.toBe('nsec1portable');
  });

  it('propagates native write failures so onboarding can show them', async () => {
    secureStore.setItemAsync.mockRejectedValue(new Error('SecureStore is unavailable'));

    await expect(saveRelayUrl('http://relay.example')).rejects.toThrow(
      'SecureStore is unavailable',
    );
  });

  it('can hold a generated key only in memory until an OIDC bind succeeds', async () => {
    const identity = { name: 'pending' };
    buzzClient.createIdentity.mockReturnValue(identity);

    await expect(generateBuzzIdentity('pending', { persist: false })).resolves.toBe(identity);

    expect(buzzClient.createIdentity).toHaveBeenCalledWith('pending');
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('seals a pending GitHub key separately so a callback remount can reuse it', async () => {
    const identity = { name: 'pending' };
    buzzClient.identityNsec.mockReturnValue('nsec1pending');
    buzzClient.loadIdentityFromNsec.mockReturnValue(identity);

    await savePendingGitHubIdentity(identity as never);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'buzzy.identity.githubPendingNsec',
      'nsec1pending',
      { keychainAccessible: 123 },
    );

    secureStore.getItemAsync.mockResolvedValue('nsec1pending');
    await expect(loadPendingGitHubIdentity()).resolves.toBe(identity);
    expect(buzzClient.loadIdentityFromNsec).toHaveBeenCalledWith('nsec1pending', 'buzzy-mobile');

    await clearPendingGitHubIdentity();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'buzzy.identity.githubPendingNsec',
      { keychainAccessible: 123 },
    );
  });
});
