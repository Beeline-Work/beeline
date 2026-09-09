import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string, args: { key: string; value?: string }) => {
    if (command === 'desktop_secure_get') return desktopSecrets.get(args.key) ?? null;
    if (command === 'desktop_secure_set') {
      desktopSecrets.set(args.key, args.value!);
      return;
    }
    if (command === 'desktop_secure_remove') {
      desktopSecrets.delete(args.key);
      return;
    }
    throw new Error(`unexpected command ${command}`);
  }),
);
const desktopSecrets = vi.hoisted(() => new Map<string, string>());
const desktopFetch = vi.hoisted(() =>
  vi.fn(async () => new Response(JSON.stringify(tokens), { status: 200 })),
);

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(() => {
    throw new Error('the packaged web bundle has no Expo SecureStore backend');
  }),
  setItemAsync: vi.fn(() => {
    throw new Error('the packaged web bundle has no Expo SecureStore backend');
  }),
  deleteItemAsync: vi.fn(() => {
    throw new Error('the packaged web bundle has no Expo SecureStore backend');
  }),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: desktopFetch }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => true }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));

import { MonolithSession } from './monolith-session';
import { monolithSecureStorage } from './monolith-secure-storage';

const tokens = {
  accessToken: 'access',
  accessExpiresAt: Date.now() + 60_000,
  refreshToken: 'refresh',
  refreshExpiresAt: Date.now() + 86_400_000,
  identityId: 'a'.repeat(64),
};

describe('packaged desktop monolith session storage', () => {
  beforeEach(() => {
    desktopSecrets.clear();
    invoke.mockClear();
    desktopFetch.mockClear();
  });

  it('uses the native HTTP plugin for cross-origin session exchange', async () => {
    const desktopStorage = () => monolithSecureStorage(true, invoke);
    const session = new MonolithSession('https://server.example', undefined, desktopStorage);

    await expect(session.exchangeReviewSecret('review')).resolves.toBe(tokens.identityId);

    expect(desktopFetch).toHaveBeenCalledWith(
      'https://server.example/v1/auth/review/exchange',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('boots without an identity and persists sign-in through the desktop credential commands', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(tokens), { status: 200 }));
    const desktopStorage = () => monolithSecureStorage(true, invoke);
    const firstLaunch = new MonolithSession(
      'https://server.example',
      fetcher as typeof fetch,
      desktopStorage,
    );
    await expect(firstLaunch.identityId()).resolves.toBeNull();

    await firstLaunch.exchangeGitHubTicket('ticket');

    const nextLaunch = new MonolithSession(
      'https://server.example',
      fetcher as typeof fetch,
      desktopStorage,
    );
    await expect(nextLaunch.identityId()).resolves.toBe(tokens.identityId);
    await expect(nextLaunch.authorization()).resolves.toBe(tokens.accessToken);
    expect(invoke).toHaveBeenCalledWith('desktop_secure_get', {
      key: 'buzzy.monolith.identity.v1',
    });
    expect(invoke).toHaveBeenCalledWith('desktop_secure_set', {
      key: 'buzzy.monolith.refresh.v1',
      value: tokens.refreshToken,
    });
  });
});
