import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
} }));
import { captureGooglePreviewUrl, captureWebGooglePreview, readAuthCapabilities, watchGooglePreview } from './google-preview';
import { redirectSystemPath } from '../app/+native-intent';
const token = 'p'.repeat(43);
describe('Google preview enrollment', () => {
  beforeEach(() => { storage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('persists a web preview, removes it before navigation, and sends it only as a capabilities header', async () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', { location: { href: `https://web.usebeeline.app/?google_preview=${token}&invite=keep` }, history: { state: null, replaceState } });
    captureWebGooglePreview();
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://web.usebeeline.app/?invite=keep');
    vi.unstubAllGlobals();
    const fetcher = vi.fn(async () => new Response('{"google":true}'));
    vi.stubGlobal('fetch', fetcher);
    expect(await readAuthCapabilities('https://server.test')).toEqual({ google: true });
    expect(fetcher).toHaveBeenCalledWith('https://server.test/auth/capabilities', expect.objectContaining({ headers: { 'x-beeline-google-preview': token } }));
    // A subsequent load uses the stored enrollment without a link.
    expect(await readAuthCapabilities('https://server.test')).toEqual({ google: true });
  });
  it('cold and warm native preview links persist before routing and notify mounted screens', async () => {
    const changed = vi.fn();
    const stop = watchGooglePreview(changed);
    expect(await redirectSystemPath({ path: `beeline://beeline/onboarding?google_preview=${token}`, initial: true })).toBe('beeline://beeline/onboarding');
    expect(changed).toHaveBeenCalledOnce();
    expect(await redirectSystemPath({ path: `beeline://join/invite?google_preview=${token}`, initial: false })).toBe('beeline://join/invite');
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
  });
  it('without enrollment or with a malformed link it sends no preview header', async () => {
    const captured = captureGooglePreviewUrl('beeline://beeline/onboarding?google_preview=bad&keep=1');
    expect(captured.url).toBe('beeline://beeline/onboarding?keep=1');
    await captured.saved;
    const fetcher = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    expect(await readAuthCapabilities('https://server.test')).toEqual({});
    expect(fetcher).toHaveBeenCalledWith('https://server.test/auth/capabilities', expect.objectContaining({ headers: {} }));
  });
  it('duplicate tokens are stripped without enrolling, and ordinary links are unchanged', async () => {
    const captured = captureGooglePreviewUrl(`https://web.usebeeline.app/?google_preview=${token}&google_preview=${token}`);
    expect(captured.url).toBe('https://web.usebeeline.app/');
    await captured.saved;
    expect(storage.size).toBe(0);
    expect(captureGooglePreviewUrl('/beeline/onboarding').url).toBe('/beeline/onboarding');
  });
});
