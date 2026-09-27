import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPushRegistrationLifecycle } from './push-registration-lifecycle';
import { Platform } from 'react-native';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
const desktop = vi.hoisted(() => ({ enabled: false, monolith: false, operation: vi.fn() }));
const updates = vi.hoisted(() => ({
  updateId: '11111111-2222-3333-4444-555555555555',
  channel: 'production',
  runtimeVersion: '21',
  manifest: { metadata: { updateGroup: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('@beeline/nostr', () => ({ nip98AuthHeader: vi.fn(() => 'Nostr signed') }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'device-id-1111-2222' }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-updates', () => updates);
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => desktop.enabled }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: desktop.operation,
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    pushGatewayUrl: 'https://push.example',
    monolithEnabled: desktop.monolith,
  }),
}));
vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: () => ({ releaseVersion: 'v0.0.1', releaseSha: '1'.repeat(40) }),
}));

import {
  reportRunningUpdateReceipt,
  runningUpdateGroup,
  runningUpdatePlatform,
} from './update-receipt';

const identity = {
  publicKey: 'a'.repeat(64),
  secretKey: new Uint8Array(32).fill(1),
};

describe('mobile OTA device receipt', () => {
  it('identifies Tauri desktop platforms without treating browser web as a device', () => {
    expect(runningUpdatePlatform('web', true, 'MacIntel')).toBe('macos');
    expect(runningUpdatePlatform('web', true, 'Win32')).toBe('windows');
    expect(runningUpdatePlatform('web', true, 'Linux x86_64')).toBe('linux');
    expect(runningUpdatePlatform('web', false, 'MacIntel')).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    desktop.enabled = false;
    desktop.monolith = false;
    Platform.OS = 'android';
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the running EAS update and stable installation id with signed identity auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await reportRunningUpdateReceipt(identity);

    expect(storage.setItem).toHaveBeenCalledWith(
      '@beeline/mobile-update-receipt/device-id',
      'device-id-1111-2222',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://push.example/update-receipts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Nostr signed' }),
        body: JSON.stringify({
          pubkey: identity.publicKey,
          deviceId: 'device-id-1111-2222',
          updateId: updates.updateId,
          channel: 'production',
          group: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          runtimeVersion: '21',
          releaseVersion: 'v0.0.1',
          sourceSha: '1'.repeat(40),
          environment: 'physical',
        }),
      }),
    );
  });

  it('reads current and fallback EAS group metadata without inventing a group', () => {
    expect(runningUpdateGroup({ metadata: { updateGroup: 'group-current' } })).toBe(
      'group-current',
    );
    expect(runningUpdateGroup({ extra: { eas: { updateGroup: 'group-fallback' } } })).toBe(
      'group-fallback',
    );
    expect(runningUpdateGroup({})).toBeNull();
  });

  it('reports on cold launch and foreground independently of push registration success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    let foreground = () => {};
    const reportFailure = vi.fn();
    const failed = { registered: false, retryable: true, phase: 'token-failed' as const };
    const register = vi.fn(async () => failed);
    const retry = vi.fn(async () => failed);
    const dispose = startPushRegistrationLifecycle({
      loadIdentity: async () => identity,
      subscribeIdentityChange: () => () => {},
      subscribeForeground: (listener) => {
        foreground = listener;
        return () => {};
      },
      register,
      retry,
      reportUpdate: reportRunningUpdateReceipt,
      reportFailure,
    });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(register).toHaveBeenCalledWith(identity);
      foreground();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(retry).toHaveBeenCalledWith(identity);
      for (const [, request] of fetchMock.mock.calls) {
        expect(JSON.parse(request.body)).toMatchObject({
          pubkey: identity.publicKey,
          updateId: updates.updateId,
        });
      }
      expect(reportFailure).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
    }
  });

  it('reports a Tauri desktop platform through the monolith receipt operation', async () => {
    desktop.enabled = true;
    desktop.monolith = true;
    Platform.OS = 'web';
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    await reportRunningUpdateReceipt(identity);
    expect(desktop.operation).toHaveBeenCalledWith(
      'reportRunningUpdate',
      expect.objectContaining({ platform: 'macos', deviceId: 'device-id-1111-2222' }),
    );
  });
});
