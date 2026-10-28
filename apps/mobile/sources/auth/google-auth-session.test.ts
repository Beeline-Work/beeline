import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, string>());
const picker = vi.hoisted(() => ({ enabled: false, signIn: vi.fn() }));
vi.mock('./google-account-picker', () => ({ get googleAccountPicker() { return picker.enabled ? picker : null; } }));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://beeline/${path.split('/').pop()}` }));
vi.mock('./desktop-auth-redirect', () => ({ desktopAuthRedirectUri: (_: string, fallback: string) => fallback }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
} }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }) }));
import { clearPendingGoogleSignIn, pendingGoogleLinkIdentity, resumeGoogleSignIn, runGoogleSignIn } from './google-auth-session';
const state = 's'.repeat(43);
const recoveryToken = 'r'.repeat(43);
const pending = () => storage.set('beeline.google-sign-in.v1', JSON.stringify({ state, recoveryToken, startedAt: Date.now() }));
describe('Google sign-in continuation', () => {
  it('R-signin-dismiss: recovers a delayed ticket after Android dismisses the browser on redirect', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: Date.now() - started < 4_000 ? 202 : 200,
    })));
    try {
      const result = runGoogleSignIn({ state, recoveryToken,
        openAuthSession: async () => ({ type: 'dismiss' }),
        subscribeToUrls: () => ({ remove() {} }),
      });
      const assertion = expect(result).resolves.toBe(recoveryToken);
      await vi.runAllTimersAsync();
      await assertion;
    } finally { vi.useRealTimers(); }
  });
  beforeEach(() => { storage.clear(); picker.enabled = false; picker.signIn.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('R-signin-native: uses the native picker and preserves the recovery token and account-link target', async () => {
    picker.enabled = true;
    picker.signIn.mockResolvedValue('signed-google-id-token');
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/native/start')) return new Response(JSON.stringify({
        state, nonce: 'n'.repeat(43), serverClientId: 'server.apps.googleusercontent.com',
      }));
      expect(url).toBe('https://server.example/auth/oidc/native/complete');
      expect(JSON.parse(options!.body as string)).toEqual({ state, recoveryToken, idToken: 'signed-google-id-token' });
      return new Response(JSON.stringify({ completed: true }));
    });
    vi.stubGlobal('fetch', fetcher);
    const open = vi.fn();
    expect(await runGoogleSignIn({ state, recoveryToken, linkIdentity: 'existing-account',
      openAuthSession: open, subscribeToUrls: () => ({ remove() {} }),
    })).toBe(recoveryToken);
    expect(picker.signIn).toHaveBeenCalledWith('server.apps.googleusercontent.com', 'n'.repeat(43));
    expect(open).not.toHaveBeenCalled();
    expect(await pendingGoogleLinkIdentity()).toBe('existing-account');
  });
  it('reports only an explicit native user cancel as cancellation and revokes recovery', async () => {
    picker.enabled = true;
    picker.signIn.mockRejectedValue({ code: 'GOOGLE_CANCELLED' });
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/start') ? { state, nonce: 'n'.repeat(43), serverClientId: 'server.apps.googleusercontent.com' } : {},
    )));
    vi.stubGlobal('fetch', fetcher);
    await expect(runGoogleSignIn({ state, recoveryToken, openAuthSession: vi.fn(),
      subscribeToUrls: () => ({ remove() {} }),
    })).rejects.toMatchObject({ code: 'browser_canceled' });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/completion/cancel'))).toBe(true);
    expect(storage.size).toBe(0);
  });
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
    const funnelContext = {event:'provider_tapped' as const,installId:'00000000-0000-4000-8000-000000000001',attemptId:'00000000-0000-4000-8000-000000000002',platform:'android' as const,provider:'google' as const,version:'0.2.22',environment:'production' as const,timestamp:new Date().toISOString()};
    const remove = vi.fn();
    const open = vi.fn(async (url: string, redirect: string) => {
      const start = new URL(url);
      expect(start.origin).toBe('https://server.example');
      expect(JSON.parse(start.searchParams.get('funnel')!)).toEqual(funnelContext);
      expect(start.searchParams.get('app_state')).toBe(state);
      expect(start.searchParams.get('app_recovery_challenge')).toMatch(/^[a-f0-9]{64}$/);
      expect(redirect).toBe('beeline://beeline/google-callback');
      return { type: 'opened' };
    });
    expect(await runGoogleSignIn({ state, recoveryToken, funnelContext, openAuthSession: open, subscribeToUrls: () => ({ remove }) })).toBe(recoveryToken);
    expect(open).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
  it('R-onb-1: recovers on the first attempt after a browser handoff interrupts completion reads', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 11_000));
        throw new TypeError('Network request failed');
      })
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = runGoogleSignIn({ state, recoveryToken,
        openAuthSession: async () => ({ type: 'opened' }),
        subscribeToUrls: () => ({ remove() {} }),
      });
      const assertion = expect(result).resolves.toBe(recoveryToken);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });
  it('R-onb-21: recovers and cancels on Hermes without AbortSignal.timeout', async () => {
    vi.stubGlobal('AbortSignal', {});
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(options?.signal).toBeDefined();
      return new Response('{}', {status:200});
    });
    vi.stubGlobal('fetch', fetcher);
    const input = {state,recoveryToken,subscribeToUrls:()=>({remove(){}})};
    expect(await runGoogleSignIn({...input,openAuthSession:async()=>({type:'opened'})})).toBe(recoveryToken);
    fetcher.mockClear();
    fetcher.mockImplementation(async (url, options) => {
      expect(options?.signal).toBeDefined();
      return new Response('{}', {status:url.endsWith('/cancel') ? 200 : 202});
    });
    await expect(runGoogleSignIn({...input,openAuthSession:async()=>{throw new Error('Browser could not open');}}))
      .rejects.toThrow('Browser could not open');
    expect(fetcher.mock.calls.some(([url])=>url.endsWith('/cancel'))).toBe(true);
  });
});
