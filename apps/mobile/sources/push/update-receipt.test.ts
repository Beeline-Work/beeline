import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
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
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ pushGatewayUrl: 'https://push.example' }),
}));

import { reportRunningUpdateReceipt, runningUpdateGroup } from './update-receipt';

const identity = {
  publicKey: 'a'.repeat(64),
  secretKey: new Uint8Array(32).fill(1),
};

describe('mobile OTA device receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
  });

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
          environment: 'physical',
        }),
      }),
    );
  });

  it('reads current and fallback EAS group metadata without inventing a group', () => {
    expect(runningUpdateGroup({ metadata: { updateGroup: 'group-current' } })).toBe('group-current');
    expect(runningUpdateGroup({ extra: { eas: { updateGroup: 'group-fallback' } } })).toBe('group-fallback');
    expect(runningUpdateGroup({})).toBeNull();
  });

  it('is invoked at both the root cold-launch and foreground doors', () => {
    const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
    expect(layout.match(/reportRunningUpdateReceipt\(identity\)/g)).toHaveLength(2);
    expect(layout.indexOf('reportRunningUpdateReceipt(identity)')).toBeLessThan(
      layout.indexOf('registerBuzzPushNotifications(identity)'),
    );
    const foreground = layout.slice(layout.indexOf("if (state !== 'active') return;"));
    expect(foreground).toContain('reportRunningUpdateReceipt(identity)');
  });
});
