import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-linking', () => ({ getInitialURL: vi.fn() }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));

vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => false }));
const funnel = vi.hoisted(() => ({ callback: vi.fn() }));
vi.mock('./signin-funnel', () => ({ beginFunnelAttempt: vi.fn(), funnelCallback: funnel.callback }));
import * as WebBrowser from 'expo-web-browser';
import { openAccountAuthSession } from './desktop-auth-session';

import { desktopAuthRedirectUri } from './desktop-auth-redirect';

describe('desktop account callback', () => {
  it('uses the server-allowlisted Beeline deep link instead of the Tauri web origin', () => {
    expect(desktopAuthRedirectUri('github-callback', 'tauri://localhost/callback', true)).toBe(
      'beeline://beeline/github-callback',
    );
  });
});

describe('Google browser close outcomes', () => {
  it.each(['dismiss', 'cancel'])('leaves %s classification to server recovery', async (type) => {
    funnel.callback.mockClear();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({ type } as never);
    await expect(openAccountAuthSession('https://server.example/auth/oidc/start?funnel=test',
      'beeline://beeline/google-callback', {})).resolves.toEqual({ type });
    expect(funnel.callback).not.toHaveBeenCalled();
  });
});
