import { describe, expect, it } from 'vitest';
import { authSessionOptions } from './auth-session';

describe('auth browser session', () => {
  it('bypasses Android’s retained Custom Tabs proxy for each fresh login', () => {
    expect(
      authSessionOptions('android', 'https://usebeeline.app/auth/github/mobile-callback'),
    ).toEqual({
      preferUniversalLinks: true,
      createTask: true,
      useProxyActivity: false,
    });
  });

  it('Reproduction 6c548392: restores Google above Beeline from the Android launcher', () => {
    expect(authSessionOptions('android', 'beeline://beeline/google-callback', 'google')).toEqual({
      preferUniversalLinks: false,
      createTask: false,
      showInRecents: true,
      useProxyActivity: false,
    });
  });

  it('keeps the native browser defaults on non-Android platforms', () => {
    expect(authSessionOptions('ios', 'beeline://beeline/github-callback')).toEqual({
      preferUniversalLinks: false,
    });
  });
});
