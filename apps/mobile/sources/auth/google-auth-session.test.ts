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
    let nativeRecoveryToken = '';
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/native/start')) return new Response(JSON.stringify({
        state, nonce: 'n'.repeat(43), serverClientId: 'server.apps.googleusercontent.com',
      }));
      expect(url).toBe('https://server.example/auth/oidc/native/complete');
      const body = JSON.parse(options!.body as string);
      nativeRecoveryToken = body.recoveryToken;
      expect(nativeRecoveryToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(nativeRecoveryToken).not.toBe(recoveryToken);
      expect(body).toEqual({ state, recoveryToken: nativeRecoveryToken, idToken: 'signed-google-id-token' });
      return new Response(JSON.stringify({ completed: true }));
    });
    vi.stubGlobal('fetch', fetcher);
    const open = vi.fn();
    const result = await runGoogleSignIn({ state, recoveryToken, linkIdentity: 'existing-account',
      openAuthSession: open, subscribeToUrls: () => ({ remove() {} }),
    });
    expect(result).toBe(nativeRecoveryToken);
    expect(JSON.parse(storage.get('beeline.google-sign-in.v1')!).recoveryToken).toBe(nativeRecoveryToken);
    expect(picker.signIn).toHaveBeenCalledWith('server.apps.googleusercontent.com', 'n'.repeat(43));
    expect(open).not.toHaveBeenCalled();
    expect(await pendingGoogleLinkIdentity()).toBe('existing-account');
  });
  it.each([
    'unregistered signing key', 'DEVELOPER_ERROR', 'no Google account',
    'native user cancel', 'unexpected native failure', 'missing native start route',
    'missing Android client configuration', 'missing native complete route',
    'rejected native proof', 'malformed native configuration', 'malformed native completion', 'failed native cleanup',
  ])('R-signin-fallback: completes browser sign-in after %s', async (failure) => {
    picker.enabled = true;
    picker.signIn.mockResolvedValue('signed-google-id-token');
    const pickerFailures: Record<string, unknown> = {
      'unregistered signing key': { code: 'GOOGLE_UNAVAILABLE' },
      'DEVELOPER_ERROR': { code: 'DEVELOPER_ERROR' },
      'no Google account': { code: 'NO_CREDENTIAL' },
      'native user cancel': { code: 'GOOGLE_CANCELLED' },
      'unexpected native failure': new Error('native error'),
      'failed native cleanup': new Error('native error'),
    };
    if (failure in pickerFailures) picker.signIn.mockRejectedValue(pickerFailures[failure]);
    let nativeChallenge = '';
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      const body = JSON.parse(options!.body as string);
      if (url.endsWith('/native/start')) {
        nativeChallenge = body.recoveryChallenge;
        if (failure === 'missing native start route') return new Response('{}', { status: 404 });
        if (failure === 'missing Android client configuration') return new Response('{}', { status: 503 });
        return new Response(JSON.stringify(failure === 'malformed native configuration' ? {} : {
          state, nonce: 'n'.repeat(43), serverClientId: 'server.apps.googleusercontent.com',
        }));
      }
      if (url.endsWith('/native/complete')) return new Response('{}', { status:
        failure === 'missing native complete route' ? 404 : failure === 'malformed native completion' ? 200 : 401 });
      if (url.endsWith('/completion/cancel')) {
        expect(body.recoveryToken).not.toBe(recoveryToken);
        return new Response(null, { status: failure === 'failed native cleanup' ? 500 : 204 });
      }
      expect(url).toBe('https://server.example/auth/oidc/completion');
      return new Response('{}', { status: body.recoveryToken === recoveryToken ? 200 : 202 });
    });
    vi.stubGlobal('fetch', fetcher);
    const open = vi.fn(async (url: string) => {
      const browser = new URL(url);
      expect(browser.pathname).toBe('/auth/oidc/start');
      // The native flow row keeps its unique recovery hash after cancellation.
      // Reusing it would reject this browser start even when cleanup succeeds.
      expect(browser.searchParams.get('app_recovery_challenge')).not.toBe(nativeChallenge);
      expect(browser.searchParams.get('app_state')).toBe(state);
      expect(JSON.parse(storage.get('beeline.google-sign-in.v1')!)).toMatchObject({
        recoveryToken, linkIdentity: 'existing-account',
      });
      return { type: 'opened' };
    });
    expect(await runGoogleSignIn({ state, recoveryToken, linkIdentity: 'existing-account', openAuthSession: open,
      subscribeToUrls: () => ({ remove() {} }),
    })).toBe(recoveryToken);
    expect(open).toHaveBeenCalledOnce();
    expect(await pendingGoogleLinkIdentity()).toBe('existing-account');
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
  it('recovers a committed native ticket when the completion response is lost, without opening a browser', async () => {
    picker.enabled = true;
    picker.signIn.mockResolvedValue('signed-google-id-token');
    let nativeRecoveryToken = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/native/start')) return new Response(JSON.stringify({
        state, nonce: 'n'.repeat(43), serverClientId: 'server.apps.googleusercontent.com',
      }));
      const body = JSON.parse(options!.body as string);
      if (url.endsWith('/native/complete')) {
        nativeRecoveryToken = body.recoveryToken;
        throw new TypeError('Response lost after commit');
      }
      expect(url).toBe('https://server.example/auth/oidc/completion');
      expect(body.recoveryToken).toBe(nativeRecoveryToken);
      return new Response('{}');
    }));
    const open = vi.fn();
    const result = await runGoogleSignIn({ state, recoveryToken, openAuthSession: open,
      subscribeToUrls: () => ({ remove() {} }),
    });
    expect(result).toBe(nativeRecoveryToken);
    expect(open).not.toHaveBeenCalled();
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
