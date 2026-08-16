import { describe, expect, it } from 'vitest';
import { googleAuthSessionOptions } from './google-auth-session';

describe('Google auth browser session', () => {
  it('bypasses Android’s retained Custom Tabs proxy for each fresh login', () => {
    expect(
      googleAuthSessionOptions('android', 'https://relay.buzzrouter.com/auth/oidc/mobile-callback'),
    ).toEqual({
      preferUniversalLinks: true,
      createTask: true,
      useProxyActivity: false,
    });
  });

  it('keeps the native browser defaults on non-Android platforms', () => {
    expect(googleAuthSessionOptions('ios', 'buzzy://buzz/oidc-callback')).toEqual({
      preferUniversalLinks: false,
    });
  });
});
