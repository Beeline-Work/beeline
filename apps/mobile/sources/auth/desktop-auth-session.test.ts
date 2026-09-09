import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-linking', () => ({ getInitialURL: vi.fn() }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));

import { desktopAuthRedirectUri } from './desktop-auth-redirect';

describe('desktop account callback', () => {
  it('uses the server-allowlisted Beeline deep link instead of the Tauri web origin', () => {
    expect(desktopAuthRedirectUri('github-callback', 'tauri://localhost/callback', true)).toBe(
      'beeline://beeline/github-callback',
    );
  });
});
