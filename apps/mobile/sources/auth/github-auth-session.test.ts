import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { noticeForAuthError } from './onboarding-state';

const createURL = vi.hoisted(() => vi.fn((path: string) => `beeline://${path}`));
const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-linking', () => ({ createURL }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
    removeItem: vi.fn(async (key: string) => void storage.delete(key)),
  },
}));

const {
  githubInstallationRedirectUri,
  githubRepositoryRefreshFeedback,
  githubInstallationReturnPath,
  githubSignInRedirectUri,
  loadPendingGitHubBindChallenge,
  persistGitHubInstallationReturnPath,
  persistGitHubSignInState,
  resumeInitialGitHubInstallation,
  resumeInitialGitHubSignIn,
  runGitHubInstallationSession,
  startGitHubSignInWebFlow,
} = await import('./github-auth-session');

const STATE = 's'.repeat(43);
const OTHER_STATE = 'x'.repeat(43);

function bindCallback(state = STATE, issuedAt = Math.floor(Date.now() / 1_000)): string {
  const params = new URLSearchParams({
    state,
    protocol: '1',
    kind: '24250',
    marker: 'beeline-oidc-bind-v1',
    ticket: 't'.repeat(43),
    challenge: 'c'.repeat(43),
    provider: 'https://github.com',
    audience: 'beeline-mobile',
    subject: '269599412',
    community: 'relay.buzzrouter.com',
    issued_at: String(issuedAt),
    expires_at: String(issuedAt + 120),
  });
  return `beeline://beeline/github-callback?${params}`;
}

