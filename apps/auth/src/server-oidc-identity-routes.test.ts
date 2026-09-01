import { createHash, createHmac } from 'node:crypto';
import { generateKeypair, nip98AuthHeader, signEvent, type Keypair } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import { OIDC_BIND_KIND, OIDC_BIND_MARKER } from './protocol.js';
import {
  alphaTenant,
  app,
  betaTenant,
  bindEvent,
  bindGitHubIdentity,
  ceremony,
  githubState,
  provider,
  startCookie,
  state,
  store,
  type BindChallenge,
  useAuthServerFixture,
} from './server-test-fixture.js';

describe('OIDC and identity HTTP routes', () => {
  useAuthServerFixture();

  it('advertises GitHub only when its complete configuration is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/capabilities',
      headers: { host: alphaTenant.host },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ github: true, oidc: true });
  });

  it('exchanges a native GitHub bind ticket for a phone proof exactly once', async () => {
    const ticket = 'x'.repeat(43);
    const now = new Date();
    await store.createTicket(createHash('sha256').update(ticket).digest('hex'), {
      challenge: 'challenge', community: alphaTenant.community,
      issuer: 'https://github.com', audience: 'github-client', subject: '42',
      createdAt: now, expiresAt: new Date(now.getTime() + 60_000),
      attemptCount: 0, consumedAt: null, boundPubkey: null,
      providerLogin: 'octocat', providerDisplayName: 'The Octocat',
    });
    const first = await app.inject({ method: 'POST', url: '/auth/github/phone-exchange', headers: { host: alphaTenant.host }, payload: { ticket } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ subject: '42', login: 'octocat', name: 'The Octocat' });
    const replay = await app.inject({ method: 'POST', url: '/auth/github/phone-exchange', headers: { host: alphaTenant.host }, payload: { ticket } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: 'github_ticket_used' });
  });

  it('auto-provisions the verified GitHub handle and display name during bind', async () => {
    const identity = generateKeypair();
    const result = await bindGitHubIdentity(identity, 'i'.repeat(43));
    expect(result).toMatchObject({
      linked: true,
      pubkey: identity.publicKey,
      identity: {
        handle: 'octocat',
        display_name: 'The Octocat',
        nip05: 'octocat@usebeeline.app',
        source: 'github',
        github_login: 'octocat',
        github_rename_available: false,
      },
    });

    const resolved = await app.inject({
      method: 'GET',
      url: '/.well-known/nostr.json?name=octocat',
      headers: { host: alphaTenant.host },
    });
    expect(resolved.json()).toEqual({ names: { octocat: identity.publicKey } });
  });

  it('keeps a key-only identity in place when GitHub is linked and offers one rename', async () => {
    const identity = generateKeypair();
    const claimUrl = `${alphaTenant.origin}/nip05/claim`;
    const claimed = await app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, claimUrl, 'POST'),
      },
      payload: { name: 'local-handle' },
    });
    expect(claimed.statusCode).toBe(201);

    const linked = await bindGitHubIdentity(identity, 'j'.repeat(43));
    expect(linked).toMatchObject({
      pubkey: identity.publicKey,
      identity: {
        handle: 'local-handle',
        nip05: 'local-handle@usebeeline.app',
        github_login: 'octocat',
        github_rename_available: true,
      },
    });
    await expect(
      store.successionPredecessors(alphaTenant.community, identity.publicKey),
    ).resolves.toEqual([]);

    const renameUrl = `${alphaTenant.origin}/auth/identity/${identity.publicKey}/github-handle`;
    const renamed = await app.inject({
      method: 'POST',
      url: `/auth/identity/${identity.publicKey}/github-handle`,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, renameUrl, 'POST'),
      },
      payload: { confirm_rename: true },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      renamed: true,
      identity: { handle: 'octocat', github_rename_available: false },
    });
    const released = await app.inject({
      method: 'GET',
      url: '/.well-known/nostr.json?name=local-handle',
      headers: { host: alphaTenant.host },
    });
    expect(released.json()).toEqual({ names: {} });

    const secondAuthorization = nip98AuthHeader(
      identity.secretKey,
      identity.publicKey,
      renameUrl,
      'POST',
    );
    const second = await app.inject({
      method: 'POST',
      url: `/auth/identity/${identity.publicKey}/github-handle`,
      headers: { host: alphaTenant.host, authorization: secondAuthorization },
      payload: { confirm_rename: true },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('rename_not_available');
  });

  it('prevents key-only claims from squatting an already linked GitHub handle', async () => {
    const githubIdentity = generateKeypair();
    await bindGitHubIdentity(githubIdentity, 'k'.repeat(43));
    const keyIdentity = generateKeypair();
    const claimUrl = `${alphaTenant.origin}/nip05/claim`;
    const response = await app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          keyIdentity.secretKey,
          keyIdentity.publicKey,
          claimUrl,
          'POST',
        ),
      },
      payload: { name: 'octocat' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('name_taken');
  });

  it('gives a verified GitHub owner a handle claimed before that account was linked', async () => {
    const earlyKeyIdentity = generateKeypair();
    const claimUrl = `${alphaTenant.origin}/nip05/claim`;
    const earlyClaim = await app.inject({
      method: 'POST',
      url: '/nip05/claim',
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(
          earlyKeyIdentity.secretKey,
          earlyKeyIdentity.publicKey,
          claimUrl,
          'POST',
        ),
      },
      payload: { name: 'octocat' },
    });
    expect(earlyClaim.statusCode).toBe(201);

    const githubIdentity = generateKeypair();
    await bindGitHubIdentity(githubIdentity, 'l'.repeat(43));

    const resolved = await app.inject({
      method: 'GET',
      url: '/.well-known/nostr.json?name=octocat',
      headers: { host: alphaTenant.host },
    });
    expect(resolved.json()).toEqual({ names: { octocat: githubIdentity.publicKey } });
    await expect(
      store.managedIdentity(alphaTenant.community, earlyKeyIdentity.publicKey),
    ).resolves.toBeNull();
  });

  async function bind(
    challenge: BindChallenge,
    identity: Keypair,
    extra: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: bindEvent(challenge, identity), ...extra },
    });
  }

  async function recover(challenge: BindChallenge, identity: Keypair, confirmReplace: unknown) {
    return app.inject({
      method: 'POST',
      url: '/auth/oidc/recover',
      headers: { host: alphaTenant.host },
      payload: {
        ticket: challenge.ticket,
        event: bindEvent(challenge, identity),
        confirm_replace: confirmReplace,
      },
    });
  }

  it('completes code + PKCE + nonce, persists the mapping, and authenticates private lookup with NIP-98', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const result = await bind(challenge, identity);
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual({ linked: true, idempotent: false, pubkey: identity.publicKey });
    const replayedBind = await bind(challenge, identity);
    expect(replayedBind.statusCode).toBe(200);
    expect(replayedBind.json()).toEqual({
      linked: true,
      idempotent: true,
      pubkey: identity.publicKey,
    });
    expect(provider.tokenRequests).toBe(1);

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/auth/oidc/links/${identity.publicKey}`,
      headers: { host: alphaTenant.host },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const url = `${alphaTenant.origin}/auth/oidc/links/${identity.publicKey}`;
    const authorization = nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET');
    const lookup = await app.inject({
      method: 'GET',
      url: `/auth/oidc/links/${identity.publicKey}`,
      headers: { host: alphaTenant.host, authorization },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().links).toEqual([
      expect.objectContaining({
        community: alphaTenant.community,
        provider: provider.issuer,
        audience: provider.clientId,
        subject: 'google-subject-123',
        pubkey: identity.publicKey,
      }),
    ]);
    expect(lookup.body).not.toContain('email');

    const replay = await app.inject({
      method: 'GET',
      url: `/auth/oidc/links/${identity.publicKey}`,
      headers: { host: alphaTenant.host, authorization },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('replayed_auth');
  });

  it('serves the succession chain only to the successor key itself', async () => {
    const challenge = await ceremony();
    const oldKey = generateKeypair();
    const newKey = generateKeypair();
    expect((await bind(challenge, oldKey)).statusCode).toBe(201);

    await store.createTicket('f'.repeat(64), {
      challenge: 'c'.repeat(43),
      community: alphaTenant.community,
      issuer: provider.issuer,
      audience: provider.clientId,
      subject: 'google-subject-123',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      attemptCount: 0,
      consumedAt: null,
      boundPubkey: null,
    });
    await store.consumeTicketAndLink('f'.repeat(64), newKey.publicKey, new Date());
    const replaced = await store.recoverConsumedTicketLink(
      'f'.repeat(64),
      newKey.publicKey,
      new Date(),
    );
    expect(['replaced', 'idempotent']).toContain(replaced.status);

    const url = `${alphaTenant.origin}/auth/oidc/predecessors/${newKey.publicKey}`;
    const unauthorized = await app.inject({
      method: 'GET',
      url,
      headers: { host: alphaTenant.host },
    });
    expect(unauthorized.statusCode).toBe(401);

    const wrongSigner = generateKeypair();
    const mismatch = await app.inject({
      method: 'GET',
      url,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(wrongSigner.secretKey, wrongSigner.publicKey, url, 'GET'),
      },
    });
    expect(mismatch.statusCode).toBe(401);

    const authorization = nip98AuthHeader(newKey.secretKey, newKey.publicKey, url, 'GET');
    const chain = await app.inject({
      method: 'GET',
      url,
      headers: { host: alphaTenant.host, authorization },
    });
    expect(chain.statusCode).toBe(200);
    expect(chain.json()).toEqual({ predecessors: [oldKey.publicKey] });

    const oldUrl = `${alphaTenant.origin}/auth/oidc/predecessors/${oldKey.publicKey}`;
    const oldChain = await app.inject({
      method: 'GET',
      url: oldUrl,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(oldKey.secretKey, oldKey.publicKey, oldUrl, 'GET'),
      },
    });
    expect(oldChain.statusCode).toBe(200);
    expect(oldChain.json()).toEqual({ predecessors: [] });

    const resolver = generateKeypair();
    const currentUrl = `${alphaTenant.origin}/auth/oidc/current/${oldKey.publicKey}`;
    const unauthenticatedCurrent = await app.inject({
      method: 'GET',
      url: currentUrl,
      headers: { host: alphaTenant.host },
    });
    expect(unauthenticatedCurrent.statusCode).toBe(401);

    const current = await app.inject({
      method: 'GET',
      url: currentUrl,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(resolver.secretKey, resolver.publicKey, currentUrl, 'GET'),
      },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ current_pubkey: newKey.publicKey });

    const unrelated = generateKeypair();
    const unrelatedUrl = `${alphaTenant.origin}/auth/oidc/current/${unrelated.publicKey}`;
    const unrelatedResolution = await app.inject({
      method: 'GET',
      url: unrelatedUrl,
      headers: {
        host: alphaTenant.host,
        authorization: nip98AuthHeader(resolver.secretKey, resolver.publicKey, unrelatedUrl, 'GET'),
      },
    });
    expect(unrelatedResolution.statusCode).toBe(200);
    expect(unrelatedResolution.json()).toEqual({ current_pubkey: unrelated.publicKey });
  });

  it('returns a native bind challenge only through an allowlisted state-bound app callback', async () => {
    const appState = 's'.repeat(43);
    const associatedRedirect = `${alphaTenant.origin}/auth/oidc/mobile-callback`;
    const start = await app.inject({
      method: 'GET',
      url: `/auth/oidc/start?app_redirect=${encodeURIComponent(associatedRedirect)}&app_state=${appState}`,
      headers: { host: alphaTenant.host },
    });
    expect(start.statusCode).toBe(302);
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const result = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(result.statusCode).toBe(302);
    const completion = new URL(result.headers.location!);
    expect(`${completion.origin}${completion.pathname}`).toBe(associatedRedirect);
    expect(completion.searchParams.get('state')).toBe(appState);
    expect(completion.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(completion.searchParams.has('code')).toBe(false);
    expect(completion.searchParams.has('id_token')).toBe(false);
  });

  it('accepts one callback slash but rejects any wider redirect variation', async () => {
    const appState = 's'.repeat(43);
    for (const [providerName, appRedirect] of [
      ['oidc', `${alphaTenant.origin}/auth/oidc/mobile-callback/`],
      ['github', 'beeline://buzz/github-callback/'],
    ] as const) {
      const result = await app.inject({
        method: 'GET',
        url: `/auth/${providerName}/start?app_redirect=${encodeURIComponent(appRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(result.statusCode).toBe(302);
    }

    for (const [providerName, appRedirect] of [
      ['oidc', `${alphaTenant.origin}/auth/oidc/mobile-callback//`],
      ['oidc', `${alphaTenant.origin}/auth/oidc/mobile-callback?next=evil`],
      ['github', 'beeline://buzz/github-callback//'],
      ['github', 'beeline://buzz/github-callback#evil'],
    ] as const) {
      const result = await app.inject({
        method: 'GET',
        url: `/auth/${providerName}/start?app_redirect=${encodeURIComponent(appRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error).toBe('invalid_request');
    }
  });

  it('allowlists only the Beeline native scheme', async () => {
    const appState = 's'.repeat(43);
    const pubkey = 'a'.repeat(64);
    for (const scheme of ['beeline']) {
      const signInRedirect = `${scheme}://buzz/github-callback`;
      const signIn = await app.inject({
        method: 'GET',
        url: `/auth/github/start?app_redirect=${encodeURIComponent(signInRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(signIn.statusCode, signInRedirect).toBe(302);

      const installationRedirect = `${scheme}://buzz/github-installation`;
      const installation = await app.inject({
        method: 'POST',
        url: '/auth/github/install/start',
        headers: { host: alphaTenant.host },
        payload: { pubkey, redirect_uri: installationRedirect },
      });
      expect(installation.statusCode, installationRedirect).toBe(401);

      const oidcRedirect = `${scheme}://buzz/oidc-callback`;
      const oidc = await app.inject({
        method: 'GET',
        url: `/auth/oidc/start?app_redirect=${encodeURIComponent(oidcRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(oidc.statusCode, oidcRedirect).toBe(302);
    }

    for (const scheme of ['buzzy', 'buzzy-dev', 'buzzy-preview', 'buzzy-nightly', 'other']) {
      for (const path of ['github-callback', 'github-installation']) {
        const redirectUri = `${scheme}://buzz/${path}`;
        const result =
          path === 'github-callback'
            ? await app.inject({
                method: 'GET',
                url: `/auth/github/start?app_redirect=${encodeURIComponent(redirectUri)}&app_state=${appState}`,
                headers: { host: alphaTenant.host },
              })
            : await app.inject({
                method: 'POST',
                url: '/auth/github/install/start',
                headers: { host: alphaTenant.host },
                payload: { pubkey, redirect_uri: redirectUri },
              });
        expect(result.statusCode, redirectUri).toBe(400);
      }

      const oidcRedirect = `${scheme}://buzz/oidc-callback`;
      const oidc = await app.inject({
        method: 'GET',
        url: `/auth/oidc/start?app_redirect=${encodeURIComponent(oidcRedirect)}&app_state=${appState}`,
        headers: { host: alphaTenant.host },
      });
      expect(oidc.statusCode, oidcRedirect).toBe(400);
    }
  });

  it('refuses arbitrary native completion redirects', async () => {
    const result = await app.inject({
      method: 'GET',
      url: `/auth/oidc/start?app_redirect=${encodeURIComponent('https://attacker.example/callback')}&app_state=${'s'.repeat(43)}`,
      headers: { host: alphaTenant.host },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toBe('invalid_request');
  });

  it('cannot replay the OAuth proof to mint another bind ticket and exposes no bearer-token verify endpoint', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const callbackUrl = `${callback.pathname}${callback.search}`;
    const first = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_oidc_flow');
    expect(provider.tokenRequests).toBe(1);

    const bearerPocPath = await app.inject({
      method: 'POST',
      url: '/auth/oidc/verify',
      headers: { host: alphaTenant.host },
      payload: { id_token: first.json<BindChallenge>().ticket },
    });
    expect(bearerPocPath.statusCode).toBe(404);
  });

  it('binds the callback to the browser session that initiated the flow', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const callbackUrl = `${callback.pathname}${callback.search}`;
    const intercepted = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host },
    });
    expect(intercepted.statusCode).toBe(400);
    expect(intercepted.json().error).toBe('invalid_oidc_flow');
    expect(provider.tokenRequests).toBe(0);

    const owningBrowser = await app.inject({
      method: 'GET',
      url: callbackUrl,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(owningBrowser.statusCode).toBe(200);
    expect(provider.tokenRequests).toBe(1);
  });

  it('does not expose OIDC authorization paths for relay, membership, roles, or merge', async () => {
    for (const url of ['/events', '/query', '/membership', '/roles', '/merge']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { host: alphaTenant.host, authorization: 'Bearer reusable-id-token' },
        payload: {},
      });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('rejects a tampered bind signature without consuming the ticket', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const event = bindEvent(challenge, identity);
    const tampered = { ...event, content: 'tampered after signing' };
    const rejected = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: tampered },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('invalid_bind_event');
    expect((await bind(challenge, identity)).statusCode).toBe(201);
  });

  it('durably burns a ticket after five invalid signed-event attempts', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const event = bindEvent(challenge, identity);
    const invalid = signEvent(
      {
        ...event,
        tags: event.tags.map((tag) =>
          tag[0] === 'challenge' ? ['challenge', 'wrong-challenge'] : tag,
        ),
      },
      identity.secretKey,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/oidc/bind',
        headers: { host: alphaTenant.host },
        payload: { ticket: challenge.ticket, event: invalid },
      });
      expect(response.statusCode).toBe(400);
    }
    const burned = await bind(challenge, identity);
    expect(burned.statusCode).toBe(409);
    expect(burned.json().error).toBe('ticket_used');
  });

  it.each([
    ['empty subject', { subject: '' }],
    ['wrong issuer', { issuer: 'http://wrong-issuer.invalid' }],
    ['wrong audience', { audience: 'another-client' }],
    ['multi-audience without azp', { audience: ['beeline-test-client', 'another-client'] }],
    [
      'multi-audience with wrong azp',
      { audience: ['beeline-test-client', 'another-client'], authorizedParty: 'another-client' },
    ],
  ])('rejects %s ID tokens', async (_name, claims) => {
    provider.claims = claims;
    const start = await app.inject({
      method: 'GET',
      url: '/auth/oidc/start',
      headers: { host: alphaTenant.host },
    });
    const cookie = startCookie(start.headers['set-cookie']);
    const authorization = await fetch(start.headers.location!, { redirect: 'manual' });
    const callback = new URL(authorization.headers.get('location')!);
    const result = await app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { host: alphaTenant.host, cookie },
    });
    expect(result.statusCode).toBe(401);
    expect(result.json().error).toBe('invalid_oidc_proof');
  });

  it('ignores a body-supplied community and uses the resolved Host tenant', async () => {
    const challenge = await ceremony(alphaTenant);
    const identity = generateKeypair();
    const result = await bind(challenge, identity, { community: betaTenant.community });
    expect(result.statusCode).toBe(201);

    const alphaLinks = await store.linksForPubkey(alphaTenant.community, identity.publicKey);
    const betaLinks = await store.linksForPubkey(betaTenant.community, identity.publicKey);
    expect(alphaLinks).toHaveLength(1);
    expect(betaLinks).toHaveLength(0);
  });

  it('atomically rejects a normal-login takeover while preserving the original public key', async () => {
    const original = generateKeypair();
    expect((await bind(await ceremony(), original)).statusCode).toBe(201);

    const attacker = generateKeypair();
    const conflict = await bind(await ceremony(), attacker);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'identity_conflict',
      message: 'identity is already bound to another public key',
    });
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(1);
    expect(await store.linksForPubkey(alphaTenant.community, attacker.publicKey)).toHaveLength(0);
  });

  it('requires a separate explicit confirmation before OAuth can replace a device key', async () => {
    const original = generateKeypair();
    const originalChallenge = await ceremony();
    expect((await bind(originalChallenge, original)).statusCode).toBe(201);

    const replacement = generateKeypair();
    const recoveryChallenge = await ceremony();
    const conflict = await bind(recoveryChallenge, replacement);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('identity_conflict');
    const replayedConflict = await bind(recoveryChallenge, replacement);
    expect(replayedConflict.statusCode).toBe(409);
    expect(replayedConflict.json().error).toBe('identity_conflict');

    const wrongKey = generateKeypair();
    const wrongKeyRecovery = await recover(recoveryChallenge, wrongKey, true);
    expect(wrongKeyRecovery.statusCode).toBe(409);
    expect(wrongKeyRecovery.json().error).toBe('ticket_used');
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(1);
    expect(await store.linksForPubkey(alphaTenant.community, wrongKey.publicKey)).toHaveLength(0);

    const unconfirmed = await recover(recoveryChallenge, replacement, false);
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe('recovery_confirmation_required');
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(1);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      0,
    );

    const confirmed = await recover(recoveryChallenge, replacement, true);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({
      linked: true,
      replaced: true,
      pubkey: replacement.publicKey,
    });
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(0);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      1,
    );

    const staleSuccessfulTicket = await recover(originalChallenge, original, true);
    expect(staleSuccessfulTicket.statusCode).toBe(409);
    expect(staleSuccessfulTicket.json().error).toBe('recovery_not_available');
    expect(await store.linksForPubkey(alphaTenant.community, original.publicKey)).toHaveLength(0);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      1,
    );

    const laterAttacker = generateKeypair();
    const laterConflict = await bind(await ceremony(), laterAttacker);
    expect(laterConflict.statusCode).toBe(409);
    expect(await store.linksForPubkey(alphaTenant.community, replacement.publicKey)).toHaveLength(
      1,
    );
    expect(await store.linksForPubkey(alphaTenant.community, laterAttacker.publicKey)).toHaveLength(
      0,
    );
  });

  it('allows exactly one winner when different keys race first bind', async () => {
    const firstChallenge = await ceremony();
    const secondChallenge = await ceremony();
    const firstKey = generateKeypair();
    const secondKey = generateKeypair();
    const responses = await Promise.all([
      bind(firstChallenge, firstKey),
      bind(secondChallenge, secondKey),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const linkedPubkeys = (
      await Promise.all([
        store.linksForPubkey(alphaTenant.community, firstKey.publicKey),
        store.linksForPubkey(alphaTenant.community, secondKey.publicKey),
      ])
    )
      .flat()
      .map((link) => link.pubkey);
    expect(linkedPubkeys).toHaveLength(1);
  });

  it('rejects duplicate or mismatched signed identity tags', async () => {
    const challenge = await ceremony();
    const identity = generateKeypair();
    const valid = bindEvent(challenge, identity);
    const duplicate = signEvent(
      { ...valid, tags: [...valid.tags, ['community', challenge.community]] },
      identity.secretKey,
    );
    const duplicateResponse = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: duplicate },
    });
    expect(duplicateResponse.statusCode).toBe(400);

    const wrongProvider = signEvent(
      {
        ...valid,
        tags: valid.tags.map((tag) =>
          tag[0] === 'provider' ? ['provider', 'https://evil.invalid'] : tag,
        ),
      },
      identity.secretKey,
    );
    const mismatchResponse = await app.inject({
      method: 'POST',
      url: '/auth/oidc/bind',
      headers: { host: alphaTenant.host },
      payload: { ticket: challenge.ticket, event: wrongProvider },
    });
    expect(mismatchResponse.statusCode).toBe(400);
  });
});
