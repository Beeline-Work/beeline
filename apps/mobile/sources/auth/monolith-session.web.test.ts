import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(() => {
    throw new Error('an ordinary browser has no Expo SecureStore backend');
  }),
  setItemAsync: vi.fn(() => {
    throw new Error('an ordinary browser has no Expo SecureStore backend');
  }),
  deleteItemAsync: vi.fn(() => {
    throw new Error('an ordinary browser has no Expo SecureStore backend');
  }),
}));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => false }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }),
}));

import { MonolithSession } from './monolith-session';
import { monolithSecureStorage } from './monolith-secure-storage';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const tokens = {
  accessToken: 'access',
  accessExpiresAt: Date.now() + 3_600_000,
  refreshToken: 'refresh',
  refreshExpiresAt: Date.now() + 86_400_000,
  identityId: 'a'.repeat(64),
};

describe('ordinary web monolith session storage', () => {
  // One origin: localStorage is shared by every tab; sessionStorage is not.
  let origin: Storage;
  let fetcher: ReturnType<typeof vi.fn>;

  // A reload or a new tab starts from a fresh MonolithSession and a fresh
  // sessionStorage, with only the origin's localStorage carried over.
  function openTab(): MonolithSession {
    vi.stubGlobal('sessionStorage', memoryStorage());
    return new MonolithSession('https://server.example', fetcher as typeof fetch);
  }

  beforeEach(() => {
    origin = memoryStorage();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', origin);
    fetcher = vi.fn(async () => new Response(JSON.stringify(tokens), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the session in the origin localStorage', async () => {
    const storage = await monolithSecureStorage(false);
    await storage.setItemAsync('buzzy.monolith.identity.v1', tokens.identityId);
    expect(origin.getItem('buzzy.monolith.identity.v1')).toBe(tokens.identityId);
  });

  it.each([
    ['review link', (session: MonolithSession) => session.exchangeReviewSecret('review')],
    ['GitHub', (session: MonolithSession) => session.exchangeGitHubTicket('ticket')],
  ])('restores a %s sign-in in a reloaded or new tab without refreshing', async (_, signIn) => {
    await signIn(openTab());
    fetcher.mockClear();

    const nextTab = openTab();
    await expect(nextTab.identityId()).resolves.toBe(tokens.identityId);
    await expect(nextTab.authorization()).resolves.toBe(tokens.accessToken);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('signs every tab out when one tab signs out', async () => {
    const first = openTab();
    await first.exchangeGitHubTicket('ticket');
    const second = openTab();
    await expect(second.identityId()).resolves.toBe(tokens.identityId);

    await second.clear();

    expect(origin.length).toBe(0);
    await expect(openTab().identityId()).resolves.toBeNull();
    await expect(openTab().authorization()).rejects.toThrow('GitHub sign-in is required');
  });
});