describe('GitHub auth session redirects', () => {
  beforeEach(() => {
    createURL.mockClear();
    storage.clear();
  });

  it('uses the installed app scheme for sign-in completion', () => {
    expect(githubSignInRedirectUri()).toBe('beeline://beeline/github-callback');
    expect(createURL).toHaveBeenCalledWith('beeline/github-callback');
  });

  it('keeps monolith authorization on the monolith so GitHub returns there', () => {
    const start = startGitHubSignInWebFlow(STATE, {
      relayUrl: 'https://usebeeline.app',
      pushGatewayUrl: 'https://usebeeline.app/push',
      monolithUrl: 'https://server.usebeeline.app',
      monolithEnabled: true,
    });

    expect(new URL(start.authorizationUrl)).toMatchObject({
      origin: 'https://server.usebeeline.app',
      pathname: '/auth/github/start',
    });
    expect(start.redirectUri).toBe('beeline://beeline/github-callback');
  });

  it('leaves the legacy authorization origin unchanged outside monolith mode', () => {
    const start = startGitHubSignInWebFlow(STATE, {
      relayUrl: 'https://usebeeline.app',
      pushGatewayUrl: 'https://usebeeline.app/push',
      monolithUrl: 'https://server.usebeeline.app',
      monolithEnabled: false,
    });

    expect(new URL(start.authorizationUrl).origin).toBe('https://usebeeline.app');
  });

  it('uses the installed app scheme for GitHub App installation completion', () => {
    expect(githubInstallationRedirectUri()).toBe('beeline://beeline/github-installation');
    expect(createURL).toHaveBeenCalledWith('beeline/github-installation');
  });

  it('registers both app-generated deep links as Expo Router screens', () => {
    const signInRoute = new URL('../app/(app)/beeline/github-callback.tsx', import.meta.url);
    const installationRoute = new URL(
      '../app/(app)/beeline/github-installation.tsx',
      import.meta.url,
    );
    const layout = readFileSync(new URL('../app/(app)/_layout.tsx', import.meta.url), 'utf8');

    expect(existsSync(signInRoute)).toBe(true);
    expect(existsSync(installationRoute)).toBe(true);
    expect(layout).toContain('name="beeline/github-callback"');
    expect(layout).toContain('name="beeline/github-installation"');
  });

  it('keeps the previous callback routes registered during the transition', () => {
    const legacySignInRoute = new URL('../app/(app)/buzz/github-callback.tsx', import.meta.url);
    const legacyInstallationRoute = new URL(
      '../app/(app)/buzz/github-installation.tsx',
      import.meta.url,
    );
    const layout = readFileSync(new URL('../app/(app)/_layout.tsx', import.meta.url), 'utf8');

    expect(existsSync(legacySignInRoute)).toBe(true);
    expect(existsSync(legacyInstallationRoute)).toBe(true);
    expect(layout).toContain('name="buzz/github-callback"');
    expect(layout).toContain('name="buzz/github-installation"');
  });

  it('cold-starts from getInitialURL and validates the persisted sign-in state', async () => {
    await persistGitHubSignInState(STATE);

    const challenge = await resumeInitialGitHubSignIn(async () => bindCallback());

    expect(challenge).toMatchObject({
      provider: 'https://github.com',
      subject: '269599412',
    });
    await expect(loadPendingGitHubBindChallenge()).resolves.toMatchObject({
      provider: 'https://github.com',
      subject: '269599412',
    });
  });

  it('ignores an unrelated cold-start URL', async () => {
    await expect(
      resumeInitialGitHubSignIn(async () => 'beeline://beeline/channels'),
    ).resolves.toBeNull();
  });

  it('rejects a cold callback whose state does not match without consuming the real state', async () => {
    await persistGitHubSignInState(STATE);

    await expect(
      resumeInitialGitHubSignIn(async () => bindCallback(OTHER_STATE)),
    ).rejects.toMatchObject({ code: 'state_mismatch' });
    await expect(resumeInitialGitHubSignIn(async () => bindCallback())).resolves.toMatchObject({
      subject: '269599412',
    });
  });

  it('reports an expired cold callback as SESSION EXPIRED and clears it for a clean restart', async () => {
    const now = Math.floor(Date.now() / 1_000);
    await persistGitHubSignInState(STATE);

    const error = await resumeInitialGitHubSignIn(async () => bindCallback(STATE, now - 121)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'ticket_expired' });
    expect(noticeForAuthError(error)).toMatchObject({
      status: 'token_expired',
      title: 'SESSION EXPIRED · TICKET_EXPIRED',
      retryable: false,
    });
    await expect(resumeInitialGitHubSignIn(async () => bindCallback())).rejects.toMatchObject({
      code: 'state_mismatch',
    });
  });

  it('finishes installation from a warm Linking event when the browser reports dismiss', async () => {
    let onUrl: ((url: string) => void) | null = null;
    const callbackUrl = 'beeline://beeline/github-installation?installed=1';

    await expect(
      runGitHubInstallationSession({
        returnPath: '/beeline/channels',
        startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
        openAuthSession: async () => {
          queueMicrotask(() => onUrl?.(callbackUrl));
          return { type: 'dismiss' };
        },
        subscribeToUrls: (listener) => {
          onUrl = listener;
          return { remove: () => (onUrl = null) };
        },
        callbackGraceMs: 50,
      }),
    ).resolves.toBe(callbackUrl);
    await expect(githubInstallationReturnPath()).resolves.toBe('/beeline/channels');
    await expect(resumeInitialGitHubInstallation(async () => null)).resolves.toBe(true);
    await expect(githubInstallationReturnPath()).resolves.toBeNull();
  });

  it('finishes installation from the direct browser return', async () => {
    const callbackUrl = 'beeline://beeline/github-installation?installed=1';

    await expect(
      runGitHubInstallationSession({
        returnPath: '/beeline/channels',
        startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
        openAuthSession: async () => ({ type: 'success', url: callbackUrl }),
        subscribeToUrls: () => ({ remove: () => undefined }),
      }),
    ).resolves.toBe(callbackUrl);
    await expect(githubInstallationReturnPath()).resolves.toBeNull();
  });

  it('clears installation resume state when the browser is canceled', async () => {
    await expect(
      runGitHubInstallationSession({
        returnPath: '/beeline/channels',
        startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
        openAuthSession: async () => ({ type: 'cancel' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        callbackGraceMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'browser_canceled' });
    await expect(githubInstallationReturnPath()).resolves.toBeNull();
  });

  it('refreshes repositories on foreground return and treats dismissal as an unknown completion', async () => {
    let onAppState: ((state: string) => void) | null = null;
    let finishBrowser: ((result: { type: string }) => void) | null = null;
    const refreshRepositories = vi.fn(async () => undefined);
    const phases: string[] = [];
    const session = runGitHubInstallationSession({
      returnPath: '/beeline/channels',
      startInstallation: async () => 'https://github.com/settings/installations/7',
      openAuthSession: () =>
        new Promise((resolve) => {
          finishBrowser = resolve;
        }),
      subscribeToUrls: () => ({ remove: () => undefined }),
      subscribeToAppState: (listener) => {
        onAppState = listener;
        return { remove: () => (onAppState = null) };
      },
      refreshRepositories,
      onRefreshPhase: (phase) => phases.push(phase),
      callbackGraceMs: 0,
    });

    await vi.waitFor(() => expect(onAppState).not.toBeNull());
    onAppState?.('background');
    onAppState?.('active');
    await vi.waitFor(() => expect(refreshRepositories).toHaveBeenCalledTimes(1));
    finishBrowser?.({ type: 'dismiss' });

    await expect(session).resolves.toBeNull();
    expect(phases).toContain('refreshed');
    expect(refreshRepositories).toHaveBeenCalledTimes(1);
  });

  it('does not report an awaiting or refreshing repository list as a configuration error', () => {
    expect(githubRepositoryRefreshFeedback('awaiting_return')).toMatchObject({ error: null });
    expect(githubRepositoryRefreshFeedback('refreshing')).toMatchObject({ error: null });
    expect(githubRepositoryRefreshFeedback('refresh_failed')).toMatchObject({
      notice: null,
      error: expect.stringContaining('Could not refresh repositories'),
    });
  });

  it('rejects an installation callback that does not report completion', async () => {
    await persistGitHubInstallationReturnPath('/beeline/channels');

    await expect(
      resumeInitialGitHubInstallation(async () =>
        Promise.resolve('beeline://beeline/github-installation?installed=0'),
      ),
    ).rejects.toMatchObject({ code: 'invalid_installation' });
  });

  it('resumes a cold installation callback at the repo picker that launched it', async () => {
    await persistGitHubInstallationReturnPath('/beeline/chat/room-1');
    expect(await githubInstallationReturnPath()).toBe('/beeline/chat/room-1');

    await expect(
      resumeInitialGitHubInstallation(async () =>
        Promise.resolve('beeline://beeline/github-installation?installed=1'),
      ),
    ).resolves.toBe(true);
    await expect(githubInstallationReturnPath()).resolves.toBeNull();
  });
});
