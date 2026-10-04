import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'web', desktop: false }));
const opened = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
const storage = vi.hoisted(() => new Map<string, string>());
const assigned = vi.hoisted(() => vi.fn((_url: string) => undefined));

vi.mock('react-native', () => ({ Platform: { get OS() { return platform.OS; } } }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => platform.desktop }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: opened }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.beeline.test' }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  getItem: async (key: string) => storage.get(key) ?? null,
  removeItem: async (key: string) => { storage.delete(key); },
} }));

import { openAppSignIn, takeAppSignInReturn } from './app-sign-in';

const authorization = 'https://backend.composio.dev/link/lk_fixture';
const destination = { workspaceId: 'ws-1', appId: 'app-youtube', viewerId: 'viewer-1' };

describe('openAppSignIn', () => {
  beforeEach(() => {
    platform.OS = 'web';
    platform.desktop = false;
    opened.mockClear();
    assigned.mockClear();
    storage.clear();
    vi.stubGlobal('window', { location: { origin: 'https://web.beeline.test', assign: assigned } });
  });

  it('starts web sign-in in this tab through the server so the provider returns to this web origin', async () => {
    await openAppSignIn(authorization, destination);
    expect(opened).not.toHaveBeenCalled();
    const start = new URL(assigned.mock.calls[0]![0]);
    expect(`${start.origin}${start.pathname}`).toBe('https://server.beeline.test/v1/apps/oauth/start');
    expect(start.searchParams.get('authorization')).toBe(authorization);
    expect(start.searchParams.get('return')).toBe('https://web.beeline.test');
    await expect(takeAppSignInReturn()).resolves.toEqual(destination);
  });

  it.each([
    ['the native app', { OS: 'ios', desktop: false }],
    ['the desktop shell', { OS: 'web', desktop: true }],
  ])('opens the provider link directly from %s', async (_label, host) => {
    Object.assign(platform, host);
    await openAppSignIn(authorization, destination);
    expect(opened).toHaveBeenCalledWith(authorization);
    expect(assigned).not.toHaveBeenCalled();
  });
});
