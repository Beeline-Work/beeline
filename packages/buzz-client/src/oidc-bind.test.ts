import { generateKeypair, verifyEvent } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OIDC_BIND_KIND,
  OIDC_BIND_MARKER,
  OidcBindError,
  buildOidcBindEvent,
  finishOidcBind,
  getAuthCapabilities,
  lookupRecovery,
  parseOidcBindCallback,
  startGitHubBind,
  startGitHubInstallation,
  listGitHubRepositories,
  startOidcBind,
  type OidcBindChallenge,
} from './oidc-bind.js';

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
  const url = new URL('buzzy://buzz/oidc-callback');
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
        redirectUri: 'buzzy://buzz/oidc-callback',
        state: 's'.repeat(43),
      }),
    ).toThrow('emulator-only');
    expect(
      startOidcBind('http://127.0.0.1:8789', {
        redirectUri: 'buzzy://buzz/oidc-callback',
        state: 's'.repeat(43),
      }).redirectUri,
    ).toBe('buzzy://buzz/oidc-callback');
  });

  it('uses the GitHub routes for sign-in, installation, and repository access', async () => {
    const start = startGitHubBind('https://relay.example', {
      redirectUri: 'https://relay.example/auth/github/mobile-callback',
      state: 's'.repeat(43),
    });
    expect(new URL(start.authorizationUrl).pathname).toBe('/auth/github/start');
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
      ),
    ).resolves.toContain('github.com/apps/beeline');
    await expect(listGitHubRepositories('https://relay.example', identity)).resolves.toMatchObject({
      installed: true,
      repositories: [{ installationId: 7, fullName: 'acme/widget' }],
    });
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

  it('surfaces callback cancellation/proof errors without constructing a challenge', () => {
    const url = new URL('buzzy://buzz/oidc-callback');
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
