import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ identityId: vi.fn(), authorization: vi.fn() }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: session }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithEnabled: true }),
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1 }));

import { loadBuzzIdentity, loadBuzzViewerPubkey } from './buzz-identity-storage';

describe('saved Beeline identity at launch', () => {
  const identityId = 'a'.repeat(64);
  beforeEach(() => {
    vi.resetAllMocks();
    session.identityId.mockResolvedValue(identityId);
  });

  it.each(['offline', 'refresh timeout', 'deploy 503', 'lost refresh reply', 'malformed reply'])(
    'keeps the signed-in destination when credential renewal fails: %s',
    async (failure) => {
      session.authorization.mockRejectedValue(new Error(failure));
      expect(await loadBuzzIdentity()).toEqual({ publicKey: identityId, secretKey: new Uint8Array() });
      expect(await loadBuzzViewerPubkey()).toBe(identityId);
      expect(session.authorization).not.toHaveBeenCalled();
    },
  );

  it('routes an explicitly signed-out device to sign-in', async () => {
    session.identityId.mockResolvedValue(null);
    expect(await loadBuzzIdentity()).toBeNull();
    expect(session.authorization).not.toHaveBeenCalled();
  });

  it('propagates a failed device storage read instead of claiming sign-out', async () => {
    session.identityId.mockRejectedValue(new Error('SecureStore unavailable'));
    await expect(loadBuzzIdentity()).rejects.toThrow('SecureStore unavailable');
  });
});
