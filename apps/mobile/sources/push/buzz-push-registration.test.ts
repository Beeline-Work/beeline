import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('@beeline/nostr', () => ({ nip98AuthHeader: vi.fn(() => 'Nostr signed') }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-notifications', () => notifications);
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ pushGatewayUrl: 'https://push.example' }),
}));

import {
  registerBuzzPushNotifications,
  setBuzzPushEnabled,
} from './buzz-push-registration';

const identity = {
  publicKey: 'a'.repeat(64),
  secretKey: new Uint8Array(32).fill(1),
};

describe('Buzz push preference', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
    storage.removeItem.mockResolvedValue(undefined);
  });

  it('does not prompt or register after push is disabled', async () => {
    storage.getItem.mockResolvedValue('0');

    await expect(registerBuzzPushNotifications(identity)).resolves.toBe(false);

    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('unregisters the stored device token with signed identity authorization', async () => {
    storage.getItem.mockImplementation(async (key: string) =>
      key.includes('/token/') ? 'fcm-token-A_12345678901234567890' : null,
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(setBuzzPushEnabled(identity, false)).resolves.toBe(false);

    expect(storage.setItem).toHaveBeenCalledWith(
      `@beeline/buzz-push/enabled/${identity.publicKey}`,
      '0',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://push.example/registrations',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ authorization: 'Nostr signed' }),
      }),
    );
    expect(storage.removeItem).toHaveBeenCalledWith(
      `@beeline/buzz-push/token/${identity.publicKey}`,
    );
  });

  it('keeps notifications disabled when an unregistered device has no FCM setup', async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
    notifications.getDevicePushTokenAsync.mockRejectedValue(new Error('Firebase unavailable'));

    await expect(setBuzzPushEnabled(identity, false)).resolves.toBe(false);

    expect(storage.setItem).toHaveBeenCalledWith(
      `@beeline/buzz-push/enabled/${identity.publicKey}`,
      '0',
    );
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
