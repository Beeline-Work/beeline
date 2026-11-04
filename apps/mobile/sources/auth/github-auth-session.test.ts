import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  isPendingGitHubReconnect,
  cancelPendingGitHubSignIn,
  clearPendingGitHubSignInState,
  githubInstallationRedirectUri,
  githubRepositoryRefreshFeedback,
  githubInstallationReturnPath,
  completeGitHubInstallationRoute,
  githubSignInRedirectUri,
  loadPendingGitHubBindChallenge,
  persistGitHubInstallationReturnPath,
  persistGitHubSignInState,
  recoverPendingGitHubBindChallenge,
  resumeInitialGitHubInstallation,
  resumeInitialGitHubSignIn,
  runResilientGitHubSignInSession,
  runGitHubInstallationSession,
  startGitHubSignInWebFlow,
} = await import('./github-auth-session');

const STATE = 's'.repeat(43);
const OTHER_STATE = 'x'.repeat(43);
const RECOVERY_TOKEN = 'r'.repeat(43);

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

function recoveryResponse(issuedAt = Math.floor(Date.now() / 1_000)): Response {
  return new Response(
    JSON.stringify({
      protocol: 1,
      kind: 24250,
      marker: 'beeline-oidc-bind-v1',
      ticket: RECOVERY_TOKEN,
      challenge: 'c'.repeat(43),
      provider: 'https://github.com',
      audience: 'github',
      subject: '269599412',
      community: 'stable-identity-namespace',
      issued_at: issuedAt,
      expires_at: issuedAt + 120,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** The auth server answers its reachability probe; every other request reaches `fetchImpl`. */
function reachable(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => unknown,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/healthz')
      ? new Response(null, { status: 200 })
      : fetchImpl(input, init)) as typeof fetch;
}

const MONOLITH_RUNTIME = {
  relayUrl: 'https://usebeeline.app',
  pushGatewayUrl: 'https://usebeeline.app/push',
  monolithUrl: 'https://server.usebeeline.app',
};

describe('GitHub sign-in without a network', () => {
  beforeEach(() => storage.clear());

  it('surfaces actual completion failure without an extra health probe', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Network request failed'); });
    const openAuthSession = vi.fn(async () => ({ type: 'dismiss' }));
    await expect(runResilientGitHubSignInSession({ state: STATE, recoveryToken: RECOVERY_TOKEN,
      runtime: MONOLITH_RUNTIME, openAuthSession, subscribeToUrls: () => ({ remove() {} }),
      fetchImpl: fetchImpl as unknown as typeof fetch, callbackGraceMs: 0,
    })).rejects.toMatchObject({ code: 'offline', status: undefined });
    expect(openAuthSession).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith('/auth/github/completion'))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // Initial hold and actual browser-close boundary.
    expect(storage.has('buzzy.github-sign-in-session.v2')).toBe(true);
  });

  it('one failed held observation parks until the terminal ceremony deadline', async () => {
    const completion = vi.fn(async () => { throw new TypeError('Network request failed'); });
    await expect(runResilientGitHubSignInSession({ state: STATE, recoveryToken: RECOVERY_TOKEN,
      runtime: MONOLITH_RUNTIME, openAuthSession: async () => ({ type: 'opened' }),
      subscribeToUrls: () => ({ remove() {} }), fetchImpl: completion as unknown as typeof fetch,
      recoveryWaitMs: 10,
    })).rejects.toMatchObject({ code: 'offline' });
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it('keeps a stale recovery token and reports offline when its revocation cannot reach the server', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    const unreachable = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });

    await expect(
      cancelPendingGitHubSignIn(MONOLITH_RUNTIME, unreachable as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'offline', status: undefined });
    expect(storage.get('buzzy.github-sign-in-recovery.v1')).toBe(RECOVERY_TOKEN);
  });

  it('stops cold callback recovery offline without background retries', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.useFakeTimers();
    try {
      const pending = resumeInitialGitHubSignIn(
        async () => `beeline://beeline/github-callback?state=${STATE}&completed=1`,
      );
      const outcome = expect(pending).rejects.toMatchObject({ code: 'offline', status: undefined });
      await vi.advanceTimersByTimeAsync(11_000);
      await outcome;
      const requestsAtNotice = fetchImpl.mock.calls.length;
      expect(requestsAtNotice).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchImpl).toHaveBeenCalledTimes(requestsAtNotice);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('refuses a cold callback if another sign-in replaces its pending state during inspection', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    const fetchImpl = vi.fn(async () => {
      await persistGitHubSignInState(OTHER_STATE, 'signin', 'n'.repeat(43));
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(
        resumeInitialGitHubSignIn(
          async () => `beeline://beeline/github-callback?state=${STATE}&completed=1`,
        ),
      ).rejects.toMatchObject({ code: 'state_mismatch' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(storage.get('buzzy.github-sign-in-session.v2')!)).toMatchObject({
        state: OTHER_STATE,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('GitHub auth session redirects', () => {
  beforeEach(() => {
    createURL.mockClear();
    storage.clear();
  });

  it('uses the installed app scheme for sign-in completion', () => {
    expect(githubSignInRedirectUri()).toBe('beeline://beeline/github-callback');
    expect(createURL).toHaveBeenCalledWith('beeline/github-callback');
  });

  it('keeps the Expo web callback on the page origin', () => {
    createURL.mockReturnValueOnce('https://web.usebeeline.app/beeline/github-callback');

    expect(githubSignInRedirectUri()).toBe('https://web.usebeeline.app/beeline/github-callback');
  });

  it('keeps monolith authorization on the monolith so GitHub returns there', () => {
    const start = startGitHubSignInWebFlow(
      STATE,
      {
        relayUrl: 'https://usebeeline.app',
        pushGatewayUrl: 'https://usebeeline.app/push',
        monolithUrl: 'https://server.usebeeline.app',
      },
      RECOVERY_TOKEN,
    );

    expect(new URL(start.authorizationUrl)).toMatchObject({
      origin: 'https://server.usebeeline.app',
      pathname: '/auth/github/start',
    });
    expect(start.redirectUri).toBe('beeline://beeline/github-callback');
    expect(new URL(start.authorizationUrl).searchParams.get('app_recovery_challenge')).toBe(
      createHash('sha256').update(RECOVERY_TOKEN).digest('hex'),
    );
    expect(start.authorizationUrl).not.toContain(RECOVERY_TOKEN);
  });

  it('recovers a completed authorization when the initiating app receives no deep link', async () => {
    const fetchImpl = vi.fn(async () => recoveryResponse());

    const challenge = await runResilientGitHubSignInSession({
      state: STATE,
      recoveryToken: RECOVERY_TOKEN,
      runtime: {
        relayUrl: 'https://usebeeline.app',
        pushGatewayUrl: 'https://usebeeline.app/push',
        monolithUrl: 'https://server.usebeeline.app',
      },
      openAuthSession: async () => ({ type: 'dismiss' }),
      subscribeToUrls: () => ({ remove: () => undefined }),
      fetchImpl: reachable(fetchImpl),
      callbackGraceMs: 0,
      recoveryWaitMs: 0,
    });

    expect(challenge.ticket).toBe(RECOVERY_TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://server.usebeeline.app/auth/github/completion',
    );
  });

  it('keeps the ordinary deep-link path prompt without waiting for recovery', async () => {
    const fetchImpl = vi.fn();
    const challenge = await runResilientGitHubSignInSession({
      state: STATE,
      recoveryToken: RECOVERY_TOKEN,
      runtime: {
        relayUrl: 'https://usebeeline.app',
        pushGatewayUrl: 'https://usebeeline.app/push',
        monolithUrl: 'https://server.usebeeline.app',
      },
      openAuthSession: async () => ({ type: 'success', url: bindCallback() }),
      subscribeToUrls: () => ({ remove: () => undefined }),
      fetchImpl: reachable(fetchImpl),
    });

    expect(challenge.ticket).toBe('t'.repeat(43));
    expect(fetchImpl).toHaveBeenCalledTimes(1); // One held completion joins the callback.
  });

  it('uses an immediate completion check when the current server deep link arrives', async () => {
    const fetchImpl = vi.fn(async () => recoveryResponse());
    const challenge = await runResilientGitHubSignInSession({
      state: STATE,
      recoveryToken: RECOVERY_TOKEN,
      runtime: {
        relayUrl: 'https://usebeeline.app',
        pushGatewayUrl: 'https://usebeeline.app/push',
        monolithUrl: 'https://server.usebeeline.app',
      },
      openAuthSession: async () => ({
        type: 'success',
        url: `beeline://beeline/github-callback?state=${STATE}&completed=1`,
      }),
      subscribeToUrls: () => ({ remove: () => undefined }),
      fetchImpl: reachable(fetchImpl),
    });

    expect(challenge.ticket).toBe(RECOVERY_TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('holds one completion request across two minutes instead of scheduling recovery reads', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (response: Response) => void;
      const response = new Promise<Response>(resolve => { finish = resolve; });
      const fetchImpl = vi.fn(async () => response);
      const pending = runResilientGitHubSignInSession({ state: STATE, recoveryToken: RECOVERY_TOKEN,
        runtime: MONOLITH_RUNTIME, openAuthSession: async () => ({ type: 'opened' }),
        subscribeToUrls: () => ({ remove() {} }), fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(119_999); expect(fetchImpl).toHaveBeenCalledTimes(1);
      finish(recoveryResponse()); await expect(pending).resolves.toMatchObject({ ticket: RECOVERY_TOKEN });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('uses an actual callback boundary after a failed held observation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(recoveryResponse());

    await expect(
      runResilientGitHubSignInSession({
        state: STATE,
        recoveryToken: RECOVERY_TOKEN,
        openAuthSession: async () => ({
          type: 'success',
          url: `beeline://beeline/github-callback?state=${STATE}&completed=1`,
        }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        fetchImpl: reachable(fetchImpl),
      }),
    ).resolves.toMatchObject({ ticket: RECOVERY_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://server.usebeeline.app/auth/github/completion',
      'https://server.usebeeline.app/auth/github/completion',
    ]);
  });

  it('an old server immediate-pending reply never schedules another observation', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => new Response(null,
      { status: String(url).endsWith('/cancel') ? 204 : 202 }));
    await expect(runResilientGitHubSignInSession({ state: STATE, recoveryToken: RECOVERY_TOKEN,
      runtime: MONOLITH_RUNTIME, openAuthSession: async () => ({ type: 'opened' }),
      subscribeToUrls: () => ({ remove() {} }), fetchImpl: fetchImpl as typeof fetch, recoveryWaitMs: 10,
    })).rejects.toMatchObject({ code: 'ticket_expired' });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/completion'))).toHaveLength(1);
  });

  it.each(['cancel', 'dismiss'])('Reproduction signin-appswitch: Android %s on foreground keeps the link and recovery alive', async (type) => {
    vi.useFakeTimers();
    let link: ((url: string) => void) | undefined;
    const removed = vi.fn();
    const closed = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response('{}', {
      status: String(input).endsWith('/cancel') ? 200 : 202,
    }));
    try {
      const result = runResilientGitHubSignInSession({
        state: STATE, recoveryToken: RECOVERY_TOKEN, platform: 'android', onBrowserClosed: closed,
        runtime: MONOLITH_RUNTIME,
        // Expo resolves this result when Android brings the app to the foreground.
        openAuthSession: async () => ({ type }),
        subscribeToUrls: (listener) => { link = listener; return { remove: removed }; },
        fetchImpl: reachable(fetchImpl),
      });
      const outcome = result.then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(21_000);
      expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
      expect(link).toBeDefined();
      expect(closed).toHaveBeenCalledOnce();
      link!(bindCallback());
      await vi.advanceTimersByTimeAsync(250);
      expect(await outcome).toMatchObject({ value: { ticket: 't'.repeat(43) } });
      expect(removed).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('Reproduction signin-appswitch: replacing a waiting Android attempt preserves the newer recovery', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const nextToken = 'q'.repeat(43);
    let complete = false;
    const fetcher = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      const token = JSON.parse(options!.body as string).recoveryToken;
      if (String(url).endsWith('/cancel')) return new Response(null, { status: 204 });
      if (complete && token === nextToken) {
        const response = await recoveryResponse().json();
        return new Response(JSON.stringify({ ...response, ticket: nextToken }));
      }
      return new Response('{}', { status: 202 });
    });
    let callback!: (url: string) => void;
    const input = { runtime: MONOLITH_RUNTIME, platform: 'android', openAuthSession: async () => ({ type: 'dismiss' }),
      subscribeToUrls: (listener: (url: string) => void) => { callback = listener; return { remove() {} }; }, fetchImpl: reachable(fetcher) };
    try {
      const old = runResilientGitHubSignInSession({ ...input, state: STATE, recoveryToken: RECOVERY_TOKEN, signal: controller.signal }).catch(error => error);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
      controller.abort();
      const next = runResilientGitHubSignInSession({ ...input, state: OTHER_STATE, recoveryToken: nextToken });
      const nextOutcome = next.then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await old).toMatchObject({ code: 'browser_canceled' });
      expect(JSON.parse(storage.get('buzzy.github-sign-in-session.v2')!)).toMatchObject({ state: OTHER_STATE, recoveryToken: nextToken });
      const revoked = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/cancel')).map(([, options]) => JSON.parse(options!.body as string).recoveryToken);
      expect(revoked.length).toBeGreaterThan(0);
      expect(revoked.every(token => token === RECOVERY_TOKEN)).toBe(true);
      complete = true;
      callback(`beeline://beeline/github-callback?state=${OTHER_STATE}&completed=1`);
      await vi.advanceTimersByTimeAsync(250);
      expect(await nextOutcome).toMatchObject({ value: { ticket: nextToken } });
    } finally { vi.useRealTimers(); }
  });

  it('Reproduction gh3: frees sign-in within 2 s when the person leaves GitHub and the server stays pending', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/cancel')
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }));
    const startedAt = Date.now();

    await expect(
      runResilientGitHubSignInSession({
        state: STATE,
        recoveryToken: RECOVERY_TOKEN,
        runtime: MONOLITH_RUNTIME,
        openAuthSession: async () => ({ type: 'dismiss' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        fetchImpl: reachable(fetchImpl),
        recoveryWaitMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'browser_canceled' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe(
      'https://server.usebeeline.app/auth/github/completion/cancel',
    );
  }, 10_000);

  it('Reproduction gh3: still signs in when the browser closed and the completion lands after a pending read', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(recoveryResponse());

    await expect(
      runResilientGitHubSignInSession({
        state: STATE,
        recoveryToken: RECOVERY_TOKEN,
        runtime: MONOLITH_RUNTIME,
        openAuthSession: async () => ({ type: 'dismiss' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        fetchImpl: reachable(fetchImpl),
        callbackGraceMs: 0,
      }),
    ).resolves.toMatchObject({ ticket: RECOVERY_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a 410 completion response as terminal expiry and cancels recovery', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      runResilientGitHubSignInSession({
        state: STATE,
        recoveryToken: RECOVERY_TOKEN,
        openAuthSession: async () => ({
          type: 'success',
          url: `beeline://beeline/github-callback?state=${STATE}&completed=1`,
        }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        fetchImpl: reachable(fetchImpl),
      }),
    ).rejects.toMatchObject({ code: 'ticket_expired' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://server.usebeeline.app/auth/github/completion/cancel',
    );
  });

  it('cancels instead of retrying a terminal completion protocol failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      runResilientGitHubSignInSession({
        state: STATE,
        recoveryToken: RECOVERY_TOKEN,
        openAuthSession: async () => ({
          type: 'success',
          url: `beeline://beeline/github-callback?state=${STATE}&completed=1`,
        }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        fetchImpl: reachable(fetchImpl),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://server.usebeeline.app/auth/github/completion/cancel',
    );
  });

  it('cancels a timed-out recovery so retry cannot inherit a reusable credential', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      runResilientGitHubSignInSession({
        state: STATE,
        recoveryToken: RECOVERY_TOKEN,
        runtime: {
          relayUrl: 'https://usebeeline.app',
          pushGatewayUrl: 'https://usebeeline.app/push',
          monolithUrl: 'https://server.usebeeline.app',
        },
        openAuthSession: async () => ({ type: 'dismiss' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        fetchImpl: reachable(fetchImpl),
        callbackGraceMs: 0,
        recoveryWaitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'ticket_expired' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://server.usebeeline.app/auth/github/completion/cancel',
    );
  });

  it('keeps a recovered token until downstream failure cancellation is confirmed', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    const runtime = {
      relayUrl: 'https://usebeeline.app',
      pushGatewayUrl: 'https://usebeeline.app/push',
      monolithUrl: 'https://server.usebeeline.app',
    };
    const failedCancel = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(
      cancelPendingGitHubSignIn(runtime, failedCancel as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'offline' });
    expect(storage.get('buzzy.github-sign-in-recovery.v1')).toBe(RECOVERY_TOKEN);

    const confirmedCancel = vi.fn(async () => new Response(null, { status: 204 }));
    await cancelPendingGitHubSignIn(runtime, confirmedCancel as unknown as typeof fetch);
    expect(storage.has('buzzy.github-sign-in-recovery.v1')).toBe(false);
    expect(storage.has('buzzy.github-sign-in-state.v1')).toBe(false);
  });

  it('preserves recovery state across a retryable resume read failure', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    const interruptedRead = vi.fn(async () => {
      throw new TypeError('network interrupted');
    });

    await expect(
      recoverPendingGitHubBindChallenge(undefined, interruptedRead as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'offline', retryable: true });
    expect(storage.get('buzzy.github-sign-in-recovery.v1')).toBe(RECOVERY_TOKEN);
    expect(storage.get('buzzy.github-sign-in-state.v1')).toBe(STATE);

    await expect(
      recoverPendingGitHubBindChallenge(
        undefined,
        vi.fn(async () => recoveryResponse()) as unknown as typeof fetch,
      ),
    ).resolves.toMatchObject({ ticket: RECOVERY_TOKEN });
  });

  it('does not let a late recovery overwrite a newer sign-in session', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    let finishRecovery: ((response: Response) => void) | undefined;
    const delayedRecovery = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    const staleRecovery = recoverPendingGitHubBindChallenge(
      undefined,
      delayedRecovery as unknown as typeof fetch,
    );
    await vi.waitFor(() => expect(delayedRecovery).toHaveBeenCalledTimes(1));

    const newerRecoveryToken = 'q'.repeat(43);
    await persistGitHubSignInState(OTHER_STATE, 'signin', newerRecoveryToken);
    finishRecovery?.(recoveryResponse());

    await expect(staleRecovery).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(JSON.parse(storage.get('buzzy.github-sign-in-session.v2') ?? '{}')).toEqual({
      state: OTHER_STATE,
      purpose: 'signin',
      recoveryToken: newerRecoveryToken,
    });
    expect(storage.has('buzzy.github-sign-in-callback.v1')).toBe(false);

    const cancel = vi.fn();
    await cancelPendingGitHubSignIn(undefined, cancel as unknown as typeof fetch, STATE);
    expect(cancel).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get('buzzy.github-sign-in-session.v2') ?? '{}')).toMatchObject({
      state: OTHER_STATE,
      recoveryToken: newerRecoveryToken,
    });
  });

  it('cancels explicitly and clears recovery only after the server confirms it', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await cancelPendingGitHubSignIn(undefined, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://server.usebeeline.app/auth/github/completion/cancel',
    );
    expect(storage.has('buzzy.github-sign-in-recovery.v1')).toBe(false);
    expect(storage.has('buzzy.github-sign-in-state.v1')).toBe(false);
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

  it('ignores a completed launch callback retained across OTA reload when the device is signed in', async () => {
    await persistGitHubSignInState(STATE);
    await resumeInitialGitHubSignIn(async () => bindCallback());
    await clearPendingGitHubSignInState();
    await expect(resumeInitialGitHubSignIn(async () => bindCallback(), undefined, { signedIn: true })).resolves.toBeNull();
  });

  it('keeps state validation for a new pending flow even on a signed-in device', async () => {
    await persistGitHubSignInState(STATE);
    await expect(resumeInitialGitHubSignIn(async () => bindCallback(OTHER_STATE), undefined, { signedIn: true }))
      .rejects.toMatchObject({ code: 'state_mismatch' });
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
      title: 'Sign-in expired',
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

  it.each(['/beeline/channels', '/beeline/settings/identity', '/beeline/settings', '/beeline/chat/room-1?repositoryPicker=card-1'])(
    'R-onb-11: connects GitHub and returns to %s', async (returnPath) => {
    const callbackUrl = 'beeline://beeline/github-installation?installed=1';

    await expect(
      runGitHubInstallationSession({
        returnPath,
        startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
        openAuthSession: async () => ({ type: 'success', url: callbackUrl }),
        subscribeToUrls: () => ({ remove: () => undefined }),
      }),
    ).resolves.toBe(callbackUrl);
    await expect(githubInstallationReturnPath()).resolves.toBe(returnPath);
  });

  it('retains installation resume state when the browser is canceled', async () => {
    await expect(
      runGitHubInstallationSession({
        returnPath: '/beeline/channels',
        startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
        openAuthSession: async () => ({ type: 'cancel' }),
        subscribeToUrls: () => ({ remove: () => undefined }),
        callbackGraceMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'browser_canceled' });
    await expect(githubInstallationReturnPath()).resolves.toBe('/beeline/channels');
  });

  it.each(['/beeline/settings/identity?next=elsewhere', '/beeline/settings/identity/extra',
    '//evil.example/settings', 'https://evil.example/beeline/settings']) (
    'rejects an untrusted installation return path: %s', async (returnPath) => {
      await expect(persistGitHubInstallationReturnPath(returnPath)).rejects.toMatchObject({
        code: 'invalid_installation',
      });
    },
  );

  it('R-onb-11: retains Settings through a cold GitHub installation callback', async () => {
    await persistGitHubInstallationReturnPath('/beeline/settings/identity');
    expect(await githubInstallationReturnPath()).toBe('/beeline/settings/identity');
    await expect(resumeInitialGitHubInstallation(async () =>
      'beeline://beeline/github-installation?installed=1')).resolves.toBe(true);
    expect(await githubInstallationReturnPath()).toBeNull();
  });

  it('R-onb-11: explains that a GitHub account already belongs to another identity', async () => {
    await expect(runGitHubInstallationSession({returnPath:'/beeline/settings/identity',
      startInstallation:async()=>'https://github.com/apps/beeline/installations/new',
      openAuthSession:async()=>({type:'success',url:'beeline://beeline/github-installation?installed=0&error=github_account_already_linked'}),
      subscribeToUrls:()=>({remove(){}}),
    })).rejects.toMatchObject({code:'github_account_already_linked',
      message:'This GitHub account is linked to a different Beeline account. Sign in with that account, or connect another GitHub account.'});
  });

  it.each(['cancel', 'dismiss'])('keeps the web Room path when the opener reports %s before its landing tab finishes', async (type) => {
    createURL.mockImplementationOnce((path) => `https://web.usebeeline.app/${path}`);
    await expect(runGitHubInstallationSession({
      returnPath: '/beeline/chat/room-1',
      startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
      openAuthSession: async () => ({ type }),
      subscribeToUrls: () => ({ remove: () => undefined }),
      callbackGraceMs: 0,
    })).rejects.toMatchObject({ code: 'browser_canceled' });
    await expect(githubInstallationReturnPath()).resolves.toBe('/beeline/chat/room-1');
  });

  it('acknowledges a successful web landing without any pending installation key', async () => {
    storage.clear();
    createURL.mockImplementationOnce((path) => `https://web.usebeeline.app/${path}`);
    createURL.mockImplementationOnce((path) => `https://web.usebeeline.app/${path}`);
    await expect(completeGitHubInstallationRoute('1')).resolves.toBeUndefined();
    expect(storage.size).toBe(0);
  });

  it('continues to require pending state for native installation completion', async () => {
    storage.clear();
    await expect(completeGitHubInstallationRoute('1')).rejects.toMatchObject({ code: 'invalid_installation' });
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
    await expect(session).resolves.toBeNull();
    finishBrowser?.({ type: 'dismiss' });
    expect(phases).toContain('refreshed');
    expect(refreshRepositories).toHaveBeenCalledTimes(1);
    expect(await githubInstallationReturnPath()).toBe('/beeline/channels');
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

it('retains reconnect intent across callback recovery and clears it with the one-use state', async () => {
  await persistGitHubSignInState(STATE, 'reconnect');
  expect(await isPendingGitHubReconnect()).toBe(true);
  await resumeInitialGitHubSignIn(async () => bindCallback());
  expect(await isPendingGitHubReconnect()).toBe(true);
  await clearPendingGitHubSignInState();
  expect(await isPendingGitHubReconnect()).toBe(false);
  await persistGitHubSignInState(STATE);
  expect(await isPendingGitHubReconnect()).toBe(false);
});


it('F11: duplicate cold callback adapters join one correlated GitHub recovery inspection', async () => {
  storage.clear(); await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  try {
    const url = `beeline://beeline/github-callback?state=${STATE}&completed=1`;
    const first = resumeInitialGitHubSignIn(async () => url);
    const second = resumeInitialGitHubSignIn(async () => url);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    finish(recoveryResponse());
    expect(await first).toEqual(await second);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
