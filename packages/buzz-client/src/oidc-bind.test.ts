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
  lookupManagedIdentity,
  lookupRecovery,
  parseOidcBindCallback,
  startGitHubBind,
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
  const url = new URL('beeline://beeline/oidc-callback');
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OIDC device-key bind protocol', () => {
  it('accepts the previous GitHub callback path during the app transition', () => {
    expect(
      startGitHubBind('https://relay.example', {
        redirectUri: 'beeline://buzz/github-callback',
        state: 's'.repeat(43),
      }).redirectUri,
    ).toBe('beeline://buzz/github-callback');
  });

  it('allows the Expo web GitHub callback to reach the server allowlist', () => {
    for (const redirectUri of [
      'https://web.usebeeline.app/beeline/github-callback',
      'http://127.0.0.1:8081/beeline/github-callback',
    ]) {
      expect(
        startGitHubBind('https://server.usebeeline.app', {
          redirectUri,
          state: 's'.repeat(43),
        }).redirectUri,
      ).toBe(redirectUri);
    }

    expect(() =>
      startGitHubBind('https://server.usebeeline.app', {
        redirectUri: 'https://web.usebeeline.app/other',
        state: 's'.repeat(43),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_redirect' }));
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

  it('surfaces callback cancellation/proof errors without constructing a challenge', () => {
    const url = new URL('beeline://beeline/oidc-callback');
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

  it('exposes typed protocol errors', () => {
    expect(new OidcBindError('offline', 'down')).toMatchObject({
      code: 'offline',
      retryable: true,
    });
  });
});
