import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

describe('GitHub-only mobile sign-in surface', () => {
  it('starts monolith sign-in on the monolith auth host', () => {
    expect(source('app/(app)/buzz/onboarding.tsx')).toContain(
      'startGitHubBind(getBuzzRuntimeConfig().monolithUrl',
    );
  });

  it('has no legacy callback routes or provider-selection module', () => {
    expect(existsSync(new URL('../app/(app)/buzz/oidc-callback.tsx', import.meta.url))).toBe(false);
    expect(
      existsSync(new URL('../app/(app)/auth/oidc/mobile-callback.tsx', import.meta.url)),
    ).toBe(false);
    expect(existsSync(new URL('./sign-in-provider.ts', import.meta.url))).toBe(false);
  });

  it('leaves no legacy-named sign-in symbol or provider branch in mobile sources', () => {
    const signInSources = [
      source('app/(app)/buzz/onboarding.tsx'),
      source('app/(app)/buzz/channels.tsx'),
      source('app/(app)/buzz/chat/[channelId].tsx'),
      source('app/(app)/buzz/settings/identity.tsx'),
      source('app/(app)/_layout.tsx'),
      source('auth/github-auth-session.ts'),
      source('auth/onboarding-state.ts'),
      source('auth/auth-session.ts'),
      readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8'),
    ].join('\n');

    const forbiddenNames = [
      ['Goo', 'gleOnboarding'].join(''),
      ['goo', 'gleAuthSessionOptions'].join(''),
      ['waitFor', 'Goo', 'gleAuthCallback'].join(''),
      ['start', 'OidcBind'].join(''),
      'getAuthCapabilities',
      ['Native', 'SignInProvider'].join(''),
      ['Continue with ', 'Goo', 'gle'].join(''),
      ['buzz/', 'oidc-callback'].join(''),
      ['auth/oidc/', 'mobile-callback'].join(''),
    ];
    for (const name of forbiddenNames) expect(signInSources).not.toContain(name);
  });
});
