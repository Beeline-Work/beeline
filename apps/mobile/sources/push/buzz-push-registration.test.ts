import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getBuzzPushRegistrationState,
  registerBuzzPushNotifications,
  retryBuzzPushRegistration,
  sendBuzzPushTestNotification,
  setBuzzPushEnabled,
} from './buzz-push-registration';

const identity = {
  publicKey: 'a'.repeat(64),
  secretKey: new Uint8Array(32).fill(1),
};

const FCM_TOKEN = 'fcm-token-A_12345678901234567890';
const REGISTRATION_STATE_KEY = `@beeline/buzz-push/registration/${identity.publicKey}`;

function storedRegistrationState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    registered: false,
    retryable: true,
    phase: 'network-failed',
    failedAttempts: 1,
    updatedAt: Date.now() - 60 * 60 * 1000,
    ...overrides,
  });
}

describe('Buzz push preference', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
    storage.removeItem.mockResolvedValue(undefined);
    notifications.getPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      status: 'granted',
    });
    notifications.requestPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      status: 'granted',
    });
    notifications.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: FCM_TOKEN });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not prompt or register after push is disabled', async () => {
    storage.getItem.mockImplementation(async (key: string) =>
      key.includes('/enabled/') ? '0' : null,
    );

    const result = await registerBuzzPushNotifications(identity);

    expect(result).toMatchObject({ registered: false, retryable: false, phase: 'disabled' });
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('registers, persists the truthful state, and never logs the full token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const allLogs = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map((parts) => parts.join(' '));

    const result = await registerBuzzPushNotifications(identity);

    expect(result).toMatchObject({ registered: true, retryable: false, phase: 'registered' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://push.example/registrations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Nostr signed' }),
      }),
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      REGISTRATION_STATE_KEY,
      expect.stringContaining('"registered":true'),
    );
    // Diagnostics name the broken hop without ever exposing the token itself.
    const logged = allLogs().join('\n');
    expect(logged).toContain('[buzzy-push] FCM token acquired fingerprint=');
    expect(logged).toContain(`length=${FCM_TOKEN.length}`);
    expect(logged).toContain('POST https://push.example/registrations -> HTTP 200');
    expect(logged).not.toContain(FCM_TOKEN);
  });

  it('sends a test notification with the runtime gateway URL and current identity auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendBuzzPushTestNotification(identity);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://push.example/test-send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Nostr signed' }),
        body: JSON.stringify({ pubkey: identity.publicKey }),
      }),
    );
  });

  it('surfaces the push gateway error from a rejected test notification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'no registered devices' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(sendBuzzPushTestNotification(identity)).rejects.toThrow('no registered devices');
  });

  it('bounds a test notification request that never settles', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));

    const rejection = expect(sendBuzzPushTestNotification(identity)).rejects.toThrow(
      'test notification request timed out after 7500ms',
    );
    await vi.advanceTimersByTimeAsync(7_500);

    await rejection;
  });

  it('surfaces a token-acquisition timeout as a distinct retryable phase', async () => {
    vi.useFakeTimers();
    notifications.getDevicePushTokenAsync.mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal('fetch', vi.fn());

    const pending = registerBuzzPushNotifications(identity);
    await vi.advanceTimersByTimeAsync(7_500);
    const result = await pending;

    expect(result).toMatchObject({
      registered: false,
      retryable: true,
      phase: 'token-timed-out',
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      REGISTRATION_STATE_KEY,
      expect.stringContaining('"failedAttempts":1'),
    );
    expect(warnSpy.mock.calls.some((parts) => parts.join(' ').includes('phase=token-timed-out'))).toBe(true);
  });

  it('surfaces a gateway rejection as a retryable failure with the HTTP status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await registerBuzzPushNotifications(identity);

    expect(result).toMatchObject({ registered: false, retryable: true, phase: 'gateway-rejected' });
    expect(logSpy.mock.calls.some((parts) => parts.join(' ').includes('HTTP 503'))).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      REGISTRATION_STATE_KEY,
      expect.stringContaining('"phase":"gateway-rejected"'),
    );
  });

  it('surfaces a denied permission instead of returning silently', async () => {
    notifications.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
      status: 'denied',
    });

    const result = await registerBuzzPushNotifications(identity);

    expect(result).toMatchObject({ registered: false, phase: 'permission-denied' });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((parts) => parts.join(' ').includes('permission granted=false'))).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      REGISTRATION_STATE_KEY,
      expect.stringContaining('"phase":"permission-denied"'),
    );
  });

  it('does not count a permission gap against the retry backoff', async () => {
    storage.getItem.mockImplementation(async (key: string) =>
      key === REGISTRATION_STATE_KEY ? storedRegistrationState({ phase: 'permission-denied', failedAttempts: 3 }) : null,
    );
    notifications.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
    });
    notifications.requestPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
      status: 'denied',
    });

    await registerBuzzPushNotifications(identity);

    expect(storage.setItem).toHaveBeenCalledWith(
      REGISTRATION_STATE_KEY,
      expect.stringContaining('"failedAttempts":3'),
    );
  });

  describe('foreground retry', () => {
    it('is a no-op when the last attempt registered', async () => {
      storage.getItem.mockImplementation(async (key: string) =>
        key === REGISTRATION_STATE_KEY
          ? storedRegistrationState({ registered: true, retryable: false, phase: 'registered', failedAttempts: 0 })
          : null,
      );

      await expect(retryBuzzPushRegistration(identity)).resolves.toBeNull();
      expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    });

    it('backs off while the retry window has not elapsed', async () => {
      storage.getItem.mockImplementation(async (key: string) =>
        key === REGISTRATION_STATE_KEY
          ? storedRegistrationState({ failedAttempts: 2, updatedAt: Date.now() - 10_000 })
          : null,
      );

      await expect(retryBuzzPushRegistration(identity)).resolves.toBeNull();
      expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    });

    it('retries without prompting once the backoff window has elapsed', async () => {
      notifications.getPermissionsAsync.mockResolvedValue({
        granted: false,
        canAskAgain: true,
        status: 'undetermined',
      });
      storage.getItem.mockImplementation(async (key: string) =>
        key === REGISTRATION_STATE_KEY
          ? storedRegistrationState({ failedAttempts: 2, updatedAt: Date.now() - 60_000 })
          : null,
      );

      const result = await retryBuzzPushRegistration(identity);

      expect(result).toMatchObject({ registered: false, phase: 'permission-denied' });
      expect(notifications.getPermissionsAsync).toHaveBeenCalled();
      expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });
  });

  it('unregisters the stored device token with signed identity authorization', async () => {
    storage.getItem.mockImplementation(async (key: string) =>
      key.includes('/token/') ? 'fcm-token-B_12345678901234567890' : null,
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await setBuzzPushEnabled(identity, false);

    expect(result).toMatchObject({ registered: false, retryable: false, phase: 'disabled' });
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
    expect(storage.setItem).toHaveBeenCalledWith(
      REGISTRATION_STATE_KEY,
      expect.stringContaining('"phase":"disabled"'),
    );
  });

  it('keeps notifications disabled when an unregistered device has no FCM setup', async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
    notifications.getDevicePushTokenAsync.mockRejectedValue(new Error('Firebase unavailable'));

    await expect(setBuzzPushEnabled(identity, false)).resolves.toMatchObject({
      registered: false,
      retryable: false,
      phase: 'disabled',
    });

    expect(storage.setItem).toHaveBeenCalledWith(
      `@beeline/buzz-push/enabled/${identity.publicKey}`,
      '0',
    );
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('reads back a persisted registration state for the settings UI', async () => {
    storage.getItem.mockImplementation(async (key: string) =>
      key === REGISTRATION_STATE_KEY
        ? storedRegistrationState({ phase: 'token-timed-out', failedAttempts: 2 })
        : null,
    );

    const state = await getBuzzPushRegistrationState(identity.publicKey);

    expect(state).toMatchObject({ registered: false, phase: 'token-timed-out', failedAttempts: 2 });
  });

  it('tolerates a corrupt persisted registration state', async () => {
    storage.getItem.mockResolvedValue('not json{');

    await expect(getBuzzPushRegistrationState(identity.publicKey)).resolves.toBeNull();
  });
});
