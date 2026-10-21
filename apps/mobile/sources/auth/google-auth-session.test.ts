import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://beeline/${path.split('/').pop()}` }));
vi.mock('./desktop-auth-redirect', () => ({ desktopAuthRedirectUri: (_: string, fallback: string) => fallback }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
} }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }) }));
import { clearPendingGoogleSignIn, resumeGoogleSignIn, runGoogleSignIn } from './google-auth-session';
const state = 's'.repeat(43);
const recoveryToken = 'r'.repeat(43);
const pending = () => storage.set('beeline.google-sign-in.v1', JSON.stringify({ state, recoveryToken, startedAt: Date.now() }));
describe('Google sign-in continuation', () => {
  beforeEach(() => { storage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('recovers a lost callback with the persisted secret, then clears it after exchange', async () => {
    pending();
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await resumeGoogleSignIn(null)).toBe(recoveryToken);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ recoveryToken });
    await clearPendingGoogleSignIn();
    expect(await resumeGoogleSignIn(null)).toBeNull();
  });
  it('rejects a mismatched callback before polling or spending a ticket', async () => {
    pending();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(resumeGoogleSignIn('beeline://beeline/google-callback?completed=1&state=wrong')).rejects.toThrow('state mismatch');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('waits on an unfinished flow and expires damaged or old local state', async () => {
    pending();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })));
    expect(await resumeGoogleSignIn(null)).toBeNull();
    storage.set('beeline.google-sign-in.v1', JSON.stringify({ state, recoveryToken, startedAt: 0 }));
    expect(await resumeGoogleSignIn(null)).toBeNull();
    expect(storage.size).toBe(0);
  });
  it('opens a state-bound OAuth flow and completes through recovery when the browser stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const remove = vi.fn();
    const open = vi.fn(async (url: string, redirect: string) => {
      const start = new URL(url);
      expect(start.origin).toBe('https://server.example');
      expect(start.searchParams.get('app_state')).toBe(state);
      expect(start.searchParams.get('app_recovery_challenge')).toMatch(/^[a-f0-9]{64}$/);
      expect(redirect).toBe('beeline://beeline/google-callback');
      return { type: 'opened' };
    });
    expect(await runGoogleSignIn({ state, recoveryToken, openAuthSession: open, subscribeToUrls: () => ({ remove }) })).toBe(recoveryToken);
    expect(open).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});
