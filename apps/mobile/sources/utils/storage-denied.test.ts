import { describe, expect, it, vi } from 'vitest';

// A browser page whose storage access throws, as with blocked site data.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { document: {} } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('The operation is insecure.');
    },
  });
});
const native = vi.hoisted(() => ({ used: [] as string[] }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async () => { native.used.push('secure-store'); return null; },
  setItemAsync: async () => { native.used.push('secure-store'); },
  deleteItemAsync: async () => { native.used.push('secure-store'); },
}));
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    constructor() {
      native.used.push('mmkv');
    }
  },
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithEnabled: false, relayUrl: 'https://usebeeline.app' }),
}));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {} }));

import { loadRelayUrl, saveRelayUrl } from '@/auth/buzz-identity-storage';
import { monolithSecureStorage } from '@/auth/monolith-secure-storage';
import { loadUnmigratableRooms, saveUnmigratableRooms } from '@/buzz/unmigratable-rooms-cache';
import { webRuntimeStorage } from './web-storage';

describe('denied browser storage', () => {
  it('is reported once, as a web runtime without storage', () => {
    expect(webRuntimeStorage()).toEqual({ storage: undefined });
  });

  it('keeps every module on this page\'s memory instead of native storage', async () => {
    await saveRelayUrl('https://relay.test');
    expect(await loadRelayUrl()).toBe('https://relay.test');

    const session = await monolithSecureStorage(false);
    await session.setItemAsync('session', 'token');
    expect(await session.getItemAsync('session')).toBe('token');

    saveUnmigratableRooms('viewer', [{ channelId: 'room-1', pubkey: 'key-1' }]);
    expect(loadUnmigratableRooms('viewer')).toEqual([{ channelId: 'room-1', pubkey: 'key-1' }]);

    expect(native.used).toEqual([]);
  });
});
