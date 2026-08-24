import { generateKeypair, verifyEvent } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OIDC_BIND_KIND,
  OIDC_BIND_MARKER,
  MOBILE_APP_SCHEMES,
  OidcBindError,
  buildOidcBindEvent,
  finishOidcBind,
  recoverOidcBind,
  getAuthCapabilities,
  getGitHubRoomInstallationToken,
  getGitHubRoomEvents,
  adoptGitHubHandle,
  lookupManagedIdentity,
  lookupRecovery,
  parseOidcBindCallback,
  startGitHubBind,
  startGitHubInstallation,
  listGitHubRepositories,
  startOidcBind,
  type OidcBindChallenge,
} from './oidc-bind.js';

const StandardURL = URL;

/** The URL behavior shipped by React Native, limited to the surface this module uses. */
class ReactNativeURLFixture {
  readonly parsed: URL;

  constructor(input: string | URL, base?: string | URL) {
    const inputString = String(input);
    let rendered: string;
    if (base !== undefined && !/^https?:\/\//.test(inputString)) {
      const baseString = String(base).replace(/\/$/, '');
      const path = inputString.startsWith('/') ? inputString : `/${inputString}`;
      rendered = baseString.endsWith(path) ? baseString : `${baseString}${path}`;
    } else {
      rendered = new StandardURL(inputString).toString();
      if (!rendered.endsWith('/') && !rendered.includes('?') && !rendered.includes('#')) {
        rendered += '/';
      }
    }
    this.parsed = new StandardURL(rendered);
  }

  get protocol(): string {
    return this.parsed.protocol;
  }

  get origin(): string {
    return this.isHttp ? this.parsed.origin : '';
  }

  get hostname(): string {
    return this.isHttp ? this.parsed.hostname : '';
  }

  get host(): string {
    return this.isHttp ? this.parsed.host : '';
  }

  get pathname(): string {
    return this.isHttp ? this.parsed.pathname : '/';
  }

  get username(): string {
    return this.parsed.username;
  }

  get password(): string {
    return this.parsed.password;
  }

  get port(): string {
    return this.parsed.port;
  }

  get search(): string {
    return this.parsed.search;
  }

  get hash(): string {
    return this.parsed.hash;
  }

  get searchParams(): URLSearchParams {
    return this.parsed.searchParams;
  }

  toString(): string {
    return this.parsed.toString();
  }

  private get isHttp(): boolean {
    return this.parsed.protocol === 'http:' || this.parsed.protocol === 'https:';
  }
}

const identity = generateKeypair();
const challenge: OidcBindChallenge = {
  protocol: 1,
  kind: OIDC_BIND_KIND,
  marker: OIDC_BIND_MARKER,
  ticket: 't'.repeat(43),
  challenge: 'c'.repeat(43),
  provider: 'https://accounts.google.com',
  audience: 'mobile-client',
  subject: 'opaque-google-subject',
  community: 'workspace-one',
  issued_at: 1_800_000_000,
  expires_at: 1_800_000_120,
};

