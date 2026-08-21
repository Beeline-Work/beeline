import { beforeEach, describe, expect, it, vi } from 'vitest';

const createURL = vi.hoisted(() => vi.fn((path: string) => `buzzy://${path}`));

vi.mock('expo-linking', () => ({ createURL }));

const { githubInstallationRedirectUri, githubSignInRedirectUri } =
  await import('./github-auth-session');

describe('GitHub auth session redirects', () => {
  beforeEach(() => createURL.mockClear());

  it('uses the installed app scheme for sign-in completion', () => {
    expect(githubSignInRedirectUri()).toBe('buzzy://buzz/github-callback');
    expect(createURL).toHaveBeenCalledWith('buzz/github-callback');
  });

  it('uses the installed app scheme for GitHub App installation completion', () => {
    expect(githubInstallationRedirectUri()).toBe('buzzy://buzz/github-installation');
    expect(createURL).toHaveBeenCalledWith('buzz/github-installation');
  });
});