function callbackUrl(overrides: Record<string, string> = {}): string {
  const url = new URL('beeline://buzz/oidc-callback');
  const values: Record<string, string> = {
    state: 's'.repeat(43),
    protocol: String(challenge.protocol),
    kind: String(challenge.kind),
    marker: challenge.marker,
    ticket: challenge.ticket,
    challenge: challenge.challenge,
    provider: challenge.provider,
    audience: challenge.audience,
    subject: challenge.subject,
    community: challenge.community,
    issued_at: String(challenge.issued_at),
    expires_at: String(challenge.expires_at),
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

afterEach(() => vi.unstubAllGlobals());

describe('OIDC device-key bind protocol', () => {
  it.each([
    {
      provider: 'GitHub',
      start: startGitHubBind,
      redirectUri: 'beeline://buzz/github-callback',
      startPath: '/auth/github/start',
    },
    {
      provider: 'OIDC',
      start: startOidcBind,
      redirectUri: 'https://relay.example/auth/oidc/mobile-callback',
      startPath: '/auth/oidc/start',
    },
  ])(
    'starts the full $provider flow under React Native URL semantics',
    ({ start, redirectUri, startPath }) => {
      const reactNativeDeepLink = new ReactNativeURLFixture('beeline://buzz/github-callback');
      expect(reactNativeDeepLink.toString()).toBe('beeline://buzz/github-callback/');
      expect(reactNativeDeepLink).toMatchObject({ origin: '', host: '', pathname: '/' });
      expect(
        new ReactNativeURLFixture('https://relay.example/auth/oidc/mobile-callback').pathname,
      ).toBe('/auth/oidc/mobile-callback/');
      const completionUrl = callbackUrl();
      vi.stubGlobal('URL', ReactNativeURLFixture);

      const result = start('https://relay.example', {
        redirectUri,
        state: 's'.repeat(43),
      });
      const authorizationUrl = new StandardURL(result.authorizationUrl);
      expect(authorizationUrl.pathname).toBe(startPath);
      expect(authorizationUrl.searchParams.get('app_redirect')).toBe(redirectUri);
      expect(result.redirectUri).toBe(redirectUri);
      expect(parseOidcBindCallback(completionUrl, 's'.repeat(43))).toEqual(challenge);
    },
  );

  it('builds a native-only start URL with random app state', () => {
    const result = startOidcBind('https://relay.example', {
      redirectUri: 'https://relay.example/auth/oidc/mobile-callback',
      state: 's'.repeat(43),
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://relay.example/auth/oidc/start');
    expect(url.searchParams.get('app_redirect')).toBe(
      'https://relay.example/auth/oidc/mobile-callback',
    );
    expect(url.searchParams.get('app_state')).toBe('s'.repeat(43));
    expect(() =>
      startOidcBind('https://relay.example', {
        redirectUri: 'beeline://buzz/oidc-callback',
        state: 's'.repeat(43),
      }),
    ).toThrow('allowed associated link or app deep link');
    expect(
      startOidcBind('http://127.0.0.1:8789', {
        redirectUri: 'beeline://buzz/oidc-callback',
        state: 's'.repeat(43),
      }).redirectUri,
    ).toBe('beeline://buzz/oidc-callback');
  });

  it('allows one trailing slash without widening the redirect allowlist', () => {
    for (const [start, redirectUri] of [
      [startGitHubBind, 'beeline://buzz/github-callback/'],
      [startOidcBind, 'https://relay.example/auth/oidc/mobile-callback/'],
    ] as const) {
      const result = start('https://relay.example', {
        redirectUri,
        state: 's'.repeat(43),
      });
      expect(new StandardURL(result.authorizationUrl).searchParams.get('app_redirect')).toBe(
        redirectUri,
      );
      expect(result.redirectUri).toBe(redirectUri);
    }

    for (const [start, redirectUri] of [
      [startGitHubBind, 'beeline://buzz/github-callback//'],
      [startGitHubBind, 'beeline://buzz/other'],
      [startGitHubBind, 'beeline://other/github-callback'],
      [startGitHubBind, 'beeline://buzz/github-callback?next=evil'],
      [startGitHubBind, 'beeline://buzz/github-callback#evil'],
      [startOidcBind, 'https://relay.example/auth/oidc/mobile-callback//'],
      [startOidcBind, 'https://other.example/auth/oidc/mobile-callback'],
      [startOidcBind, 'https://relay.example/auth/oidc/other'],
      [startOidcBind, 'https://relay.example/auth/oidc/mobile-callback?next=evil'],
      [startOidcBind, 'https://relay.example/auth/oidc/mobile-callback#evil'],
    ] as const) {
      expect(() =>
        start('https://relay.example', { redirectUri, state: 's'.repeat(43) }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_redirect' }));
    }

    expect(() =>
      startOidcBind('http://127.0.0.1:8789', {
        redirectUri: 'beeline://user@buzz/oidc-callback',
        state: 's'.repeat(43),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_redirect' }));
  });

  it('accepts only the Beeline callback scheme', () => {
    for (const scheme of MOBILE_APP_SCHEMES) {
      const redirectUri = `${scheme}://buzz/github-callback`;
      expect(
        startGitHubBind('https://relay.example', {
          redirectUri,
          state: 's'.repeat(43),
        }).redirectUri,
      ).toBe(redirectUri);

      expect(
        startOidcBind('http://127.0.0.1:8789', {
          redirectUri: `${scheme}://buzz/oidc-callback`,
          state: 's'.repeat(43),
        }).redirectUri,
      ).toBe(`${scheme}://buzz/oidc-callback`);
    }

    for (const scheme of ['buzzy', 'buzzy-dev', 'buzzy-preview', 'buzzy-nightly', 'other']) {
      expect(() =>
        startGitHubBind('https://relay.example', {
          redirectUri: `${scheme}://buzz/github-callback`,
          state: 's'.repeat(43),
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_redirect' }));
      expect(() =>
        startOidcBind('http://127.0.0.1:8789', {
          redirectUri: `${scheme}://buzz/oidc-callback`,
          state: 's'.repeat(43),
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_redirect' }));
    }
  });

  it('uses the GitHub routes for sign-in, installation, and repository access', async () => {
    const start = startGitHubBind('https://relay.example', {
      redirectUri: 'beeline://buzz/github-callback',
      state: 's'.repeat(43),
    });
    expect(new URL(start.authorizationUrl).pathname).toBe('/auth/github/start');
    expect(new URL(start.authorizationUrl).searchParams.get('app_redirect')).toBe(
      'beeline://buzz/github-callback',
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authorization_url: 'https://github.com/apps/beeline/installations/new',
          }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installed: true,
            installations: [
              {
                installationId: 7,
                accountId: '1',
                accountLogin: 'acme',
                accountType: 'Organization',
                repositorySelection: 'selected',
                status: 'active',
                repositoryCount: 1,
                manageUrl: 'https://github.com/organizations/acme/settings/installations/7',
              },
            ],
            repositories: [
              {
                id: 42,
                installationId: 7,
                name: 'widget',
                fullName: 'acme/widget',
                remote: 'https://github.com/acme/widget.git',
                defaultBranch: 'main',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      startGitHubInstallation(
        'https://relay.example',
        identity,
        'https://relay.example/auth/github/mobile-callback',
        7,
      ),
    ).resolves.toContain('github.com/apps/beeline');
    await expect(
      listGitHubRepositories('https://relay.example', identity, { refresh: true }),
    ).resolves.toMatchObject({
      installed: true,
      installations: [{ accountLogin: 'acme', repositoryCount: 1 }],
      repositories: [{ installationId: 7, fullName: 'acme/widget' }],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      installation_id: 7,
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('refresh=1');
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Nostr /);
    }
  });

  it('strictly parses the callback and refuses missing, duplicate, or foreign state fields', () => {
    expect(parseOidcBindCallback(callbackUrl(), 's'.repeat(43))).toEqual(challenge);
    const duplicate = `${callbackUrl()}&ticket=${challenge.ticket}`;
    expect(() => parseOidcBindCallback(duplicate, 's'.repeat(43))).toThrow('duplicate ticket');
    expect(() =>
      parseOidcBindCallback(callbackUrl({ state: 'x'.repeat(43) }), 's'.repeat(43)),
    ).toThrow('state mismatch');
    const missing = new URL(callbackUrl());
    missing.searchParams.delete('subject');
    expect(() => parseOidcBindCallback(missing.toString(), 's'.repeat(43))).toThrow('missing');
  });

  it('requests a Room-scoped GitHub token without letting the daemon choose a repository', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'room-token',
          expires_at: '2030-01-01T00:00:00Z',
          installation_id: 7,
          full_name: 'acme/widget',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubRoomInstallationToken('https://relay.example', identity, 'room-1'),
    ).resolves.toMatchObject({ token: 'room-token', fullName: 'acme/widget' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      pubkey: identity.publicKey,
      room_id: 'room-1',
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).relay_authorizations,
    ).toHaveLength(16);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toMatch(
      /^Nostr /,
    );
  });

  it('sends read_only on the Room token request when a session asks for the read-only variant', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'room-token',
          expires_at: '2030-01-01T00:00:00Z',
          installation_id: 77,
          full_name: 'acme/widget',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubRoomInstallationToken('https://relay.example', identity, 'room-1', {
        readOnly: true,
      }),
    ).resolves.toMatchObject({ token: 'room-token' });
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sent.read_only).toBe(true);
  });

  it('fetches Room repository events with since/wait options and validates the response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          full_name: 'acme/widget',
          head: 3,
          cursor: 2,
          events: [
            { id: 2, type: 'star', action: 'created', actor: 'lena', summary: 'lena starred acme/widget', received_at: '2026-01-01T00:00:00Z' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGitHubRoomEvents('https://relay.example', identity, 'room-1', { since: 1, waitMs: 25_000 }),
    ).resolves.toMatchObject({ fullName: 'acme/widget', cursor: 2, events: [{ id: 2 }] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      pubkey: identity.publicKey,
      room_id: 'room-1',
      since: 1,
      wait_ms: 25_000,
    });
  });

  it('preserves a Room-events authority refusal as an OidcBindError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'room_membership_required',
            message: 'agent is not a member of this Room',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(
      getGitHubRoomEvents('https://relay.example', identity, 'room-1'),
    ).rejects.toMatchObject({ name: 'OidcBindError', code: 'room_membership_required' });
  });

  it('preserves a Room-token broker 403 as an OidcBindError for the daemon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'room_repository_unauthorized',
            message: 'agent is not authorized for this Room repository',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(
      getGitHubRoomInstallationToken('https://relay.example', identity, 'room-1'),
    ).rejects.toMatchObject({
      name: 'OidcBindError',
      code: 'room_repository_unauthorized',
      status: 403,
      retryable: false,
    });
  });

  it('surfaces callback cancellation/proof errors without constructing a challenge', () => {
    const url = new URL('beeline://buzz/oidc-callback');
    url.searchParams.set('state', 's'.repeat(43));
    url.searchParams.set('error', 'invalid_oidc_proof');
    expect(() => parseOidcBindCallback(url.toString(), 's'.repeat(43))).toThrowError(
      expect.objectContaining({ code: 'invalid_oidc_proof' }),
    );
  });

  it('signs protocol, ticket, challenge, provider identity, tenant, and exact time window', () => {
    const event = buildOidcBindEvent(challenge, identity, challenge.issued_at);
    expect(event.kind).toBe(OIDC_BIND_KIND);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([
      ['t', OIDC_BIND_MARKER],
      ['protocol', '1'],
      ['ticket', challenge.ticket],
      ['challenge', challenge.challenge],
      ['provider', challenge.provider],
      ['audience', challenge.audience],
      ['subject', challenge.subject],
      ['community', challenge.community],
      ['issued_at', String(challenge.issued_at)],
      ['expires_at', String(challenge.expires_at)],
    ]);
    expect(verifyEvent(event)).toBe(true);
    expect(JSON.stringify({ ticket: challenge.ticket, event })).not.toContain('secretKey');
  });

  it('classifies offline, expiry, and identity conflict bind failures', async () => {
    const event = buildOidcBindEvent(challenge, identity, challenge.issued_at);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Network request failed')));
    await expect(finishOidcBind('https://relay.example', challenge, event)).rejects.toMatchObject({
      code: 'offline',
      retryable: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'ticket_expired', message: 'expired' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(finishOidcBind('https://relay.example', challenge, event)).rejects.toMatchObject({
      code: 'ticket_expired',
      retryable: false,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'identity_conflict', message: 'already linked' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(finishOidcBind('https://relay.example', challenge, event)).rejects.toMatchObject({
      code: 'identity_conflict',
    });
  });

  it('uses a separate explicit request to replace a conflicting device key', async () => {
    const event = buildOidcBindEvent(challenge, identity, challenge.issued_at);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ linked: true, replaced: true, pubkey: identity.publicKey }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverOidcBind('https://relay.example', challenge, event)).resolves.toEqual({
      linked: true,
      replaced: true,
      pubkey: identity.publicKey,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://relay.example/auth/oidc/recover');
    expect(JSON.parse(String(init.body))).toMatchObject({
      ticket: challenge.ticket,
      confirm_replace: true,
      event: { pubkey: identity.publicKey },
    });
  });

  it('rejects missing or duplicate signed fields before sending the secret-free request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const event = buildOidcBindEvent(challenge, identity, challenge.issued_at);
    const duplicate = { ...event, tags: [...event.tags, ['ticket', challenge.ticket]] };
    await expect(
      finishOidcBind('https://relay.example', challenge, duplicate),
    ).rejects.toMatchObject({
      code: 'invalid_bind_event',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses fresh NIP-98 auth for private recovery lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          links: [
            {
              community: challenge.community,
              provider: challenge.provider,
              audience: challenge.audience,
              subject: challenge.subject,
              pubkey: identity.publicKey,
              created_at: '2026-08-11T00:00:00.000Z',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookupRecovery('https://relay.example', identity)).resolves.toHaveLength(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Nostr /);
    expect((init.headers as Record<string, string>).authorization).not.toContain(
      identity.secretKey,
    );
  });

  it('reads and adopts the authenticated hosted identity on the same key', async () => {
    const hosted = {
      handle: 'ada-labs',
      display_name: 'Ada',
      nip05: 'ada-labs@usebeeline.app',
      source: 'key',
      github_login: 'ada',
      github_rename_available: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ identity: hosted }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            renamed: true,
            identity: {
              ...hosted,
              handle: 'ada',
              nip05: 'ada@usebeeline.app',
              source: 'github',
              github_rename_available: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(lookupManagedIdentity('https://relay.example', identity)).resolves.toMatchObject({
      handle: 'ada-labs',
      githubLogin: 'ada',
      githubRenameAvailable: true,
    });
    await expect(adoptGitHubHandle('https://relay.example', identity)).resolves.toMatchObject({
      handle: 'ada',
      githubRenameAvailable: false,
    });

    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [renameUrl, renameInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(lookupUrl).toBe(
      `https://relay.example/auth/identity/${identity.publicKey}`,
    );
    expect(renameUrl).toBe(
      `https://relay.example/auth/identity/${identity.publicKey}/github-handle`,
    );
    expect((lookupInit.headers as Record<string, string>).authorization).toMatch(/^Nostr /);
    expect((renameInit.headers as Record<string, string>).authorization).toMatch(/^Nostr /);
    expect(JSON.parse(String(renameInit.body))).toEqual({ confirm_rename: true });
  });

  it('reads the deployed provider gate without requiring a device identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ github: false, oidc: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(getAuthCapabilities('https://relay.example')).resolves.toEqual({
      github: false,
      oidc: true,
    });
  });

  it('exposes typed protocol errors', () => {
    expect(new OidcBindError('offline', 'down')).toMatchObject({
      code: 'offline',
      retryable: true,
    });
  });
});
